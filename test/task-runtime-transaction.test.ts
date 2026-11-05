import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEffects } from '../src/backend/effects.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createTaskRuntime, KEEP_ENDED } from '../src/backend/task-runtime.ts'
import { createTaskStore, type StoredTask } from '../src/backend/task-store.ts'
import type { TaskSnapshot } from '../src/backend/task-registry.ts'

/**
 * TaskRuntime over the real thing (system-design §11.2): one app database holding the history, the task store and
 * the events, and the event core's apply, as compose.ts wires them. A change that cannot be written leaves nothing:
 * not in the database, and not in memory. dsh says a turn ended once, so an end not kept is tried again (its waits
 * run here by hand), for that run only, and its result goes back to the conversation only once it is kept.
 */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
type Started = { ok: true, task: { id: string, segmentId: string } }

/** `uncancelled`: a try once asked for runs even if let go, to see that the run alone guards it. */
function setup(t: TestContext, { uncancelled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-tx-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  /** What reaches the window: the runtime's pushes by way of the event core, as compose.ts sends them (emitToRenderer). */
  const window: Array<Record<string, unknown>> = []
  const core = createEventCore({ app, publish: (push) => { window.push(push) } })
  const effects = createEffects({ db: app.db, apply: (kind, data, write) => core.apply(kind, data, write) })
  const history = openHistoryDb({ db: app.db })
  const main = history.save(history.create({ sessionId: 'main', cwd: '/w' }), [{ role: 'user', text: '做周报', receipt: null }])
  /** Writes that fail, as a full disk would: the task store's ending, or what the task said. */
  const failing = { ending: false, words: false }
  const realStore = createTaskStore({ db: app.db })
  const store = {
    ...realStore,
    add: (task: StoredTask) => {
      if (failing.ending && Number.isFinite(task.endedAt)) throw new Error('disk full')
      realStore.add(task)
    },
  }
  const db = Object.assign(Object.create(null), history, {
    save: (...args: Parameters<typeof history.save>) => {
      if (failing.words) throw new Error('disk full')
      return history.save(...args)
    },
  }) as typeof history
  const snapshots: TaskSnapshot[] = []
  /** Sessions let go (agent.closeTask). */
  const closed: string[] = []
  /** Ends kept, as compose.ts hears of them to report their results. */
  const reported: Array<[string, string]> = []
  /** Waits the runtime asked for (tries again, saves along the way): run by hand. */
  let due: Array<() => void> = []
  const runDue = () => { const runs = due; due = []; runs.forEach((run) => run()) }
  let runs = 0
  const make = () => createTaskRuntime({
    db, store, current: () => main, agentInfo: () => ({ mode: 'live', model: 'V4' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: 'task-0001' }), promptTask: () => {}, steerTask: () => ({ ok: true }),
      resumeTask: () => ({ ok: true }), cancelTask: () => {}, closeTask: (taskId: string) => { closed.push(taskId) },
    },
    apply: (kind, data, write) => core.apply(kind, data, write),
    publish: (push) => {
      if (push.type === 'task_snapshot') snapshots.push((push as { snapshot: TaskSnapshot }).snapshot)
      core.transient(push)
    },
    onEnd: (taskId, status) => { reported.push([taskId, status]) },
    effects,
    newRunId: () => `run-${++runs}`,
    timers: {
      later: (run: () => void) => { due = [...due, run]; return run },
      cancel: (timer: unknown) => { if (!uncancelled) due = due.filter((run) => run !== timer) },
    },
  })
  const tasks = make()
  const status = (runtime = tasks) => (runtime.agent.query({ op: 'get', taskId: 'task-0001' }, { taskId: 'task-0001' }) as { task: { status: string } }).task.status
  const kept = () => realStore.list().find((entry) => entry.id === 'task-0001')
  const ended = () => core.since(0).filter((event) => event.kind === 'task.ended')
  const reports = () => effects.list().filter((effect) => effect.kind === 'report').map((effect) => effect.key)
  return { window, closed, tasks, make, failing, snapshots, reported, runDue, due: () => due.length, status, kept, ended, history, reports, store: realStore, effects: () => effects.list() }
}

