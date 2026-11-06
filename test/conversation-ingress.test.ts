import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConversationIngress } from '../src/renderer/conversation-ingress.ts'
import { createEventActions, type EventEnvelope } from '../src/renderer/agent-event-actions.ts'
import { createNewTopicAction } from '../src/renderer/new-topic-actions.ts'
import { createRewindActions } from '../src/renderer/rewind-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { ConversationContext } from '../src/shared/conversation-context.ts'

const old = { conversationId: 'c-old', sessionId: 's-old' }
const next = { conversationId: 'c-new', sessionId: 's-new' }
const info = (context: ConversationContext): AgentInfo => ({ mode: 'live', model: 'local', cwd: '/w', ...context, conversationId: context.conversationId ?? undefined })
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(now: () => number = () => 100) {
  let state: State = { ...initialState, info: info(old), conversationId: old.conversationId }
  let onDeliver = (_event: EventEnvelope) => {}
  const seen: string[] = [], map = createEventActions({ now: () => 100 })
  let ingress!: ReturnType<typeof createConversationIngress<EventEnvelope>>
  const dispatch = (action: Action) => { state = reduce(state, action); ingress.stateChanged() }
  ingress = createConversationIngress<EventEnvelope>({
    now,
    current: () => ({
      pending: state.newTopicPending || state.switching || state.workDir.switching || state.rewind.busy || state.settings.busy,
      context: { conversationId: state.conversationId ?? state.info.conversationId ?? null, sessionId: state.info.sessionId ?? null },
    }),
    deliver: (event, receivedAt) => {
      seen.push(event.type ?? 'unknown')
      const action = map(event, receivedAt)
      if (action) dispatch(action)
      onDeliver(event)
    },
  })
  const begin = (open: () => Promise<AgentInfo>) => createNewTopicAction({
    getState: () => state, dispatch, open, focus: () => {}, jump: () => {}, toast: () => {}, errorMessage: String,
  })()
  return { ingress, dispatch, begin, seen, state: () => state, onDeliver: (run: typeof onDeliver) => { onDeliver = run } }
}

test('boot subscription holds live foreground pushes until history and current info establish the baseline', async () => {
  let state: State = initialState
  const map = createEventActions(), seen: string[] = []
  const ingress = createConversationIngress<EventEnvelope>({
    initialized: false,
    current: () => ({ pending: false, context: { conversationId: state.conversationId ?? state.info.conversationId ?? null, sessionId: state.info.sessionId ?? null } }),
    deliver: event => { seen.push(event.type!); const action = map(event); if (action) state = reduce(state, action) },
  })
  ingress.receive({ type: 'turn_started', by: 'task', context: next })
  ingress.receive({ type: 'report_delivered', ...next, reportId: 'during-boot', text: 'result', at: 80, context: next })
  ingress.receive({ type: 'update', update: chunk('during boot'), context: next })
  ingress.receive({ type: 'turn_end', stopReason: 'end_turn', context: next })
  ingress.receive({ type: 'ready', info: info(next) })
  ingress.stateChanged(); await flush()
  assert.deepEqual(seen, ['ready'])
  state = reduce(state, { type: 'history_loaded', conversations: [] })
  state = reduce(state, { type: 'ready', info: info(next) })
  ingress.initialize(); await flush()
  assert.deepEqual(state.messages.map(message => message.text), ['during boot'])
  assert.deepEqual(state.records.map(record => record.reportId), ['during-boot'])
  assert.equal(state.phase, 'idle')
})

test('offline directory selection commits its new segment before a later readiness and foreground answer', () => {
  const h = harness(), offline = { ...info(next), mode: 'setup', sessionId: null }
  h.dispatch({ type: 'workdir_switching' })
  h.ingress.receive({ type: 'workdir', info: offline })
  h.dispatch({ type: 'workdir_loaded', view: { current: '/other', defaultDir: '/w', isDefault: false, recent: [] } })
  h.ingress.receive({ type: 'ready', info: info(next) })
  h.ingress.receive({ type: 'update', update: chunk('connected in selected folder'), context: next })
  h.ingress.receive({ type: 'turn_end', stopReason: 'end_turn', context: next })
  assert.equal(h.state().conversationId, next.conversationId)
  assert.deepEqual(h.state().messages.map(message => message.text), ['connected in selected folder'])
  assert.equal(h.state().phase, 'idle')
})

