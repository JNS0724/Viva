import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createTaskActions, FINISHED_MS, REPORT_RETRY_MS, SAVE_EVERY_MS } from '../src/renderer/task-actions.ts'
import { liveTasks, taskMessages } from '../src/renderer/tasks-state.ts'

const chunk = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const WORDS = '整理这周的提交，写成发布说明'

/** A window over the real reducer, with an api whose answers the test hands over when it likes. */
function windowWith(api, deps = {}) {
  let state = [
    { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }], savedAt: 1 },
    { type: 'user_prompt', text: WORDS, at: 10 },
    { type: 'acp_update', at: 11, update: chunk('先看提交…') },
  ].reduce(reduce, initialState)
  const dispatch = (action) => { state = reduce(state, action) }
  const said = { asked: [], steered: [], toasts: [] }
  const toAction = {
    update: (event) => ({ type: 'acp_update', update: event.update, at: 50 }),
    task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: 50 }),
  }
  const deliver = (event) => dispatch(toAction[event.type](event))
  const actions = createTaskActions({
    api,
    getState: () => state,
    dispatch,
    showToast: (text) => said.toasts.push(text),
    errorMessage: (err) => err.message,
    ask: (text) => { said.asked.push(text); dispatch({ type: 'user_prompt', text, at: 60 }); return true },
    steer: (text) => { said.steered.push(text); dispatch({ type: 'user_steer', text }); return true },
    deliver,
    later: () => {},
    ...deps,
  })
  /** An event from the main process, as app.js takes it: it waits while a move is on its way. */
  const arrive = (event) => actions.hold(event) || deliver(event)
  return { actions, said, arrive, dispatch, state: () => state }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('a background submission is visible before the slow session responds; switching topics cannot attach it to the new topic', async () => {
  const reply = deferred()
  const win = windowWith({ startTask: () => reply.promise })
  const pending = win.actions.startTask('长文字'.repeat(5000))
  assert.equal(win.state().tasks.submissions.length, 1)
  assert.equal(win.state().tasks.submissions[0].text.length, 15000)
  assert.equal(win.state().tasks.submissions[0].status, 'pending')
  win.dispatch({ type: 'new_session', info: { sessionId: 'another' }, at: 100 })
  reply.resolve({ ok: true, task: { id: 'background', title: '长文字', words: '长文字' } })
  await pending
  assert.equal(win.state().tasks.submissions.length, 0)
  assert.equal(win.state().messages.length, 0)
  assert.equal(win.state().tasks.list.length, 1)
})

test('failed background submissions retain text for retry, without duplicate tasks or silent foreground steering', async () => {
  let calls = 0
  const win = windowWith({ startTask: async () => ++calls === 1 ? { ok: false, problem: 'timeout' } : { ok: true, task: { id: 's9', title: 'words', words: 'words' } } })
  assert.equal(await win.actions.startTask('words'), false)
  const failed = win.state().tasks.submissions[0]
  assert.equal(failed.text, 'words')
  assert.equal(failed.status, 'failed')
  assert.equal(await win.actions.startTask(failed.text, failed.id), true)
  assert.equal(win.state().tasks.submissions.length, 0)
  assert.equal(win.state().tasks.list.length, 1)
  assert.deepEqual(win.said.steered, [])
})

const spunReply = {
  ok: true,
  task: { id: 's1', segmentId: 'c1', title: WORDS, words: WORDS },
  info: { sessionId: 's2' },
  conversation: { id: 'c2', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }] },
  folds: [{ id: 'c1', at: 2, count: 2, kind: 'task' }],
}

test('放到后台: what the turn says on the way reaches the task, and it can be undone', async () => {
  const reply = deferred()
  const requests = []
  const win = windowWith({ spinOffTask: (request) => { requests.push(request); return reply.promise } })

  const moving = win.actions.moveToBackground()
  win.arrive({ type: 'task_update', taskId: 's1', update: chunk('三组改动。') })
  reply.resolve(spunReply)
  await moving

  assert.deepEqual(requests, [{ words: WORDS, keep: 2 }])
  const [task] = liveTasks(win.state())
  assert.deepEqual(taskMessages(task).map((m) => m.text), [WORDS, '先看提交…三组改动。'])
  assert.deepEqual(win.state().messages.map((m) => m.text), ['做周报', '写好了'])
  assert.equal(win.state().tasks.undo.taskId, 's1')
})

