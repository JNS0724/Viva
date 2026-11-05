import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
import { taskMessages } from '../src/renderer/tasks-state.ts'

/**
 * A window that opens while tasks go on (task-actions.ts loadKept): the read of the tasks and the live channel hand
 * over without a gap. What comes of a task on the live channel while it is read is not taken (the window does not know
 * the task yet); a read that comes back behind that is read again, and a read never puts back a task the window has
 * newer.
 */

type Event = Record<string, any>
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const summary = { id: 's1', segmentId: 'c-task', title: '整理发布说明', words: '整理发布说明' }
const running = (seq: number, runId = 'run-1', said = ['整理发布说明', '先看提交…']) =>
  ({ task: summary, status: 'running', endedAt: null, startedAt: 1, waits: { permissions: [], questions: [] }, mark: { runId, seq },
    messages: said.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text, receipt: null })) })
const done = (seq: number) => ({ task: summary, status: 'done', endedAt: 9, mark: { runId: 'run-1', seq },
  messages: [{ role: 'user', text: '整理发布说明', receipt: null }, { role: 'assistant', text: '先看提交…写好了。', receipt: null }] })
const snapshot = (fields: Record<string, unknown>) => ({ type: 'task_snapshot', snapshot: { taskId: 's1', runId: 'run-1', title: summary.title,
  status: 'running', currentAction: null, waitingFor: null, startedAt: 1, updatedAt: 1, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0, ...fields } })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** A window over the real reducer, its reads of the tasks answered when the test likes; events as app.ts takes them. */
function windowWith(reads: Array<Promise<unknown>>) {
  let state = initialState as ReturnType<typeof reduce>
  const dispatch = (action: Event) => { state = reduce(state, action) }
  let asked = 0
  const actions = createTaskActions({
    api: { finishedTasks: () => reads[asked++] } as never,
    getState: () => state, dispatch, showToast: () => {}, errorMessage: (err: unknown) => String(err),
  })
  const toAction: Record<string, (event: Event) => Event> = {
    task_snapshot: (event) => ({ type: 'task_snapshot', snapshot: event.snapshot }),
    task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: 5, runId: event.runId, seq: event.taskSeq }),
    task_end: (event) => ({ type: 'task_end', taskId: event.taskId, stopReason: event.stopReason, at: 9, runId: event.runId, seq: event.taskSeq }),
  }
  const arrive = (event: Event) => { actions.saw(event); dispatch(toAction[event.type](event)) }
  return { actions, arrive, dispatch, state: () => state, asked: () => asked }
}

test('read while the task ends: its end and last snapshot come first, not taken; the read behind them is read again', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const win = windowWith([first.promise, second.promise])
  const loading = win.actions.loadKept()
  // The read saw it at work at 1; then, on the live channel, it said more, ended, and its snapshot says so.
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 2, update: chunk('写好了。') })
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 3, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 3 }))
  first.resolve([running(1)])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(win.asked(), 2, 'behind the live channel: read again')
  assert.deepEqual(win.state().tasks.list, [], 'the read behind is not taken')
  second.resolve([done(3)])
  await loading
  const [task] = win.state().tasks.list
  assert.deepEqual([task.status, task.seq], ['done', 3], 'ended, as it is, not left at work')
  assert.deepEqual(taskMessages(task).map((m: { text: string }) => m.text), ['整理发布说明', '先看提交…写好了。'])
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 3, update: chunk('重复的') })
  assert.deepEqual(taskMessages(win.state().tasks.list[0]).map((m: { text: string }) => m.text), ['整理发布说明', '先看提交…写好了。'], 'what the read had is not taken again')
})

test('read while a new run begins: the read of the run before is read again, then the new run\'s pieces are taken', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const win = windowWith([first.promise, second.promise])
  const loading = win.actions.loadKept()
  // Asked again meanwhile: the snapshot that begins run 2 (nothing of it said yet: still 4).
  win.arrive(snapshot({ runId: 'run-2', taskSeq: 4, startedAt: 7, opening: { words: '再加上已知问题' } }))
  first.resolve([done(4)])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(win.asked(), 2, 'another run on the live channel: read again')
  second.resolve([running(4, 'run-2', ['整理发布说明', '先看提交…写好了。', '再加上已知问题'])])
  await loading
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-2', taskSeq: 5, update: chunk('加好了。') })
  const [task] = win.state().tasks.list
  assert.deepEqual([task.status, task.runId], ['running', 'run-2'])
  assert.equal(taskMessages(task).at(-1)?.text, '加好了。', 'the new run\'s words taken')
})

test('a read not behind is taken at once, once; a read that comes back later than what the window has puts nothing back', async () => {
  const win = windowWith([Promise.resolve([running(1)])])
  await win.actions.loadKept()
  assert.equal(win.asked(), 1)
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 2, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 2 }))
  win.dispatch({ type: 'tasks_restored', list: [running(1)] })
  assert.deepEqual([win.state().tasks.list[0].status, win.state().tasks.list[0].seq], ['done', 2], 'an older read does not put it back at work')
  win.dispatch({ type: 'tasks_restored', list: [done(5)] })
  assert.equal(win.state().tasks.list[0].seq, 5, 'a newer read is taken')
})