test('new-session reports arriving before the RPC response replay once through the production mapper and reducer', async () => {
  const h = harness(), gate = deferred<AgentInfo>(), pending = h.begin(() => gate.promise)
  h.ingress.receive({ type: 'turn_started', by: 'task', context: next })
  h.ingress.receive({ type: 'report_delivered', ...next, reportId: 'report-1', text: 'task result', at: 90, context: next })
  h.ingress.receive({ type: 'update', update: chunk('complete answer'), context: next })
  h.ingress.receive({ type: 'turn_end', stopReason: 'end_turn', context: next })
  await flush()
  assert.deepEqual(h.state().messages, []); assert.deepEqual(h.seen, [])
  gate.resolve(info(next)); await pending; await flush()
  assert.equal(h.state().conversationId, next.conversationId)
  assert.equal(h.state().phase, 'idle')
  assert.deepEqual(h.state().messages.map(message => [message.role, message.text]), [['assistant', 'complete answer']])
  assert.deepEqual(h.state().records.map(record => record.reportId), ['report-1'])
  assert.deepEqual(h.seen, ['turn_started', 'report_delivered', 'update', 'turn_end'])
  h.ingress.receive({ type: 'report_delivered', ...next, reportId: 'report-1', text: 'task result', at: 90, context: next })
  assert.equal(h.state().records.length, 1)
})

test('same-session old-segment updates, waits, closes and turn errors cannot affect the committed topic', async () => {
  const h = harness(), target = { ...next, sessionId: old.sessionId }, gate = deferred<AgentInfo>()
  const pending = h.begin(() => gate.promise)
  h.ingress.receive({ type: 'update', update: chunk('old'), context: old })
  h.ingress.receive({ type: 'waits', permissions: [{ requestId: 'old-permission', toolCall: {}, options: [] }], context: old })
  h.ingress.receive({ type: 'question', questionId: 'q', questions: [{ id: 'city', question: 'City?', options: [] }], context: target })
  h.ingress.receive({ type: 'question_closed', questionId: 'q', context: old })
  h.ingress.receive({ type: 'secret_request', requestId: 'key', server: 'test', names: ['TOKEN'], context: target })
  h.ingress.receive({ type: 'secret_closed', requestId: 'key', context: old })
  h.ingress.receive({ type: 'error', message: 'old failure', context: old })
  gate.resolve(info(target)); await pending; await flush()
  assert.equal(h.state().question?.questionId, 'q')
  assert.equal(h.state().secret?.requestId, 'key')
  assert.equal(h.state().permission, null)
  assert.equal(h.state().error, null)
  assert.deepEqual(h.state().messages, [])
})

test('failed preparation and a ready reconnect do not open the pending latch; retry drains only its own context', async () => {
  const h = harness(), failed = deferred<AgentInfo>(), pending = h.begin(() => failed.promise)
  h.ingress.receive({ type: 'update', update: chunk('failed attempt'), context: next })
  failed.reject(new Error('not ready')); await pending
  h.ingress.receive({ type: 'ready', info: info(next) })
  await flush(); assert.equal(h.state().newTopicPending, true); assert.deepEqual(h.state().messages, [])
  const retried = { conversationId: 'c-retry', sessionId: 's-retry' }, gate = deferred<AgentInfo>()
  const retry = h.begin(() => gate.promise)
  h.ingress.receive({ type: 'update', update: chunk('retry answer'), context: retried })
  h.ingress.receive({ type: 'turn_end', stopReason: 'end_turn', context: retried })
  gate.resolve(info(retried)); await retry; await flush()
  assert.deepEqual(h.state().messages.map(message => message.text), ['retry answer'])
})

test('drain reentry keeps newly arriving end events behind already queued updates', async () => {
  const h = harness(), gate = deferred<AgentInfo>(), pending = h.begin(() => gate.promise)
  h.onDeliver(event => { if (event.type === 'update' && h.state().messages.at(-1)?.text === 'one') h.ingress.receive({ type: 'turn_end', stopReason: 'end_turn', context: next }) })
  h.ingress.receive({ type: 'update', update: chunk('one'), context: next })
  h.ingress.receive({ type: 'update', update: chunk('two'), context: next })
  gate.resolve(info(next)); await pending; await flush()
  assert.deepEqual(h.seen, ['update', 'update', 'turn_end'])
  assert.equal(h.state().messages.at(-1)?.text, 'onetwo')
  assert.equal(h.state().messages.at(-1)?.open, false)
  assert.equal(h.state().phase, 'idle')
})