test('放到后台 with no words: the turn goes on in the background, the conversation is free, and undoing it adds nothing', async () => {
  const requests = []
  const win = windowWith({
    spinOffTask: async (request) => { requests.push(request); return { ...spunReply, conversation: { ...spunReply.conversation } } },
    undoTask: async () => ({ ok: true, info: { sessionId: 's1' }, conversation: { id: 'c1', messages: [] } }),
  })
  await win.actions.moveToBackground()

  assert.deepEqual(requests, [{ words: WORDS, keep: 2 }])
  assert.deepEqual([win.said.asked, win.said.steered, win.state().phase], [[], [], 'idle'])
  assert.equal(liveTasks(win.state()).length, 1)
  await win.actions.undoMove()
  assert.deepEqual([win.said.steered, win.state().phase], [[], 'working'])
})

test('a move that fails leaves the turn where it was and says why', async () => {
  const win = windowWith({ spinOffTask: async () => ({ ok: false, problem: '这句话还没有保存好' }) })
  await win.actions.moveToBackground()

  assert.equal(win.state().tasks.list.length, 0)
  assert.equal(win.state().phase, 'working')
  assert.match(win.said.toasts[0], /没能放到后台.*还没有保存好/)
})

test('undone: the task is on screen again with all it said, nothing from the conversation it leaves', async () => {
  const reply = deferred()
  const win = windowWith({ spinOffTask: async () => spunReply, undoTask: () => reply.promise })
  await win.actions.moveToBackground()

  const undoing = win.actions.undoMove()
  win.arrive({ type: 'task_update', taskId: 's1', update: chunk('三组改动。') })
  win.arrive({ type: 'update', sessionId: 's2', update: chunk('周会在十点') })
  win.arrive({ type: 'update', sessionId: 's1', update: chunk('写进 docs。') })
  reply.resolve({ ok: true, info: { sessionId: 's1' }, conversation: { id: 'c1', messages: [] } })
  await undoing

  const state = win.state()
  assert.deepEqual(state.messages.map((m) => m.text), ['做周报', '写好了', WORDS, '先看提交…三组改动。写进 docs。'])
  assert.deepEqual([state.conversationId, state.phase, state.tasks.list, state.tasks.undo], ['c1', 'working', [], null])
})

test('an undo that fails passes on what came meanwhile and says so', async () => {
  const win = windowWith({ spinOffTask: async () => spunReply, undoTask: async () => { throw new Error('dsh 没有回应') } })
  await win.actions.moveToBackground()
  await win.actions.undoMove()

  assert.deepEqual(win.said.toasts, ['dsh 没有回应'])
  assert.equal(liveTasks(win.state()).length, 1)
  assert.deepEqual(win.said.steered, [])
})

test('the island says a task ended a moment, longer while the user is typing', async () => {
  const timers = []
  let typing = true
  const win = windowWith({ spinOffTask: async () => spunReply, saveTask: async () => {} }, {
    later: (run, ms) => timers.push({ run, ms }),
    isTyping: () => typing,
  })
  await win.actions.moveToBackground()
  win.dispatch({ type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 70 })
  win.actions.ended('s1')

  // The island's timers only; the report into the conversation keeps its own (REPORT_RETRY_MS).
  const island = () => timers.filter((timer) => timer.ms === FINISHED_MS)
  const [first] = island()
  first.run()
  assert.equal(win.state().tasks.finished.taskId, 's1', 'still said while the user types')
  assert.equal(island().length, 2, 'it waits another while')
  typing = false
  island()[1].run()
  assert.equal(win.state().tasks.finished, null)
})

