import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createTaskActions } from '../src/renderer/task-actions.ts'
import { taskMessages } from '../src/renderer/tasks-state.ts'

/**
 * A window that opens while tasks go on (task-actions.ts loadKept): the read of the tasks and the live channel hand
 * over without a gap. What comes of any task on the live channel while it is read waits and follows the read. A task
 * the window knows already keeps what it has, with what it did; the others are put back to the read, each piece it
 * had left out by its number. More than can wait came: read again, until a read comes back, and taken for all.
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
function windowWith(reads: Array<Promise<unknown>>, waited: number[] = []) {
  let state = initialState as ReturnType<typeof reduce>
  const dispatch = (action: Event) => { state = reduce(state, action) }
  let asked = 0
  const toAction: Record<string, (event: Event) => Event> = {
    task_snapshot: (event) => ({ type: 'task_snapshot', snapshot: event.snapshot }),
    task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: 5, runId: event.runId, seq: event.taskSeq }),
    task_end: (event) => ({ type: 'task_end', taskId: event.taskId, stopReason: event.stopReason, at: 9, runId: event.runId, seq: event.taskSeq }),
    task_steered: (event) => ({ type: 'task_steer', taskId: event.taskId, text: event.text, at: 6, runId: event.runId, seq: event.taskSeq }),
  }
  const deliver = (event: Event) => dispatch(toAction[String(event.type)](event))
  const actions = createTaskActions({
    api: { finishedTasks: () => reads[asked++] } as never,
    getState: () => state, dispatch, showToast: () => {}, errorMessage: (err: unknown) => String(err), deliver,
    wait: async (ms: number) => { waited.push(ms) },
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
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 3, revision: 3 }))
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

test('a read is the baseline for the tasks it has; a snapshot no newer than what the window has changes nothing', async () => {
  const win = windowWith([Promise.resolve([{ ...running(1), mark: { runId: 'run-1', seq: 1, revision: 4 } }])])
  await win.actions.loadKept()
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 2, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 2, revision: 6 }))
  assert.deepEqual([win.state().tasks.list[0].status, win.state().tasks.list[0].seq], ['done', 2])
  win.dispatch(snapshot({ status: 'running', taskSeq: 1, revision: 5 }))
  assert.equal(win.state().tasks.list[0].status, 'done', 'an older snapshot does not put it back at work')
  win.dispatch({ type: 'tasks_restored', list: [done(5)] })
  assert.equal(win.state().tasks.list[0].seq, 5, 'a read puts the tasks it has to what it says')
})

test('a task known while the read is under way: its words that came meanwhile (no snapshot after them) wait, and follow the read', async () => {
  const read = deferred<unknown>()
  const win = windowWith([read.promise])
  // Started from this window as the read began: made by its first snapshot, so known, its pieces taken as they come.
  win.arrive(snapshot({ revision: 1, taskSeq: 0, opening: { words: '整理发布说明', task: summary, hostSession: null } }))
  const loading = win.actions.loadKept()
  for (let n = 1; n <= 11; n++) win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: n, update: chunk(`${n}、`) })
  // The read was made at piece 10, after many changes (revision 11); piece 11 came before its answer.
  // As the backend gives a task held (task-words.ts current): the answer it is writing, marked open.
  const reading = running(10, 'run-1', ['整理发布说明', '1、2、3、4、5、6、7、8、9、10、'])
  read.resolve([{ ...reading, messages: [reading.messages[0], { ...reading.messages[1], open: true }], mark: { runId: 'run-1', seq: 10, revision: 11 } }])
  await loading
  const [task] = win.state().tasks.list
  assert.equal(task.seq, 11, 'its last piece, the window\'s')
  assert.deepEqual(texts(win.state()), ['整理发布说明', '1、2、3、4、5、6、7、8、9、10、11、'], 'no word lost, none twice')
})

test('the read has a later run already: the older run\'s beginning, end and pieces that waited change nothing, the later run\'s new words are taken once', async () => {
  const read = deferred<unknown>()
  const win = windowWith([read.promise])
  const loading = win.actions.loadKept()
  const begins = (runId: string, taskSeq: number, revision: number, words: string, extra = {}) =>
    snapshot({ runId, taskSeq, revision, startedAt: revision, opening: { words, task: summary, hostSession: null }, ...extra })
  // All of it on the live channel while the read was under way: run 1 begun, said, ended; run 2 begun (its first
  // snapshot saying the same last piece, 4, as run 1's end), said; then one piece more of run 2, after the read.
  win.arrive(begins('run-1', 0, 2, '整理发布说明'))
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 3, update: chunk('写好了。') })
  win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 4, stopReason: 'end_turn' })
  win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 4, revision: 5 }))
  win.arrive(begins('run-2', 4, 6, '再加上已知问题'))
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-2', taskSeq: 5, update: chunk('加好了。') })
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-2', taskSeq: 6, update: chunk('还有一处。') })
  // The read: run 2 at work, up to piece 5 and revision 8.
  read.resolve([{ ...running(5, 'run-2', ['整理发布说明', '先看提交…写好了。', '再加上已知问题', '加好了。']), mark: { runId: 'run-2', seq: 5, revision: 8 } }])
  await loading
  const [task] = win.state().tasks.list
  assert.deepEqual([task.status, task.runId, task.seq, task.endedAt], ['running', 'run-2', 6, null], 'at work on run 2, not put back to run 1 nor ended')
  assert.deepEqual(texts(win.state()), ['整理发布说明', '先看提交…写好了。', '再加上已知问题', '加好了。', '还有一处。'],
    'no question twice, no word twice; the piece after the read taken')
})

test('more came during the read than can wait, and the read after fails: it is tried again, after a wait, till one comes back', async () => {
  const first = deferred<unknown>()
  const waited: number[] = []
  const win = windowWith([first.promise, Promise.reject(new Error('gone')), Promise.reject(new Error('gone')), Promise.resolve([done(2_003)])], waited)
  const loading = win.actions.loadKept()
  const errors: unknown[] = []
  const logged = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    // Its end and the snapshot that says so are among what was let go.
    for (let n = 2; n <= 2_002; n++) win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: n, update: chunk('字') })
    win.arrive({ type: 'task_end', taskId: 's1', runId: 'run-1', taskSeq: 2_003, stopReason: 'end_turn' })
    win.arrive(snapshot({ status: 'done', endedAt: 9, taskSeq: 2_003, revision: 3 }))
    first.resolve([running(1)])
    await loading
  } finally {
    console.error = logged
  }
  const [task] = win.state().tasks.list
  assert.deepEqual([win.asked(), waited], [4, [500, 1_000]], 'read again till it came back, waiting longer each time')
  assert.deepEqual([task.status, task.seq, task.endedAt], ['done', 2_003, 9], 'its end, let go meanwhile, is the read\'s')
  assert.equal(errors.length, 3, 'said each time')
})

test('a task the window knows, its tool at work, nothing of it during the read: it keeps what it did', async () => {
  const win = windowWith([Promise.resolve([{ ...running(1, 'run-1', ['整理发布说明']), mark: { runId: 'run-1', seq: 1, revision: 1 } }])])
  win.arrive(snapshot({ revision: 1, taskSeq: 0, opening: { words: '整理发布说明', task: summary, hostSession: null } }))
  win.arrive({ type: 'task_update', taskId: 's1', runId: 'run-1', taskSeq: 1,
    update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: '读提交记录', status: 'in_progress' } })
  const before = win.state().tasks.list[0]
  await win.actions.loadKept()
  const [task] = win.state().tasks.list
  assert.deepEqual([task.now, Object.keys(task.view.tools), task.view.timeline.map((entry) => entry.kind)], [before.now, ['t1'], ['tool']],
    'its tool still at work, not 思考中')
  assert.equal(task.now, '读提交记录')
  assert.deepEqual(texts(win.state()), ['整理发布说明'])
})

test('words the agent said into a task the read has already: not shown twice; those after it, once', async () => {
  const read = deferred<unknown>()
  const win = windowWith([read.promise])
  const loading = win.actions.loadKept()
  win.arrive({ type: 'task_steered', taskId: 's1', runId: 'run-1', taskSeq: 2, text: '加上版本号' })
  win.arrive({ type: 'task_steered', taskId: 's1', runId: 'run-1', taskSeq: 3, text: '还有已知问题' })
  read.resolve([running(2, 'run-1', ['整理发布说明', '先看提交…', '加上版本号'])])
  await loading
  assert.deepEqual(texts(win.state()), ['整理发布说明', '先看提交…', '加上版本号', '还有已知问题'])
})
