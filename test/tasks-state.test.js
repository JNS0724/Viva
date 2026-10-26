import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { liveTasks, mentionedTask, offeredBackground, routeOf, spinOffTarget, taskMessages, taskOfTab, taskTab } from '../src/renderer/tasks-state.ts'
import { traceItems } from '../src/renderer/selectors.ts'
import { showsHome } from '../src/renderer/view/render.ts'
import { cardedTasks } from '../src/renderer/view/task-card.ts'

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

test('a task\'s steps are its own turn\'s, not those of the turns before it', () => {
  const earlier = run([
    { type: 'user_prompt', text: '先看看日志', at: 1 },
    { type: 'acp_update', at: 2, update: { sessionUpdate: 'tool_call', toolCallId: 't0', title: '读取 app.log', kind: 'read', status: 'completed' } },
    { type: 'turn_end', stopReason: 'end_turn', at: 3 },
  ], working())
  const state = run([
    { type: 'user_prompt', text: WORDS_LATER, at: 10 },
    { type: 'acp_update', at: 11, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: '运行 git log', kind: 'execute', status: 'in_progress' } },
    { type: 'task_spun', task: { id: 's1', segmentId: 'c1', title: WORDS_LATER, words: WORDS_LATER }, conversation: { id: 'c2', messages: [] }, info: { sessionId: 's2' }, folds: [], at: 20 },
  ], reduce(earlier, { type: 'conversation_saved', id: 'c1' }))
  const [task] = liveTasks(state)
  assert.deepEqual(task.view.timeline.map((entry) => entry.ref), ['t1'])
  const back = reduce(state, { type: 'task_undone', taskId: 's1', conversationId: 'c1', info: { sessionId: 's1' } })
  assert.deepEqual(back.timeline.map((entry) => entry.ref).sort(), ['t0', 't1'], 'undone, the earlier steps are back too')
})

const WORDS_LATER = '整理发布说明'

test('a background request while idle adds only its card; the original words stay in task details', () => {
  const idle = run([{ type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'assistant', text: '有什么可以帮你？' }], savedAt: 1 }])
  const state = reduce(idle, { type: 'task_started', task: { id: 'bg', segmentId: 'bg-c', title: '查天气', words: '查天气' }, text: '查天气', at: 2 })
  assert.deepEqual(state.messages.map(message => message.text), ['有什么可以帮你？'])
  assert.deepEqual(state.messages[0].cardsAfter, ['bg'])
  assert.deepEqual(taskMessages(state.tasks.list[0]).map(message => message.text), ['查天气'])
  const empty = reduce(initialState, { type: 'task_started', task: { id: 'bg', title: '查天气' }, text: '查天气', at: 2 })
  assert.deepEqual(empty.messages, [], 'even an empty conversation must not acquire a user bubble')
  assert.equal(showsHome(empty), false, 'the welcome screen must not hide the standalone background card')
  assert.deepEqual(cardedTasks(empty).map(({ task }) => task.id), ['bg'])
  assert.equal(showsHome(initialState), true)
  const speaking = reduce(empty, { type: 'user_prompt', text: '这里继续聊', at: 3 })
  assert.deepEqual(speaking.taskCards, ['bg'], 'the standalone card remains before the first foreground message')
  assert.deepEqual(cardedTasks(speaking).map(({ task }) => task.id), ['bg'])
  const fresh = reduce(speaking, { type: 'new_session' })
  assert.deepEqual(fresh.taskCards, [])
  assert.deepEqual(cardedTasks(fresh), [], 'another topic must not acquire a stale unhosted card')
  const closed = reduce(empty, { type: 'task_closed', taskId: 'bg' })
  assert.deepEqual(closed.taskCards, [])
  assert.equal(showsHome(closed), true, 'closing the only card leaves no ghost conversation')
  const failed = run([{ type: 'task_end', taskId: 'bg', stopReason: 'error', message: 'offline', at: 4 }, { type: 'task_report_shown', taskId: 'bg' }], empty)
  assert.equal(cardedTasks(failed).length, 1, 'a failure is visible on the same card')
  assert.equal(cardedTasks(reduce(failed, { type: 'task_report_dismissed', taskId: 'bg' })).length, 0)
  const late = reduce(reduce(initialState, { type: 'new_session_pending', at: 1 }), {
    type: 'task_started', task: { id: 'late', title: '旧话题的任务' }, text: '旧请求', origin: null, at: 2,
  })
  assert.deepEqual(late.taskCards, [], 'an old pending submission cannot attach to the new topic before its session id changes')
  const restored = reduce(initialState, { type: 'task_resumed', task: { id: 'resumed', title: '恢复任务' }, messages: [{ role: 'user', text: '原始请求' }], at: 4 })
  assert.deepEqual(restored.taskCards, ['resumed'], 'resuming persisted task data restores its standalone card')
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