test('a task\'s question is answered there: one choice by picking it, more with 提交, or skipped', async () => {
  const answered = []
  const win = windowWith({ spinOffTask: async () => spunReply, answerQuestion: async (...args) => { answered.push(args); return true } })
  await win.actions.moveToBackground()
  const city = { id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }
  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q1', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'city', '上海')

  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q2', questions: [city, { ...city, id: 'day', question: '哪天？' }], at: 71 })
  win.actions.pickTaskOption('s1', 'day', '北京')
  win.actions.submitTaskAnswer('s1')
  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q3', questions: [city], at: 72 })
  win.actions.skipTaskQuestion('s1')

  assert.deepEqual(answered, [
    ['q1', [{ id: 'city', selected: ['上海'] }]],
    ['q2', [{ id: 'city', selected: [] }, { id: 'day', selected: ['北京'] }]],
    ['q3', [{ id: 'city', selected: [] }]],
  ])
  assert.equal(liveTasks(win.state())[0].question, null)
  assert.equal(win.state().question, null, 'the conversation on screen was never asked')
})

test('a task\'s report comes into the conversation at once, or once the user stops typing', async () => {
  const timers = []
  let typing = true
  const win = windowWith({ spinOffTask: async () => spunReply, saveTask: async () => {} }, {
    later: (run, ms) => timers.push({ run, ms }),
    isTyping: () => typing,
  })
  await win.actions.moveToBackground()
  win.dispatch({ type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 70 })
  win.actions.ended('s1')
  assert.equal(win.state().tasks.reports[0].shown, false, 'not while the user types')

  typing = false
  timers.filter((timer) => timer.ms === REPORT_RETRY_MS).forEach((timer) => timer.run())
  assert.equal(win.state().tasks.reports[0].shown, true)
})

test('「#name」 words go into that task\'s turn', async () => {
  const steered = []
  const win = windowWith({ spinOffTask: async () => spunReply, steerTask: async (...args) => { steered.push(args); return { ok: true } } })
  await win.actions.moveToBackground()
  win.actions.steerTask('s1', '加上版本号')
  assert.deepEqual(steered, [['s1', '加上版本号']])
  assert.equal(taskMessages(liveTasks(win.state())[0]).at(-1).text, '加上版本号')
})

test('what a task says is saved along the way, at most every so often, so a quit loses little', async () => {
  const timers = []
  const saved = []
  const win = windowWith({ spinOffTask: async () => spunReply, saveTask: async (...args) => { saved.push(args) } }, {
    later: (run, ms) => timers.push({ run, ms }),
  })
  await win.actions.moveToBackground()
  win.actions.noteUpdate('s1')
  win.actions.noteUpdate('s1')
  assert.deepEqual(timers.map((timer) => timer.ms), [SAVE_EVERY_MS], 'one save waiting, however much it says meanwhile')
  await timers.shift().run()
  assert.deepEqual(saved.map(([id, , options]) => [id, options]), [['s1', undefined]], 'saved, still going')
  win.actions.noteUpdate('s1')
  assert.equal(timers.length, 1, 'and the next one after that')
})

test('tasks the last launch left going are offered, taken up, or let go', async () => {
  const resumed = []
  const forgotten = []
  const win = windowWith({
    unfinishedTasks: async () => [{ id: 's9', title: '整理发布说明', segmentId: 'c9', startedAt: 1 }],
    resumeTask: async (taskId) => { resumed.push(taskId); return { ok: true, task: { id: taskId, segmentId: 'c9', title: '整理发布说明', words: '整理发布说明' }, messages: [{ role: 'user', text: '整理发布说明' }] } },
    forgetTask: async (taskId) => { forgotten.push(taskId) },
  })
  await win.actions.loadUnfinished()
  assert.deepEqual(win.state().tasks.unfinished.map((entry) => entry.id), ['s9'])
  await win.actions.resumeUnfinished('s9')
  assert.deepEqual([resumed, liveTasks(win.state()).map((task) => task.id), win.state().tasks.unfinished], [['s9'], ['s9'], []])

  const other = windowWith({
    unfinishedTasks: async () => [{ id: 's8', title: '查天气', segmentId: 'c8', startedAt: 1 }],
    resumeTask: async () => ({ ok: false, problem: '这件事接不上了' }),
    forgetTask: async (taskId) => { forgotten.push(taskId) },
  })
  await other.actions.loadUnfinished()
  await other.actions.resumeUnfinished('s8')
  assert.deepEqual(other.said.toasts, ['这件事接不上了'])
  await other.actions.forgetUnfinished('s8')
  assert.deepEqual([forgotten, other.state().tasks.unfinished], [['s8'], []])
})

