import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from './fixtures/task-window.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
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
    // As app.ts maps them: a piece with its place in the task's stream, a snapshot as it is.
    task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: 50,
      ...(typeof event.taskSeq === 'number' ? { runId: event.runId, seq: event.taskSeq } : {}) }),
    task_snapshot: (event) => ({ type: 'task_snapshot', snapshot: event.snapshot }),
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
    ...deps,
  })
  /** An event from the main process, as app.ts takes it: straight to the state, none held back. */
  const arrive = (event) => deliver(event)
  return { actions, said, arrive, dispatch, state: () => state }
}

const started = { id: 's1', segmentId: 'c9', title: WORDS, words: WORDS }
/** The snapshot the backend sends as the agent starts a task (task-runtime.ts): the one that makes it. */
const begins = { type: 'task_snapshot', snapshot: { taskId: 's1', runId: 'run-1', title: WORDS, status: 'running', currentAction: null, waitingFor: null,
  startedAt: 10, updatedAt: 10, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0,
  opening: { words: WORDS, task: started, hostSession: 'main' } } }

/** A task the agent started, saying something: a task in the background to work with. */
function withTask(win) {
  win.arrive(begins)
  win.dispatch({ type: 'task_update', taskId: 's1', update: chunk('先看提交…'), at: 20 })
}

test('a task is made by the snapshot that begins it, before what it says; each piece of its run is taken once', () => {
  const win = windowWith({})
  // The backend's order (task-runtime.ts): the snapshot that makes it, then its first piece.
  win.arrive(begins)
  // Each as the event core sends it: its own `seq` (the event log's) beside the task's `taskSeq`.
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 1, seq: 900, update: chunk('三组改动。') })
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 1, seq: 900, update: chunk('三组改动。') })
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-0', taskSeq: 2, seq: 900, update: chunk('别的运行说的') })
  assert.equal(win.state().tasks.list.length, 1, 'one task')
  assert.deepEqual(taskMessages(liveTasks(win.state())[0]).map((m) => m.text), [WORDS, '三组改动。'], 'each piece once; one of another run left out')
  assert.deepEqual(win.state().messages.map((m) => m.text), ['做周报', '写好了', WORDS, '先看提交…'], 'the conversation on screen as it was')
})

test('a task\'s question is answered there: one choice by picking it, more with 提交, or skipped', async () => {
  const answered = []
  const win = windowWith({ answerQuestion: async (...args) => { answered.push(args); return true } })
  withTask(win)
  const city = { id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }
  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q1', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'city', '上海')
  await Promise.resolve()

  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q2', questions: [city, { ...city, id: 'day', question: '哪天？' }], at: 71 })
  win.actions.pickTaskOption('s1', 'day', '北京')
  win.actions.submitTaskAnswer('s1')
  await Promise.resolve()
  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q3', questions: [city], at: 72 })
  win.actions.skipTaskQuestion('s1')
  await Promise.resolve()

  assert.deepEqual(answered, [
    ['q1', [{ id: 'city', selected: ['上海'] }]],
    ['q2', [{ id: 'city', selected: [] }, { id: 'day', selected: ['北京'] }]],
    ['q3', [{ id: 'city', selected: [] }]],
  ])
  assert.equal(liveTasks(win.state())[0].question, null)
  assert.equal(win.state().question, null, 'the conversation on screen was never asked')
})

test('a task question stays open and toasts when backend refuses the answer (e.g. active slots full)', async () => {
  const win = windowWith({ answerQuestion: async () => { throw new Error('同时最多 5 个后台任务在跑') } })
  withTask(win)
  const city = { id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }] }
  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q-full', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'city', '上海')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(liveTasks(win.state())[0].question?.questionId, 'q-full', 'question prompt stays intact on refusal')
  assert.match(win.said.toasts.at(-1) ?? '', /最多 5 个/)
})

test('a task answer is still recorded in messages and timeline even when task_question_closed arrives before IPC resolves', async () => {
  let resolveAnswer
  const win = windowWith({ answerQuestion: () => new Promise((resolve) => { resolveAnswer = resolve }) })
  withTask(win)
  const city = { id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }
  win.dispatch({ type: 'task_question', taskId: 's1', questionId: 'q-race', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'city', '上海')
  // Backend emits task_question_closed BEFORE the IPC promise resolves.
  win.dispatch({ type: 'task_question_closed', taskId: 's1', questionId: 'q-race', at: 71 })
  assert.equal(liveTasks(win.state())[0].question, null)
  resolveAnswer(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const task = liveTasks(win.state())[0]
  assert.equal(taskMessages(task).at(-1).text, '上海')
  const entries = task.view.timeline.filter((entry) => entry.kind === 'answer' && entry.ref === 'q-race')
  assert.equal(entries.length, 1, 'replaces premature closed entry instead of duplicating')
  assert.equal(entries[0].answered, true)
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
  assert.deepEqual([task.id, task.status, taskMessages(task).map((m) => m.text)], ['s3', 'done', ['查天气', '晴。']])
})

test('loadKept shows a one-time startup toast for restored interrupted tasks, and resumeTask forwards to api.resumeTask', async () => {
  const resumed = []
  let nextResult = { ok: true }
  const interruptedTask = {
    task: { id: 'int-1', segmentId: 'c-int', title: '分析日志', words: '分析日志' }, status: 'interrupted', endedAt: 5,
    messages: [{ role: 'user', text: '分析日志', receipt: null }],
  }
  const win = windowWith({
    finishedTasks: async () => [interruptedTask],
    resumeTask: async (taskId) => { resumed.push(taskId); return nextResult },
  })
  await win.actions.loadKept()
  assert.equal(win.said.toasts.length, 1)
  assert.match(win.said.toasts[0], /1 个后台任务/)

  // Re-reading the same interrupted task does not repeat the toast.
  await win.actions.loadKept()
  assert.equal(win.said.toasts.length, 1)

  await win.actions.resumeTask('int-1')
  assert.deepEqual(resumed, ['int-1'])
  assert.equal(win.said.toasts.length, 1)

  nextResult = { ok: false, problem: '上下文已失效' }
  await win.actions.resumeTask('int-1')
  assert.equal(win.said.toasts.at(-1), '上下文已失效')
})