test('a task\'s end that cannot be kept leaves nothing, in the database or in memory, and is kept on a later try', async (t) => {
  const { tasks, failing, snapshots, reported, runDue, status, kept, ended } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('写好了。') })
  failing.ending = true
  const before = snapshots.length
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(kept()?.endedAt, undefined, 'not kept as ended')
  assert.equal(ended().length, 0, 'no task.ended event')
  assert.equal(status(), 'running', 'still at work in memory')
  assert.equal(snapshots.length, before, 'the window was told nothing')
  assert.deepEqual(reported, [], 'no result reported for an end not kept')
  runDue()
  assert.equal(ended().length, 0, 'refused again: still nothing')

  failing.ending = false
  runDue()
  assert.deepEqual([kept()?.status, Number.isFinite(kept()?.endedAt)], ['done', true], 'kept on the next try, dsh saying nothing more')
  assert.equal(ended().length, 1)
  assert.equal(snapshots.at(-1)?.status, 'done')
  assert.deepEqual(reported, [[task.id, 'done']], 'its result reported once, after it is kept')
})

test('what the task said cannot be saved: its end is not kept either', async (t) => {
  const { tasks, failing, runDue, status, kept, ended, history } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('写好了。') })
  failing.words = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(kept()?.endedAt, undefined)
  assert.equal(ended().length, 0)
  assert.equal(status(), 'running')

  failing.words = false
  runDue()
  assert.equal(kept()?.status, 'done')
  assert.deepEqual(history.get(task.segmentId)?.messages.map((message) => message.text), ['整理发布说明', '写好了。'], 'its words saved with its end')
})

test('a task\'s run is kept with it: after a relaunch it is the run it ended with; asked again, a new one is kept', async (t) => {
  const { tasks, make, kept } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  assert.equal(kept()?.runId, 'run-1', 'kept as it starts')
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(kept()?.runId, 'run-1', 'and as it ends')
  const later = make()
  const restored = later.agent.query({ op: 'get', taskId: task.id }, { taskId: task.id }) as { task: { runId: string } }
  assert.equal(restored.task.runId, 'run-1', 'back after a relaunch')
  await later.agent.message(task.id, '再加上已知问题')
  assert.equal(kept()?.runId, 'run-2', '接着问: a run of its own, kept')
})

test('dsh restarting while an end is still to be kept: the end is kept on its next try, the task not interrupted', async (t) => {
  const { tasks, failing, runDue, due, status, kept, ended, reported } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  failing.ending = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  tasks.dsh.gone()
  assert.equal(status(), 'running', 'its end came: not interrupted')
  assert.ok(due() > 0, 'the try is still there')
  failing.ending = false
  runDue()
  assert.deepEqual([ended().length, status(), kept()?.status, kept()?.runId], [1, 'done', 'done', 'run-1'])
  assert.deepEqual(reported, [[task.id, 'done']])
})

test('closing a task lets its end still to be kept go', async (t) => {
  const { tasks, failing, runDue, due, ended, reported } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  failing.ending = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  await tasks.window.close(task.id)
  failing.ending = false
  runDue()
  assert.deepEqual([due(), ended().length, reported.length], [0, 0, 0])
})

test('a try that runs after its run was replaced ends nothing: the run guards it, not only its cancelling', async (t) => {
  const { tasks, failing, runDue, due, status, kept, ended, reported } = setup(t, { uncancelled: true })
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  failing.ending = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  tasks.dsh.gone()
  failing.ending = false
  await tasks.agent.message(task.id, '接着做')
  assert.ok(due() > 0, 'the old try is still there')
  runDue()
  assert.deepEqual([ended().length, status(), kept()?.runId, reported.length], [0, 'running', 'run-2', 0])
})