test('an ended task keeps what it said, and how it ended', async () => {
  const saved = []
  const win = windowWith({ spinOffTask: async () => spunReply, saveTask: async (...args) => { saved.push(args) } })
  await win.actions.moveToBackground()
  win.dispatch({ type: 'task_end', taskId: 's1', stopReason: 'cancelled', at: 70 })
  win.actions.ended('s1')

  assert.deepEqual(saved, [['s1', [{ role: 'user', text: WORDS }, { role: 'assistant', text: '先看提交…' }], { ended: true, status: 'stopped' }]],
    'ended: kept to be asked again, not offered as unfinished')
})

test('a task that ended is asked again: it goes back to work, or says why it could not and stays as it was', async () => {
  const asked = []
  const win = windowWith({ spinOffTask: async () => spunReply, askTask: async (...args) => { asked.push(args); return { ok: true } } })
  await win.actions.moveToBackground()
  win.dispatch({ type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 70 })

  await win.actions.askTask('s1', '再加上已知问题')
  assert.deepEqual(asked, [['s1', '再加上已知问题']])
  const [task] = liveTasks(win.state())
  assert.deepEqual([task.id, taskMessages(task).at(-1).text], ['s1', '再加上已知问题'])

  const refused = windowWith({ spinOffTask: async () => spunReply, askTask: async () => ({ ok: false, problem: '这件事接不上了' }) })
  await refused.actions.moveToBackground()
  refused.dispatch({ type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 70 })
  await refused.actions.askTask('s1', '再加上已知问题')
  assert.deepEqual(refused.said.toasts, ['这件事接不上了'])
  const [still] = refused.state().tasks.list
  assert.deepEqual([still.status, liveTasks(refused.state()).length], ['done', 0], 'as it was before')
})

test('后台做 while a turn runs: a task of its own, started from before that turn; the turn goes on in front', async () => {
  const requests = []
  const win = windowWith({ startTask: async (request) => { requests.push(request); return { ok: true, task: { id: 's9', segmentId: 'c9', title: '查天气', words: '查天气' } } } })
  await win.actions.startTask('查天气')

  assert.deepEqual(requests, [{ text: '查天气', words: WORDS }])
  assert.deepEqual(liveTasks(win.state()).map((task) => [task.id, task.status]), [['s9', 'running']])
  assert.equal(win.state().phase, 'working', 'the turn on screen goes on')
  assert.ok(!win.state().messages.some((message) => message.taskId), 'its answer is still coming: the words are on the card, not in between')

  const refused = windowWith({ startTask: async () => ({ ok: false, problem: '没能交给后台（invalid）' }) })
  await refused.actions.startTask('查天气')
  assert.deepEqual(liveTasks(refused.state()), [])
  assert.equal(refused.state().tasks.submissions[0].problem, '没能交给后台（invalid）')
  assert.equal(refused.state().tasks.submissions[0].text, '查天气')
})

test('tasks that had ended by the last launch come back at the start, beside those left going', async () => {
  const win = windowWith({
    unfinishedTasks: async () => [],
    finishedTasks: async () => [{
      task: { id: 's3', segmentId: 'c3', title: '查天气', words: '查天气' }, status: 'done', endedAt: 5,
      messages: [{ role: 'user', text: '查天气', receipt: null }, { role: 'assistant', text: '晴。', receipt: null }],
    }],
  })
  await win.actions.loadUnfinished()
  const [task] = win.state().tasks.list
  assert.deepEqual([task.id, task.status, taskMessages(task).map((m) => m.text)], ['s3', 'done', ['查天气', '晴。']])
})
