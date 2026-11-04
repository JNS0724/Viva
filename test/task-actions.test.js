import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
import { liveTasks } from '../src/renderer/tasks-state.ts'

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
    ...deps,
  })
  /** An event from the main process, as app.ts takes it: it waits while the task it is for is being started. */
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

const startedReply = { ok: true, task: { id: 's1', segmentId: 'c9', title: WORDS, words: WORDS } }

/** 后台做 with the words, and the task saying something: a task in the background to work with. */
async function withTask(win) {
  await win.actions.startTask(WORDS)
  win.dispatch({ type: 'task_update', taskId: 's1', update: chunk('先看提交…'), at: 20 })
}

test('what a task says before the window knows it waits, then reaches it', async () => {
  const reply = deferred()
  const win = windowWith({ startTask: () => reply.promise })
  const starting = win.actions.startTask(WORDS)
  win.arrive({ type: 'task_update', taskId: 's1', update: chunk('三组改动。') })
  reply.resolve(startedReply)
  await starting
  assert.deepEqual(liveTasks(win.state())[0].view.messages.map((m) => m.text), [WORDS, '三组改动。'])
  assert.deepEqual(win.state().messages.map((m) => m.text), ['做周报', '写好了', WORDS, '先看提交…'], 'the conversation on screen as it was')
})

test('a task\'s question is answered there: one choice by picking it, more with 提交, or skipped', async () => {
  const answered = []
  const win = windowWith({ startTask: async () => startedReply, answerQuestion: async (...args) => { answered.push(args); return true } })
  await withTask(win)
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

test('the tasks the last launch kept come back at the start, with what they said', async () => {
  const win = windowWith({
    finishedTasks: async () => [{
      task: { id: 's3', segmentId: 'c3', title: '查天气', words: '查天气' }, status: 'done', endedAt: 5,
      messages: [{ role: 'user', text: '查天气', receipt: null }, { role: 'assistant', text: '晴。', receipt: null }],
    }],
  })
  await win.actions.loadKept()
  const [task] = win.state().tasks.list
  assert.deepEqual([task.id, task.status, task.view.messages.map((m) => m.text)], ['s3', 'done', ['查天气', '晴。']])
})
