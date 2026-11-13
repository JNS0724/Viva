import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAgentEvents } from '../src/renderer/agent-events.ts'
import { decodeAgentEvent, decodeInfo, EVENT_TAGS, type EventIssue } from '../src/renderer/agent-event-decoder.ts'
import { createEventActions } from '../src/renderer/agent-event-actions.ts'
import type { AgentEvent } from '../src/renderer/agent-event-types.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createPermissionBroker } from '../src/backend/permission-broker.ts'
import { createTaskRuntime } from '../src/backend/task-runtime.ts'
import { createTaskStore } from '../src/backend/task-store.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import type { KeptTask } from '../src/shared/ipc-results.ts'

const context = { conversationId: 'c', sessionId: 's' }
const info: AgentInfo = { mode: 'live', model: 'fixture', cwd: '/w', ...context, remembersHistory: true }
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text } })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function harness() {
  let state: State = initialState, hold = (_event: AgentEvent) => false
  const actions: Action[] = [], effects: string[] = [], issues: EventIssue[] = []
  let events!: ReturnType<typeof createAgentEvents>
  const dispatch = (action: Action) => { actions.push(action); state = reduce(state, action); events.stateChanged() }
  events = createAgentEvents({
    getState: () => state, dispatch, holdTask: event => hold(event), now: () => 100,
    afterTurn: () => { effects.push('after-turn') }, clearAfterTurn: () => { effects.push('clear') },
    ready: () => { effects.push('ready') }, refreshWorkDir: () => { effects.push('directory') }, refreshFiles: () => { effects.push('files') },
    refreshFeed: () => { effects.push('feed') }, memoryChanged: () => { effects.push('memory') }, filesChanged: () => { effects.push('file-changed') },
    rejected: issue => { issues.push(issue) },
  })
  return { events, actions, effects, issues, dispatch, state: () => state, hold: (next: typeof hold) => { hold = next } }
}

test('production ingress buffers bootstrap, preserves omitted config fields and keeps accepting the same context', async () => {
  const h = harness()
  h.events.receive({ type: 'ready', info })
  h.events.receive({ type: 'turn_started', context, by: 'task' })
  h.events.receive({ type: 'update', context, update: chunk('during initialization') })
  assert.deepEqual(h.state().messages, [])
  h.events.initialize(); await flush()
  h.events.receive({ type: 'config', context, info: { mode: 'live', model: 'new choice', cwd: '/w', sessionId: 's' } })
  assert.equal(h.state().info.conversationId, 'c')
  assert.equal(h.state().info.remembersHistory, true)
  h.events.receive({ type: 'update', context, update: chunk(' + after config') })
  h.events.receive({ type: 'turn_end', context, stopReason: 'end_turn' })
  assert.deepEqual(h.state().messages.map(message => message.text), ['during initialization + after config'])
  assert.equal(h.state().phase, 'idle')
  assert.deepEqual(h.effects, ['ready', 'directory', 'files', 'after-turn'])
  assert.deepEqual(h.issues, [])
  assert.deepEqual(decodeInfo({ mode: 'setup', model: '', cwd: '', sessionId: null }), { mode: 'setup', model: '', cwd: '', sessionId: null })
})

test('SDK null permission fields and broker waits retain their known tool fallback through the real entry', () => {
  const h = harness(), broker = createPermissionBroker()
  h.events.receive({ type: 'ready', info }); h.events.initialize()
  h.events.receive({ type: 'update', context, update: { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'write', kind: 'edit', status: 'in_progress', rawInput: { path: '/w/notes.md' } } })
  const request = { sessionId: 's', toolCall: { toolCallId: 'tool', title: null, kind: null }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' as const }] }
  const { requestId } = broker.create(request)
  h.events.receive({ type: 'permission', context, requestId, ...request })
  assert.equal(h.state().permission?.kind, 'edit')
  assert.equal(h.state().permission?.title, '写入 notes.md')
  h.events.receive({ type: 'waits', context, permissions: broker.pendingFor('s'), questions: [], secrets: [] })
  assert.equal(h.state().timeline.filter(entry => entry.kind === 'permission').length, 1)
  assert.deepEqual(h.state().permission?.rawInput, { path: '/w/notes.md' })
  broker.cancelAll()
  assert.deepEqual(h.issues, [])
})

test('real runtime snapshots and pieces hand off through loadKept, with taskSeq independent of global seq', async () => {
  const h = harness(), db = openHistoryDb({ file: ':memory:' }), storage = new DatabaseSync(':memory:')
  const current = db.create({ sessionId: 's', cwd: '/w' })
  let globalSeq = 900
  const runtime = createTaskRuntime({
    db, store: createTaskStore({ db: storage }), current: () => current, agentInfo: () => info,
    newRunId: () => 'run', timers: { later: run => run, cancel: () => {} },
    publish: event => h.events.receive({ ...event, seq: globalSeq++ }),
    agent: { startTask: async () => ({ ok: true, taskId: 'task' }), promptTask: () => {}, steerTask: () => ({ ok: true }), resumeTask: () => ({ ok: true }), cancelTask: () => {}, closeTask: () => {} },
  })
  try {
    let finish!: (list: KeptTask[]) => void
    const read = new Promise<KeptTask[]>(resolve => { finish = resolve })
    const tasks = createTaskActions({
      api: { finishedTasks: () => read, answerQuestion: async () => false, stopTask: async () => {}, closeTask: async () => {} },
      getState: h.state, dispatch: h.dispatch, deliver: h.events.replay, showToast: () => {}, errorMessage: String,
    })
    h.hold(tasks.hold); h.events.initialize()
    const loading = tasks.loadKept()
    await runtime.agent.start('job')
    runtime.dsh.receive({ type: 'task_update', taskId: 'task', update: chunk('one') })
    const baseline = await runtime.window.finished()
    runtime.dsh.receive({ type: 'task_update', taskId: 'task', update: chunk(' two') })
    runtime.dsh.receive({ type: 'permission', taskId: 'task', requestId: 'p', toolCall: { toolCallId: 'tool', title: null, kind: null }, options: [] })
    runtime.dsh.receive({ type: 'task_permission_closed', taskId: 'task', requestId: 'p' })
    runtime.dsh.receive({ type: 'task_end', taskId: 'task', stopReason: 'end_turn' })
    assert.deepEqual(h.state().tasks.list, [])
    finish(baseline); await loading
    const [task] = h.state().tasks.list
    assert.equal(task.status, 'done')
    assert.equal(task.seq, 5)
    assert.deepEqual(task.view.messages.map(message => message.text), ['job', 'one two'])
    assert.equal(task.view.permission, null)
    assert.equal(task.view.timeline.some(entry => entry.kind === 'decision'), false)
    assert.equal(h.state().messages.length, 0)
    assert.equal(h.effects.filter(effect => effect === 'files').length, 1)
    assert.deepEqual(h.issues, [])
  } finally { runtime.dsh.gone(); runtime.dsh.flush(); db.close(); storage.close() }
})

test('unknown and malformed frames never reach reducers or trigger files/feed effects, and diagnostics omit payloads', () => {
  const h = harness(); h.events.receive({ type: 'ready', info }); h.events.initialize()
  const before = h.actions.length, effects = [...h.effects]
  for (const value of [null, 'SECRET_TOKEN', { type: 'SECRET_TOKEN', text: 'SECRET_TOKEN' }, { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } } },
    { type: 'task_end', taskId: 'task', seq: 999 }, { type: 'files_changed', path: {} },
    { type: 'schedule_propose', context, proposal: { proposalId: 'p', title: 'x', prompt: 'x', firstAt: 'now', rule: { kind: 'weekly', weekly: { time: '09:00', weekdays: 'bad' } } } }]) h.events.receive(value)
  assert.equal(h.actions.length, before); assert.deepEqual(h.effects, effects)
  assert.equal(h.issues.length, 7)
  assert.equal(JSON.stringify(h.issues).includes('SECRET_TOKEN'), false)
  assert.ok(h.issues.every(issue => Object.keys(issue).sort().join(',') === 'reason,tag'))
})

