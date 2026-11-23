import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from './fixtures/task-window.ts'
import type { AgentEvent } from '../src/renderer/agent-event-types.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
import { liveTasks, taskMessages } from '../src/renderer/tasks-state.ts'

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as const)
const WORDS = '整理这周的提交，写成发布说明'

/** A window over the real reducer, with an api whose answers the test hands over when it likes. */
type DispatchAction = Parameters<typeof reduce>[1]
type TasksApi = Parameters<typeof createTaskActions>[0]['api']
type FixtureEvent = Extract<AgentEvent, { type: 'update' | 'task_update' | 'task_snapshot' }>

function windowWith(api: Partial<TasksApi>) {
  const beginning: DispatchAction[] = [
    { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }], savedAt: 1 },
    { type: 'user_prompt', text: WORDS, at: 10 },
    { type: 'acp_update', at: 11, update: chunk('先看提交…') },
  ]
  let state = beginning.reduce(reduce, initialState)
  const dispatch = (action: DispatchAction) => { state = reduce(state, action) }
  const said = { toasts: [] as string[] }
  const deliver = (event: AgentEvent) => {
    if (event.type === 'update') dispatch({ type: 'acp_update', update: event.update, at: 50 })
    if (event.type === 'task_update') dispatch({ type: 'task_update', taskId: event.taskId, update: event.update, at: 50,
      runId: event.runId, seq: event.taskSeq })
    if (event.type === 'task_snapshot') dispatch({ type: 'task_snapshot', snapshot: event.snapshot })
  }
  const actions = createTaskActions({
    api: { finishedTasks: async () => [], answerQuestion: async () => false, stopTask: async () => {},
      closeTask: async () => {}, ...api },
    getState: () => state,
    dispatch,
    showToast: text => { said.toasts.push(text) },
    errorMessage: error => error instanceof Error ? error.message : String(error),
    deliver,
  })
  const arrive = (event: FixtureEvent) => deliver(event)
  return { actions, said, arrive, dispatch, state: () => state }
}

const started = { id: 's1', segmentId: 'c9', title: WORDS, words: WORDS }
/** The snapshot the backend sends as the agent starts a task (task-runtime.ts): the one that makes it. */
const begins: FixtureEvent = { type: 'task_snapshot', snapshot: { taskId: 's1', runId: 'run-1', title: WORDS, status: 'running', currentAction: null, waitingFor: null,
  startedAt: 10, updatedAt: 10, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0,
  opening: { words: WORDS, task: started, hostSession: 'main' } } }

/** A task the agent started, saying something: a task in the background to work with. */
function withTask(win: ReturnType<typeof windowWith>) {
  win.arrive(begins)
  win.dispatch({ type: 'task_update', taskId: 's1', runId: 'run-1', seq: 1, update: chunk('先看提交…'), at: 20 })
}

const position = (win: ReturnType<typeof windowWith>) => {
  const task = win.state().tasks.list[0]
  return { taskId: task.id, runId: task.runId!, seq: (task.seq ?? 0) + 1 }
}

test('a task is made by the snapshot that begins it, before what it says; each piece of its run is taken once', () => {
  const win = windowWith({})
  // The backend's order (task-runtime.ts): the snapshot that makes it, then its first piece.
  win.arrive(begins)
  // Each as the event core sends it: its own `seq` (the event log's) beside the task's `taskSeq`.
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 1, update: chunk('三组改动。') })
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 1, update: chunk('三组改动。') })
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-0', taskSeq: 2, update: chunk('别的运行说的') })
  assert.equal(win.state().tasks.list.length, 1, 'one task')
  assert.deepEqual(taskMessages(liveTasks(win.state())[0]).map((m) => m.text), [WORDS, '三组改动。'], 'each piece once; one of another run left out')
  assert.deepEqual(win.state().messages.map((m) => m.text), ['做周报', '写好了', WORDS, '先看提交…'], 'the conversation on screen as it was')
})