test('session-wide config may lack a segment, while content may not use null as a wildcard', async () => {
  const h = harness(), gate = deferred<AgentInfo>(), pending = h.begin(() => gate.promise)
  const context = { conversationId: null, sessionId: next.sessionId }
  h.ingress.receive({ type: 'config', info: { model: 'chosen' }, context })
  h.ingress.receive({ type: 'update', update: chunk('unattributed'), context })
  gate.resolve(info(next)); await pending; await flush()
  assert.equal(h.state().info.model, 'chosen'); assert.deepEqual(h.state().messages, [])
})

test('background permissions and their closures remain live during foreground preparation', async () => {
  const h = harness(), gate = deferred<AgentInfo>(), pending = h.begin(() => gate.promise)
  h.ingress.receive({ type: 'task_snapshot', snapshot: {
    taskId: 'task-1', runId: 'run-1', title: 'task', status: 'running', currentAction: null, waitingFor: null,
    startedAt: 1, updatedAt: 1, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0,
    opening: { words: 'do work', task: { id: 'task-1', segmentId: 'segment-1', title: 'task', words: 'do work' } },
  } })
  h.ingress.receive({ type: 'permission', taskId: 'task-1', runId: 'run-1', taskSeq: 1, requestId: 'p', toolCall: { title: 'read' }, options: [] })
  assert.equal(h.state().tasks.list[0]?.permission?.requestId, 'p')
  h.ingress.receive({ type: 'task_permission_closed', taskId: 'task-1', runId: 'wrong', taskSeq: 2, requestId: 'p' })
  assert.equal(h.state().tasks.list[0]?.permission?.requestId, 'p')
  h.ingress.receive({ type: 'task_permission_closed', taskId: 'task-1', runId: 'run-1', taskSeq: 2, requestId: 'p' })
  assert.equal(h.state().tasks.list[0]?.permission, null)
  assert.equal(h.state().newTopicPending, true)
  gate.resolve(info(next)); await pending; await flush()
  h.ingress.receive({ type: 'permission', requestId: 'p', toolCall: { title: 'foreground' }, options: [], context: next })
  h.ingress.receive({ type: 'permission', taskId: 'task-1', runId: 'run-1', taskSeq: 3, requestId: 'p', toolCall: { title: 'task' }, options: [] })
  h.ingress.receive({ type: 'task_permission_closed', taskId: 'task-1', runId: 'run-1', taskSeq: 4, requestId: 'p' })
  assert.equal(h.state().permission?.requestId, 'p')
  assert.equal(h.state().tasks.list[0]?.permission, null)
  assert.equal(h.state().tasks.list[0]?.view.timeline.some((entry: { kind: string }) => entry.kind === 'decision'), false)
  assert.equal(h.state().tasks.list[0]?.permission, null)
})

test('rewind observes a queued report turn before choosing how to send the rewritten question', async () => {
  const h = harness(), gate = deferred<unknown>()
  h.dispatch({ type: 'user_prompt', text: 'old words', at: 1 })
  h.dispatch({ type: 'turn_end', stopReason: 'end_turn', at: 2 })
  let askedPhase = ''
  const actions = createRewindActions({
    getState: h.state, dispatch: h.dispatch, showToast: () => {}, errorMessage: String,
    ask: () => { askedPhase = h.state().phase; return true },
    api: { rewind: () => gate.promise, rewindEffects: async () => ({ files: [], commands: [] }), foldedPath: async () => ({}), switchPath: async () => ({}) },
  })
  const pending = actions.redoFrom('m0'); await flush()
  h.ingress.receive({ type: 'turn_started', by: 'task', context: next })
  gate.resolve({ ok: true, conversation: { id: next.conversationId, messages: [] }, info: info(next), folds: [] })
  await pending; await flush()
  assert.equal(askedPhase, 'working', 'an already-running report must receive a steer, never a parallel prompt')
})

test('buffering keeps original receive timestamps rather than making the whole replay one instant', async () => {
  let now = 10
  const h = harness(() => now), gate = deferred<AgentInfo>(), pending = h.begin(() => gate.promise)
  h.ingress.receive({ type: 'turn_started', by: 'task', context: next })
  now = 20; h.ingress.receive({ type: 'update', update: chunk('answer'), context: next })
  now = 40; h.ingress.receive({ type: 'turn_end', stopReason: 'end_turn', context: next })
  now = 1000; gate.resolve(info(next)); await pending; await flush()
  assert.equal(h.state().lastReceipt?.ms, 30)
})
