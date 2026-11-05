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
  const toAction: Record<string, (event: Event) => Event> = {
    task_snapshot: (event) => ({ type: 'task_snapshot', snapshot: event.snapshot }),
    task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: 5, runId: event.runId, seq: event.taskSeq }),
    task_end: (event) => ({ type: 'task_end', taskId: event.taskId, stopReason: event.stopReason, at: 9, runId: event.runId, seq: event.taskSeq }),
  }
  const deliver = (event: Event) => dispatch(toAction[String(event.type)](event))
  const actions = createTaskActions({
    api: { finishedTasks: () => reads[asked++] } as never,
    getState: () => state, dispatch, showToast: () => {}, errorMessage: (err: unknown) => String(err), deliver,
  })
  // As app.ts takes an event: held while the tasks are read, else reduced.
  const arrive = (event: Event) => { if (!actions.hold(event)) deliver(event) }
  return { actions, arrive, dispatch, state: () => state, asked: () => asked }
}

const texts = (state: ReturnType<typeof reduce>) => taskMessages(state.tasks.list[0]).map((m: { text: string }) => m.text)

test('read while the task goes on and ends: what came meanwhile waits, then is taken after the read, each piece once', async () => {
  const read = deferred<unknown>()
  const win = windowWith([read.promise])
  const loading = win.actions.loadKept()
  // The read is of it at work at 1 (it has said 先看提交…). Meanwhile, on the live channel: a piece the read had
  // already (1), more, its end, and the snapshot that says so.
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 1, update: chunk('先看提交…') })
  win.arrive(snapshot({ taskSeq: 1 }))
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 2, update: chunk('写好了。') })
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 3, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 3 }))
  assert.deepEqual(win.state().tasks.list, [], 'nothing of it taken before the read')
  read.resolve([running(1)])
  await loading
  assert.equal(win.asked(), 1, 'one read')
  const [task] = win.state().tasks.list
  assert.deepEqual([task.status, task.seq], ['done', 3], 'ended, as it is, not left at work')
  // A restored answer is closed: what it says after the read goes on in a message of its own, as it always has.
  assert.deepEqual(texts(win.state()), ['整理发布说明', '先看提交…', '写好了。'], 'what the read had once, what came after it after')
})

test('busy all through the read, its end among what came: one read is enough, and it ends', async () => {
  const read = deferred<unknown>()
  const win = windowWith([read.promise])
  const loading = win.actions.loadKept()
  for (let n = 2; n <= 40; n++) win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: n, update: chunk('字') })
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 41, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 41 }))
  // The read was made in the middle of it: at 20.
  read.resolve([running(20, 'run-1', ['整理发布说明', `先看提交…${'字'.repeat(19)}`])])
  await loading
  const [task] = win.state().tasks.list
  assert.deepEqual([win.asked(), task.status, task.seq], [1, 'done', 41])
  assert.equal(texts(win.state()).slice(1).join('').split('字').length - 1, 39, 'each word once: those the read had left out, the rest taken')
})

test('read while a new run begins: the run before is read, the new run then taken from what waited, and its words after', async () => {
  const read = deferred<unknown>()
  const win = windowWith([read.promise])
  const loading = win.actions.loadKept()
  win.arrive(snapshot({ runId: 'run-2', taskSeq: 4, startedAt: 7, opening: { words: '再加上已知问题' } }))
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-2', taskSeq: 5, update: chunk('加好了。') })
  read.resolve([done(4)])
  await loading
  const [task] = win.state().tasks.list
  assert.deepEqual([task.status, task.runId, win.asked()], ['running', 'run-2', 1])
  assert.deepEqual(texts(win.state()), ['整理发布说明', '先看提交…写好了。', '再加上已知问题', '加好了。'])
})

test('more came during the read than can wait: the read is not taken, and is begun again', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const win = windowWith([first.promise, second.promise])
  const loading = win.actions.loadKept()
  const errors: unknown[] = []
  const logged = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    for (let n = 2; n <= 2_002; n++) win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: n, update: chunk('字') })
    first.resolve([running(1)])
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual([win.asked(), win.state().tasks.list.length], [2, 0], 'begun again, the first read not taken')
    second.resolve([done(2_002)])
    await loading
  } finally {
    console.error = logged
  }
  assert.deepEqual([win.state().tasks.list[0].status, win.state().tasks.list[0].seq], ['done', 2_002])
  assert.equal(errors.length, 1, 'said once')
})

test('a read that comes back later than what the window has puts nothing back', async () => {
  const win = windowWith([Promise.resolve([running(1)])])
  await win.actions.loadKept()
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 2, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 2 }))
  win.dispatch({ type: 'tasks_restored', list: [running(1)] })
  assert.deepEqual([win.state().tasks.list[0].status, win.state().tasks.list[0].seq], ['done', 2], 'an older read does not put it back at work')
  win.dispatch(snapshot({ status: 'running', taskSeq: 1 }))
  assert.equal(win.state().tasks.list[0].status, 'done', 'nor an older snapshot')
  win.dispatch({ type: 'tasks_restored', list: [done(5)] })
  assert.equal(win.state().tasks.list[0].seq, 5, 'a newer read is taken')
})
