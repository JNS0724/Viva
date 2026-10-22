import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { liveTasks, mentionedTask, offeredBackground, routeOf, spinOffTarget, taskMessages, taskOfTab, taskTab } from '../src/renderer/tasks-state.js'
import { traceItems } from '../src/renderer/selectors.js'

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
  assert.equal(routeOf(state, '帮我订一张周五的机票'), 'other', 'a new request')
  assert.equal(routeOf(state, '嗯，慢一点'), 'into', 'unsure: into it, which adds nothing')
  const helping = run([{ type: 'user_prompt', text: '帮我接入演示服务', at: 70 }], reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: 60 }))
  assert.equal(routeOf(helping, '帮我订一张周五的机票'), 'other', 'how a request starts is not what it is about')
  assert.equal(routeOf(helping, '帮我把演示服务的端口改成 8080'), 'into')
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

test('a task\'s question is answered in the task, not in the conversation on screen', () => {
  const cities = [{ id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }]
  const asked = run([{ type: 'task_question', taskId: 's1', questionId: 'q1', questions: cities, at: 30 }], spun(working()))
  assert.deepEqual([liveTasks(asked)[0].status, liveTasks(asked)[0].question.questionId, asked.question], ['waiting', 'q1', null])

  const picked = reduce(asked, { type: 'question_pick', taskId: 's1', id: 'city', label: '上海' })
  assert.deepEqual(liveTasks(picked)[0].question.picks, { city: ['上海'] })
  const answered = reduce(picked, { type: 'question_answered', taskId: 's1', questionId: 'q1', answers: [{ id: 'city', selected: ['上海'] }], at: 31 })
  const [task] = liveTasks(answered)
  assert.deepEqual([task.status, task.question], ['running', null])
  assert.equal(taskMessages(task).at(-1).text, '上海')
  assert.deepEqual(answered.messages.map((m) => m.text), ['做周报', '写好了'], 'the conversation on screen is left alone')
})

test('the agent saying a job will take long offers the background while that turn runs', () => {
  const offer = { type: 'acp_update', at: 13, update: { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'viva_offer_background', status: 'completed', rawInput: { why: '要逐个读完所有提交' } } }
  const state = reduce(working(), offer)
  assert.deepEqual(offeredBackground(state), { why: '要逐个读完所有提交' })
  assert.equal(offeredBackground(working()), null, 'not unless the agent said so')
  assert.equal(offeredBackground(reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: 20 })), null, 'not once the turn is over')
  const next = run([{ type: 'turn_end', stopReason: 'end_turn', at: 20 }, { type: 'user_prompt', text: '再来一份', at: 30 }], state)
  assert.equal(offeredBackground(next), null, 'a later turn is offered only if the agent says so again')
  assert.deepEqual(traceItems(state).at(-1), { key: traceItems(state).at(-1).key, time: traceItems(state).at(-1).time, title: '提议放到后台', detail: '要逐个读完所有提交', tone: 'done' })
})

test('a task that ends reports back to the conversation, once the user is not typing, until put away', () => {
  const said = reduce(spun(working()), { type: 'task_update', taskId: 's1', update: chunk('三组改动，已写进 docs/release.md。'), at: 30 })
  const ended = reduce(said, { type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 40 })
  assert.deepEqual(ended.tasks.reports, [{ taskId: 's1', title: '整理这周的提交，写成发布说明', status: 'done', preview: '先看提交…三组改动，已写进 docs/release.md。', shown: false }])
  const shown = reduce(ended, { type: 'task_report_shown', taskId: 's1' })
  assert.equal(shown.tasks.reports[0].shown, true)
  assert.deepEqual(reduce(shown, { type: 'task_report_dismissed', taskId: 's1' }).tasks.reports, [])
})

test('「#name」 at the start goes to the background task it names, as words into its turn', () => {
  const state = spun(working())
  assert.deepEqual(mentionedTask(state, '#发布说明 加上版本号'), { taskId: 's1', title: '整理这周的提交，写成发布说明', text: '加上版本号' })
  assert.equal(mentionedTask(state, '#周会 几点'), null, 'no task by that name')
  assert.equal(mentionedTask(state, '发布说明加上版本号'), null, 'only at the start')
  const steered = reduce(state, { type: 'task_steer', taskId: 's1', text: '加上版本号', at: 50 })
  assert.equal(taskMessages(liveTasks(steered)[0]).at(-1).text, '加上版本号')
  assert.deepEqual(steered.messages.map((m) => m.text), ['做周报', '写好了'], 'not in the conversation on screen')
})

test('a task has its own tab in the drawer, showing what it did', () => {
  const state = spun(working())
  const tab = taskTab('s1')
  assert.equal(taskOfTab(state, tab).id, 's1')
  assert.equal(taskOfTab(state, 'trace'), null)
  assert.equal(taskOfTab(state, taskTab('gone')), null)
  assert.equal(reduce(state, { type: 'open_drawer', tab }).drawer, tab)
  const closed = reduce(reduce(state, { type: 'open_drawer', tab }), { type: 'task_closed', taskId: 's1' })
  assert.equal(closed.drawer, 'trace', 'its tab gone, the drawer shows the conversation\'s')
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