test('a task with no words of its own on screen hangs its card under the message last when it started, and stays there', () => {
  const state = spun(working())
  assert.deepEqual(state.messages.map((m) => m.cardsAfter ?? []), [[], ['s1']], 'under 「写好了」, where the turn left')
  const later = run([
    { type: 'user_prompt', text: '再帮我看下周会', at: 30 },
    { type: 'acp_update', at: 31, update: chunk('周会在周三') },
    { type: 'turn_end', at: 32, stopReason: 'end_turn' },
  ], state)
  assert.deepEqual(later.messages.map((m) => m.cardsAfter ?? []), [[], ['s1'], [], []], 'what is said later goes below the card, not above it')

  // 后台做 while a turn runs: the words do not join the conversation, so the card goes under what is there now.
  const busy = reduce(working(), { type: 'task_started', task: { id: 't2', segmentId: 'c-t2', title: '查日程', words: '查日程' }, text: '查日程', at: 15 })
  assert.deepEqual(busy.messages.at(-1).cardsAfter, ['t2'])
  assert.equal(busy.messages.at(-1).text, '先看提交…', 'on the answer being written')
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

test('a task that fails says why: on its card and on its page', () => {
  const failed = reduce(spun(working()), { type: 'task_end', taskId: 's1', stopReason: 'error', message: 'No API key for provider: custom-d59f4622', at: 40 })
  const [task] = failed.tasks.list
  assert.deepEqual([task.status, task.view.phase, task.view.error], ['error', 'error', 'No API key for provider: custom-d59f4622'])
  assert.equal(failed.tasks.reports[0].preview, 'No API key for provider: custom-d59f4622', 'the card says why, not where it had got to')
})

test('「#name」 at the start goes to the background task it names, as words into its turn', () => {
  const state = spun(working())
  assert.deepEqual(mentionedTask(state, '#发布说明 加上版本号'), { taskId: 's1', title: '整理这周的提交，写成发布说明', text: '加上版本号', ended: false })
  assert.equal(mentionedTask(state, '#周会 几点'), null, 'no task by that name')
  assert.equal(mentionedTask(state, '发布说明加上版本号'), null, 'only at the start')
  const steered = reduce(state, { type: 'task_steer', taskId: 's1', text: '加上版本号', at: 50 })
  assert.equal(taskMessages(liveTasks(steered)[0]).at(-1).text, '加上版本号')
  assert.deepEqual(steered.messages.map((m) => m.text), ['做周报', '写好了'], 'not in the conversation on screen')
})

test('a task that ended can be asked again: 「#name」 reaches it, and it goes back to work with the words', () => {
  const ended = run([
    { type: 'task_update', taskId: 's1', update: chunk('写好了。'), at: 30 },
    { type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 40 },
    { type: 'task_report_shown', taskId: 's1' },
  ], spun(working()))
  const [task] = ended.tasks.list
  assert.deepEqual(mentionedTask(ended, '#发布说明 再加上已知问题'), { taskId: 's1', title: task.title, text: '再加上已知问题', ended: true })
  assert.deepEqual(mentionedTask(ended, '#发布说明 ')?.text, '', 'found as soon as the name is written, before the words')
  assert.equal(mentionedTask(ended, '#发布说明'), null, 'not before the space after the name')

  const asked = reduce(ended, { type: 'task_asked', taskId: 's1', text: '再加上已知问题', at: 60 })
  const [again] = liveTasks(asked)
  assert.deepEqual([again.id, again.status, again.endedAt, again.startedAt], ['s1', 'running', null, 60])
  assert.equal(taskMessages(again).at(-1).text, '再加上已知问题')
  assert.deepEqual(asked.tasks.reports, [], 'its card goes: a new one comes when it is done again')
  assert.deepEqual(asked.messages.map((m) => m.text), ['做周报', '写好了'], 'not in the conversation on screen')
})

test('tasks that had ended by the last launch come back ended, and can be asked again', () => {
  const restored = reduce(initialState, {
    type: 'tasks_restored',
    list: [{
      task: { id: 's3', segmentId: 'c3', title: '查一下明天上海的天气', words: '查一下明天上海的天气' }, status: 'done', endedAt: 5,
      messages: [{ role: 'user', text: '查一下明天上海的天气', receipt: null }, { role: 'assistant', text: '晴，18 到 25 度。', receipt: null }],
    }],
  })
  const [task] = restored.tasks.list
  assert.deepEqual([task.id, task.status, task.endedAt, liveTasks(restored).length], ['s3', 'done', 5, 0])
  assert.deepEqual(taskMessages(task).map((m) => m.text), ['查一下明天上海的天气', '晴，18 到 25 度。'])
  assert.deepEqual(restored.tasks.reports, [], 'reported last time already')
  assert.equal(mentionedTask(restored, '#天气 后天呢')?.ended, true)
})

test('tasks the last launch left going are offered; taken up, one goes on with what it had said', () => {
  const offered = reduce(initialState, { type: 'tasks_unfinished', list: [{ id: 's1', title: '整理发布说明', segmentId: 'c1', startedAt: 5 }, { id: 's2', title: '查天气', segmentId: 'c2', startedAt: 6 }] })
  assert.deepEqual(offered.tasks.unfinished.map((entry) => entry.id), ['s1', 's2'])

  const taken = reduce(offered, {
    type: 'task_resumed', at: 50,
    task: { id: 's1', segmentId: 'c1', title: '整理发布说明', words: '整理发布说明' },
    messages: [{ role: 'user', text: '整理发布说明', receipt: null }, { role: 'assistant', text: '先看提交…', receipt: null }],
  })
  const [task] = liveTasks(taken)
  assert.deepEqual([task.id, task.status, task.startedAt], ['s1', 'running', 50])
  assert.deepEqual(taskMessages(task).map((m) => m.text), ['整理发布说明', '先看提交…'])
  assert.deepEqual(taken.tasks.unfinished.map((entry) => entry.id), ['s2'], 'no longer offered')
  assert.deepEqual(reduce(taken, { type: 'task_forgotten', taskId: 's2' }).tasks.unfinished, [])
  const said = reduce(taken, { type: 'task_update', taskId: 's1', update: chunk('三组改动。'), at: 51 })
  assert.equal(taskMessages(liveTasks(said)[0]).at(-1).text, '三组改动。', 'what it says now follows')

  // Taken up in a conversation on screen: its card goes under what is there now, and stays there.
  const shown = run([
    { type: 'history_loaded', conversationId: 'c9', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }], savedAt: 1 },
    { type: 'tasks_unfinished', list: [{ id: 's1', title: '整理发布说明', segmentId: 'c1', startedAt: 5 }] },
    { type: 'task_resumed', at: 50, task: { id: 's1', segmentId: 'c1', title: '整理发布说明', words: '整理发布说明' }, messages: [] },
  ])
  assert.deepEqual(shown.messages.map((m) => m.cardsAfter ?? []), [[], ['s1']])
  const askedAgain = reduce({ ...shown, tasks: { ...shown.tasks, list: shown.tasks.list.map((t) => ({ ...t, status: 'done' })) } }, { type: 'task_asked', taskId: 's1', text: '再补一句', at: 60 })
  assert.deepEqual(askedAgain.messages.map((m) => m.cardsAfter ?? []), [[], ['s1']], 'asked again, the card is where it was, not twice')
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
