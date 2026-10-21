import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { liveTasks, routeOf, spinOffTarget, taskMessages } from '../src/renderer/tasks-state.js'

const chunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const run = (actions, start = initialState) => actions.reduce((state, action) => reduce(state, action), start)

/** A conversation with one finished exchange, and the turn 「整理发布说明」 running, part way into its answer. */
function working() {
  return run([
    { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }], savedAt: 1 },
    { type: 'user_prompt', text: '整理这周的提交，写成发布说明', at: 10 },
    { type: 'acp_update', at: 11, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: '运行 git log', kind: 'execute', status: 'in_progress' } },
    { type: 'acp_update', at: 12, update: chunk('先看提交…') },
  ])
}
const spun = (state) => reduce(state, {
  type: 'task_spun',
  task: { id: 's1', segmentId: 'c1', title: '整理这周的提交，写成发布说明', words: '整理这周的提交，写成发布说明' },
  conversation: { id: 'c2', messages: state.messages.slice(0, 2).map(({ role, text }) => ({ role, text, receipt: null })) },
  info: { sessionId: 's2', cwd: '/w' },
  folds: [{ id: 'c1', at: 2, count: 2, kind: 'task' }],
  at: 20,
})

test('words typed while a turn runs: about the same thing go into it, about something else go on their own', () => {
  const state = working()
  assert.equal(routeOf(initialState, '周会几点'), null, 'nothing runs, nothing to route')
  assert.equal(routeOf(state, '明天周会几点？'), 'other')
  assert.equal(routeOf(state, '顺便把已知问题也列上'), 'into', 'said to go on with it')
  assert.equal(routeOf(state, '发布说明里加上版本号'), 'into', 'sharing words with what runs')
  assert.equal(routeOf(reduce(state, { type: 'route_toggle', text: '明天周会几点？' }), '明天周会几点？'), 'into', 'Tab turns it round')
})

test('what moves to the background: the words that started the turn and where they are among what is saved', () => {
  assert.deepEqual(spinOffTarget(working()), { words: '整理这周的提交，写成发布说明', keep: 2 })
  assert.equal(spinOffTarget(initialState), null)
})

test('moved to the background: the conversation keeps what came before; the task takes the turn with it', () => {
  const before = working()
  const state = spun(before)

  assert.deepEqual(state.messages.map((m) => m.text), ['做周报', '写好了'])
  assert.equal(state.phase, 'idle', 'the conversation on screen is free')
  assert.deepEqual(state.folds, [{ id: 'c1', at: 2, count: 2, kind: 'task' }])
  const [task] = liveTasks(state)
  assert.deepEqual([task.id, task.status, task.now, task.startedAt], ['s1', 'running', '运行 git log', 10])
  assert.deepEqual(taskMessages(task).map((m) => m.text), ['整理这周的提交，写成发布说明', '先看提交…'])
  assert.equal(state.tasks.undo.taskId, 's1', 'it can be undone')
})

test('what the task says and asks goes to the task; its end leaves the conversation alone', () => {
  const state = run([
    { type: 'task_update', taskId: 's1', update: chunk('三组改动。'), at: 30 },
    { type: 'task_update', taskId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: '写入 docs/release.md', kind: 'edit', status: 'in_progress' }, at: 31 },
    { type: 'permission_request', requestId: 'p1', taskId: 's1', toolCall: { toolCallId: 't2', title: '写入 docs/release.md' }, options: [], at: 32 },
  ], spun(working()))
  let [task] = liveTasks(state)
  assert.deepEqual([task.status, task.now, task.permission.requestId], ['waiting', '写入 docs/release.md', 'p1'])
  assert.equal(state.permission, null, 'the conversation on screen is not asked')
  assert.deepEqual(taskMessages(task).map((m) => m.text), ['整理这周的提交，写成发布说明', '先看提交…三组改动。'])

  const answered = reduce(state, { type: 'permission_resolved', requestId: 'p1', optionId: 'allow', at: 33 })
  assert.equal(liveTasks(answered)[0].status, 'running')
  const ended = reduce(answered, { type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 40 })
  ;[task] = ended.tasks.list
  assert.deepEqual([task.status, task.endedAt, ended.tasks.undo], ['done', 40, null])
  assert.equal(ended.phase, 'idle')
})

test('undone, the turn is on screen again with what it said since, still running', () => {
  const before = working()
  const moved = reduce(spun(before), { type: 'task_update', taskId: 's1', update: chunk('三组改动。'), at: 30 })
  const back = reduce(moved, { type: 'task_undone', taskId: 's1', conversationId: 'c1', info: { sessionId: 's1' } })

  assert.deepEqual(back.messages.map((m) => m.text), ['做周报', '写好了', '整理这周的提交，写成发布说明', '先看提交…三组改动。'])
  assert.equal(back.phase, 'working')
  assert.equal(back.conversationId, 'c1')
  assert.deepEqual([back.tasks.list, back.tasks.undo, back.folds], [[], null, []])
})