const snapshot = { taskId: 't', runId: 'r', title: 'job', status: 'running', currentAction: null, waitingFor: null, startedAt: 1, updatedAt: 1, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0 }
const position = { taskId: 't', runId: 'r', taskSeq: 1 }, permission = { requestId: 'p', toolCall: { toolCallId: 'tool' }, options: [] }, question = { questionId: 'q', questions: [{ id: 'city', question: 'City?', options: [] }] }, secret = { requestId: 'secret', server: 'service', names: ['TOKEN'] }
const examples = {
  ready: { type: 'ready', info }, workdir: { type: 'workdir', info }, config: { type: 'config', info }, update: { type: 'update', context, update: chunk('answer') },
  turn_started: { type: 'turn_started', context }, turn_end: { type: 'turn_end', context }, permission: { type: 'permission', context, ...permission },
  question: { type: 'question', context, ...question }, question_closed: { type: 'question_closed', context, questionId: 'q' },
  secret_request: { type: 'secret_request', context, ...secret }, secret_closed: { type: 'secret_closed', context, requestId: 'secret' }, waits: { type: 'waits', context, permissions: [permission], questions: [question], secrets: [secret] },
  memory_context: { type: 'memory_context', context, injected: [{ at: 1, fixed: 'profile', pushed: [{ names: ['work'], text: 'context' }] }] },
  report_delivered: { type: 'report_delivered', context, ...context, reportId: 'r', text: 'result', at: 1 }, error: { type: 'error', message: 'fixture' },
  schedule_propose: { type: 'schedule_propose', context, proposal: { proposalId: 'p', title: 'job', prompt: 'do', firstAt: '2026-11-09', rule: { kind: 'at' } } },
  mcp_status: { type: 'mcp_status', mcp: { active: ['mail'], connecting: [{ name: 'docs', reason: 'timed out' }], dropped: [] } },
  memory_changed: { type: 'memory_changed', memories: ['note'] }, files_changed: { type: 'files_changed', path: 'notes.md' }, feed_changed: { type: 'feed_changed' }, schedules_changed: { type: 'schedules_changed' }, sources_changed: { type: 'sources_changed' },
  task_snapshot: { type: 'task_snapshot', snapshot }, task_update: { type: 'task_update', ...position, update: chunk('answer') }, task_permission_closed: { type: 'task_permission_closed', ...position, requestId: 'p' },
  task_question: { type: 'task_question', ...position, ...question }, task_question_closed: { type: 'task_question_closed', ...position, questionId: 'q' }, task_steered: { type: 'task_steered', ...position, text: 'more' }, task_end: { type: 'task_end', ...position, stopReason: 'end_turn' },
} satisfies Record<AgentEvent['type'], unknown>

test('every supported wire tag has a valid production decode and exhaustive action/effect route', () => {
  assert.deepEqual(Object.keys(examples).sort(), Object.keys(EVENT_TAGS).sort())
  const map = createEventActions()
  for (const [tag, input] of Object.entries(examples)) {
    const event = decodeAgentEvent(input); assert.ok(event, tag)
    const action = map(event, 20)
    assert.equal(Boolean(action), !['memory_changed', 'files_changed', 'feed_changed', 'schedules_changed', 'sources_changed'].includes(tag), tag)
  }
})
