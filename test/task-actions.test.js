import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { createTaskActions, FINISHED_MS, REPORT_RETRY_MS } from '../src/renderer/task-actions.js'
import { liveTasks, taskMessages } from '../src/renderer/tasks-state.js'

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

const spunReply = {
  ok: true,
  task: { id: 's1', segmentId: 'c1', title: WORDS, words: WORDS },
  info: { sessionId: 's2' },
  conversation: { id: 'c2', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }] },
  folds: [{ id: 'c1', at: 2, count: 2, kind: 'task' }],
}

test('moved to the background: what the turn says on the way reaches the task, and the words go as a question', async () => {
  const reply = deferred()
  const requests = []
  const win = windowWith({ spinOffTask: (request) => { requests.push(request); return reply.promise } })

  const moving = win.actions.moveAndAsk('明天周会几点？')
  win.arrive({ type: 'task_update', taskId: 's1', update: chunk('三组改动。') })
  reply.resolve(spunReply)
  await moving

  assert.deepEqual(requests, [{ words: WORDS, keep: 2, text: '明天周会几点？' }])
  const [task] = liveTasks(win.state())
  assert.deepEqual(taskMessages(task).map((m) => m.text), [WORDS, '先看提交…三组改动。'])
  assert.deepEqual(win.said.asked, ['明天周会几点？'])
  assert.deepEqual(win.state().messages.map((m) => m.text), ['做周报', '写好了', '明天周会几点？'])
  assert.equal(win.state().tasks.undo.text, '明天周会几点？')
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

test('a move that fails leaves the turn where it was, and the words go into it', async () => {
  const win = windowWith({ spinOffTask: async () => ({ ok: false, problem: '这句话还没有保存好' }) })
  await win.actions.moveAndAsk('明天周会几点？')

  assert.deepEqual([win.said.asked, win.said.steered], [[], ['明天周会几点？']])
  assert.equal(win.state().tasks.list.length, 0)
  assert.match(win.said.toasts[0], /没能挪到后台.*还没有保存好/)
})

test('undone: the task is on screen again with all it said, nothing from the conversation it leaves, and the words go into it', async () => {
  const reply = deferred()
  const win = windowWith({ spinOffTask: async () => spunReply, undoTask: () => reply.promise })
  await win.actions.moveAndAsk('明天周会几点？')

  const undoing = win.actions.undoMove()
  win.arrive({ type: 'task_update', taskId: 's1', update: chunk('三组改动。') })
  win.arrive({ type: 'update', sessionId: 's2', update: chunk('周会在十点') })
  win.arrive({ type: 'update', sessionId: 's1', update: chunk('写进 docs。') })
  reply.resolve({ ok: true, info: { sessionId: 's1' }, conversation: { id: 'c1', messages: [] } })
  await undoing

  const state = win.state()
  assert.deepEqual(state.messages.map((m) => m.text), ['做周报', '写好了', WORDS, '先看提交…三组改动。写进 docs。', '明天周会几点？'])
  assert.deepEqual([state.conversationId, state.phase, state.tasks.list, state.tasks.undo], ['c1', 'working', [], null])
  assert.deepEqual(win.said.steered, ['明天周会几点？'])
})

test('an undo that fails passes on what came meanwhile and says so', async () => {
  const win = windowWith({ spinOffTask: async () => spunReply, undoTask: async () => { throw new Error('dsh 没有回应') } })
  await win.actions.moveAndAsk('明天周会几点？')
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
  await win.actions.moveAndAsk('明天周会几点？')
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
  await win.actions.moveAndAsk('明天周会几点？')
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
  await win.actions.moveAndAsk('明天周会几点？')
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
  await win.actions.moveAndAsk('明天周会几点？')
  win.actions.steerTask('s1', '加上版本号')
  assert.deepEqual(steered, [['s1', '加上版本号']])
  assert.equal(taskMessages(liveTasks(win.state())[0]).at(-1).text, '加上版本号')
})

test('an ended task keeps what it said', async () => {
  const saved = []
  const win = windowWith({ spinOffTask: async () => spunReply, saveTask: async (...args) => { saved.push(args) } })
  await win.actions.moveAndAsk('明天周会几点？')
  win.actions.ended('s1')

  assert.deepEqual(saved, [['s1', [{ role: 'user', text: WORDS }, { role: 'assistant', text: '先看提交…' }]]])
})