test('a run\'s end queues its report in the same transaction: an end not kept queues none', async (t) => {
  const { tasks, failing, runDue, reports, effects } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  failing.ending = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.deepEqual(reports(), [], 'no report for an end not kept')
  failing.ending = false
  runDue()
  assert.deepEqual(reports(), [`${task.id}:run-1`], 'kept with its end, keyed by its run')
  const [queued] = effects().filter((effect) => effect.kind === 'report')
  const payload = queued.payload as { request: string, topic: string | null, by: string, startedAt: number, token: string }
  assert.deepEqual([payload.request, payload.by, typeof payload.startedAt], ['整理发布说明', 'user', 'number'], 'its background kept with it: what it was asked, by whom, when')
  assert.match(payload.token, /^[0-9a-f]{32}$/, 'and a token no one else knows')
})

test('a new run, or the task closed, lets the report of the run before go; a report is there after a relaunch', async (t) => {
  const { tasks, make, reports } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  const later = make()
  assert.deepEqual(reports(), [`${task.id}:run-1`], 'still there after a relaunch')
  assert.equal(later.reports.superseded(task.id, 'run-1'), false, 'and still to be reported: the run it ended with')
  await later.agent.message(task.id, '再加上已知问题')
  assert.deepEqual(reports(), [], '接着问: the old result is not reported')
  assert.equal(later.reports.superseded(task.id, 'run-1'), true)
  later.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.deepEqual(reports(), [`${task.id}:run-2`])
  await later.window.close(task.id)
  assert.deepEqual(reports(), [], 'closed: nothing left to report')
})

test('a task let go among the oldest ended still has its result reported: only a new run or closing it makes it moot', async (t) => {
  const { tasks, store, reports } = setup(t)
  // The latest kept have ended later than this one will: it is the oldest, let go as it ends.
  for (let i = 0; i < KEEP_ENDED; i++) store.add({ id: `kept-${i}`, segmentId: 'seg', title: `${i}`, endedAt: Date.now() + 1e9 + i, status: 'done' })
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(store.list().some((entry) => entry.id === task.id), false, 'let go from the store')
  assert.deepEqual(reports(), [`${task.id}:run-1`], 'its report still queued')
  assert.equal(tasks.reports.superseded(task.id, 'run-1'), false, 'and not moot: it is reported')
})

test('a task let go among the oldest ended, then closed by the user: its report goes with it', async (t) => {
  const { tasks, store, reports } = setup(t)
  for (let i = 0; i < KEEP_ENDED; i++) store.add({ id: `kept-${i}`, segmentId: 'seg', title: `${i}`, endedAt: Date.now() + 1e9 + i, status: 'done' })
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(store.list().some((entry) => entry.id === task.id), false, 'let go from the store')
  assert.deepEqual(reports(), [`${task.id}:run-1`])
  await tasks.window.close(task.id)
  assert.deepEqual(reports(), [], 'closed: its report cancelled though its row was gone')
})

test('through the event core to the window, a piece keeps its own number: the push\'s `seq` is the event log\'s, `taskSeq` the task\'s', async (t) => {
  const { tasks, window } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('先看') })
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('提交') })
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  const pieces = window.filter((push) => push.taskId === task.id && push.type !== 'task_snapshot')
  assert.deepEqual(pieces.map((push) => [push.type, push.taskSeq]), [['task_update', 1], ['task_update', 2], ['task_end', 3]], 'numbered by the task, as they went')
  assert.ok(pieces.every((push) => typeof push.seq === 'number'), 'each also carries the event log\'s number, which is not the task\'s')
  const last = window.filter((push) => push.type === 'task_snapshot').at(-1) as { snapshot: { taskSeq: number, status: string } }
  assert.deepEqual([last.snapshot.status, last.snapshot.taskSeq], ['done', 3], 'the snapshot of its end includes it')
})

test('a task whose start cannot be kept: its session let go, its place given back, nothing of it kept', async (t) => {
  const { tasks, failing, closed, store } = setup(t)
  failing.words = true
  await assert.rejects(tasks.window.start({ text: '整理发布说明' }), /disk full/)
  assert.deepEqual(closed, ['task-0001'], 'the session dsh made for it, let go')
  assert.deepEqual(store.list(), [], 'no task kept')
  failing.words = false
  const again = await tasks.window.start({ text: '整理发布说明' }) as Started
  assert.equal(again.ok, true, 'its place given back')
})