test('a task\'s question is answered there: one choice by picking it, more with 提交, or skipped', async () => {
  const answered: Array<Parameters<TasksApi['answerQuestion']>> = []
  const win = windowWith({ answerQuestion: async (...args) => { answered.push(args); return true } })
  withTask(win)
  const city = { id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }
  win.dispatch({ type: 'task_question', ...position(win), questionId: 'q1', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'q1', 'city', '上海')
  await Promise.resolve()

  win.dispatch({ type: 'task_question', ...position(win), questionId: 'q2', questions: [city, { ...city, id: 'day', question: '哪天？' }], at: 71 })
  win.actions.pickTaskOption('s1', 'q2', 'day', '北京')
  win.actions.submitTaskAnswer('s1', 'q2')
  await Promise.resolve()
  win.dispatch({ type: 'task_question', ...position(win), questionId: 'q3', questions: [city], at: 72 })
  win.actions.skipTaskQuestion('s1', 'q3')
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
  win.dispatch({ type: 'task_question', ...position(win), questionId: 'q-full', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'q-full', 'city', '上海')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(liveTasks(win.state())[0].question?.questionId, 'q-full', 'question prompt stays intact on refusal')
  assert.match(win.said.toasts.at(-1) ?? '', /最多 5 个/)
})

test('a task answer is still recorded in messages and timeline even when task_question_closed arrives before IPC resolves', async () => {
  let resolveAnswer!: (accepted: boolean) => void
  const win = windowWith({ answerQuestion: () => new Promise((resolve) => { resolveAnswer = resolve }) })
  withTask(win)
  const city = { id: 'city', question: '哪个城市？', multiSelect: false, options: [{ label: '上海' }, { label: '北京' }] }
  win.dispatch({ type: 'task_question', ...position(win), questionId: 'q-race', questions: [city], at: 70 })
  win.actions.pickTaskOption('s1', 'q-race', 'city', '上海')
  // Backend emits task_question_closed BEFORE the IPC promise resolves.
  win.dispatch({ type: 'task_question_closed', ...position(win), questionId: 'q-race', at: 71 })
  assert.equal(liveTasks(win.state())[0].question, null)
  resolveAnswer(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const task = liveTasks(win.state())[0]
  assert.equal(taskMessages(task).at(-1)?.text, '上海')
  const entries = task.view.timeline.filter((entry) => entry.kind === 'answer' && entry.ref === 'q-race')
  assert.equal(entries.length, 1, 'replaces premature closed entry instead of duplicating')
  assert.equal(entries[0]?.kind === 'answer' && entries[0].answered, true)
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
  const resumed: string[] = []
  let nextResult: Awaited<ReturnType<NonNullable<TasksApi['resumeTask']>>> = { ok: true }
  const interruptedTask: Awaited<ReturnType<TasksApi['finishedTasks']>>[number] = {
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


test('an outdated question cannot change the next task question and mixed answers use the task draft', async () => {
  const submitted: Array<Parameters<TasksApi['answerQuestion']>> = []
  const win = windowWith({ answerQuestion: async (...args) => { submitted.push(args); return true } })
  withTask(win)
  const choice = { id: 'env', question: '哪个环境？', options: [{ label: '测试' }], multiSelect: false }
  const open = { id: 'reason', question: '为什么？', options: [], multiSelect: false }
  win.dispatch({ type: 'task_question', ...position(win), questionId: 'old', questions: [choice, open], at: 70 })
  win.actions.inputTaskAnswer('s1', 'old', 'reason', '旧草稿')
  win.dispatch({ type: 'task_question_closed', ...position(win), questionId: 'old', at: 71 })
  win.dispatch({ type: 'task_question', ...position(win), questionId: 'new', questions: [choice, open], at: 72 })
  const foreground = win.state().question
  win.actions.pickTaskOption('s1', 'old', 'env', '测试')
  win.actions.inputTaskAnswer('s1', 'old', 'reason', '迟到')
  win.actions.submitTaskAnswer('s1', 'old')
  win.actions.skipTaskQuestion('s1', 'old')
  assert.deepEqual(submitted, [])
  assert.equal(win.state().tasks.list[0].question?.questionId, 'new')
  assert.equal(win.state().tasks.list[0].question?.custom, undefined)

  win.actions.pickTaskOption('s1', 'new', 'env', '测试')
  win.actions.inputTaskAnswer('s1', 'new', 'reason', '验证安装包')
  win.actions.submitTaskAnswer('s1', 'new')
  await Promise.resolve()
  assert.deepEqual(submitted, [['new', [{ id: 'env', selected: ['测试'] }, { id: 'reason', selected: [], custom: '验证安装包' }]]])
  assert.equal(win.state().question, foreground)
})
