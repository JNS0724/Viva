import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEffects } from '../src/backend/effects.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { openIndependentHistory as openHistoryDb } from './fixtures/independent-history.ts'
import { createTaskRuntime, KEEP_ENDED } from '../src/backend/task-runtime.ts'
import { createTaskStore, type StoredTask } from '../src/backend/task-store.ts'
import type { TaskSnapshot } from '../src/backend/task-registry.ts'
import type { MemoryProvenance } from '../src/memory/contracts/provenance.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'

/**
 * TaskRuntime over the real thing (system-design §11.2): one app database holding the history, the task store and
 * the events, and the event core's apply, as compose.ts wires them. A change that cannot be written leaves nothing:
 * not in the database, and not in memory. dsh says a turn ended once, so an end not kept is tried again (its waits
 * run here by hand), for that run only, and its result goes back to the conversation only once it is kept.
 */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
type Started = { ok: true, task: { id: string, segmentId: string } }

/** `uncancelled`: a try once asked for runs even if let go, to see that the run alone guards it. */
function setup(t: TestContext, { uncancelled = false, captureReportMemory, mainMessages = [{ role: 'user', text: '做周报', receipt: null }] }: {
  uncancelled?: boolean, captureReportMemory?: Parameters<typeof createTaskRuntime>[0]['captureReportMemory'],
  mainMessages?: Parameters<ReturnType<typeof openHistoryDb>['save']>[1],
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-tx-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  /** What reaches the window: the runtime's pushes by way of the event core, as compose.ts sends them (emitToRenderer). */
  const window: Array<Record<string, unknown>> = []
  const core = createEventCore({ app, publish: (push) => { window.push(push) } })
  const effects = createEffects({ db: app.db, apply: (kind, data, write) => core.apply(kind, data, write) })
  const history = openHistoryDb({ db: app.db })
  const main = history.save(history.create({ sessionId: 'main', cwd: '/w' }), mainMessages)
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
    effects, captureReportMemory,
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
  /** A task started as the agent starts one (start_background_task), with the segment its words are kept in. */
  const start = async (brief: string): Promise<Started> => {
    const { taskId } = await tasks.agent.start(brief)
    const entry = realStore.list().find((task) => task.id === taskId)
    assert.ok(entry, `task ${taskId} kept`)
    return { ok: true, task: { id: taskId, segmentId: entry.segmentId } }
  }
  return { start, window, closed, tasks, make, failing, snapshots, reported, runDue, main, due: () => due.length, status, kept, ended, history, reports, store: realStore, effects: () => effects.list() }
}

test('a task\'s end that cannot be kept leaves nothing, in the database or in memory, and is kept on a later try', async (t) => {
  const events: DiagnosticEvent[] = []
  t.after(installDiagnosticPort({ emit(event) { events.push(event); return undefined } }))
  const { start, tasks, failing, snapshots, reported, runDue, status, kept, ended } = setup(t)
  const { task } = await start('整理发布说明')
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('写好了。') })
  failing.ending = true
  const before = snapshots.length
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(kept()?.endedAt, undefined, 'not kept as ended')
  assert.equal(ended().length, 0, 'no task.ended event')
  assert.equal(status(), 'running', 'still at work in memory')
  assert.equal(snapshots.length, before, 'the window was told nothing')
  assert.deepEqual(reported, [], 'no result reported for an end not kept')
  assert.equal(events.some(event => event.operation === 'task' && event.stage === 'complete'), false)
  runDue()
  assert.equal(ended().length, 0, 'refused again: still nothing')

  failing.ending = false
  runDue()
  assert.deepEqual([kept()?.status, Number.isFinite(kept()?.endedAt)], ['done', true], 'kept on the next try, dsh saying nothing more')
  assert.equal(ended().length, 1)
  assert.equal(snapshots.at(-1)?.status, 'done')
  assert.deepEqual(reported, [[task.id, 'done']], 'its result reported once, after it is kept')
  assert.ok(events.some(event => event.operation === 'task' && event.stage === 'complete' && event.identities?.taskId === task.id
    && event.identities?.taskRunId === 'run-1'))
  assert.doesNotMatch(JSON.stringify(events), /整理发布说明|写好了|task-runtime-tx/)
})

test('what the task said cannot be saved: its end is not kept either', async (t) => {
  const { start, tasks, failing, runDue, status, kept, ended, history } = setup(t)
  const { task } = await start('整理发布说明')
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
  const { start, tasks, make, kept } = setup(t)
  const { task } = await start('整理发布说明')
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
  const { start, tasks, failing, runDue, due, status, kept, ended, reported } = setup(t)
  const { task } = await start('整理发布说明')
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
  const { start, tasks, failing, runDue, due, ended, reported } = setup(t)
  const { task } = await start('整理发布说明')
  failing.ending = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  await tasks.window.close(task.id)
  failing.ending = false
  runDue()
  assert.deepEqual([due(), ended().length, reported.length], [0, 0, 0])
})

test('a try that runs after its run was replaced ends nothing: the run guards it, not only its cancelling', async (t) => {
  const { start, tasks, failing, runDue, due, status, kept, ended, reported } = setup(t, { uncancelled: true })
  const { task } = await start('整理发布说明')
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
  const { start, tasks, failing, runDue, reports, effects } = setup(t)
  const { task } = await start('整理发布说明')
  failing.ending = true
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.deepEqual(reports(), [], 'no report for an end not kept')
  failing.ending = false
  runDue()
  assert.deepEqual(reports(), [`${task.id}:run-1`], 'kept with its end, keyed by its run')
  const [queued] = effects().filter((effect) => effect.kind === 'report')
  const payload = queued.payload as { request: string, topic: string | null, by: string, startedAt: number, token: string }
  assert.deepEqual([payload.request, payload.by, typeof payload.startedAt], ['整理发布说明', 'agent', 'number'], 'its background kept with it: what it was asked, by whom, when')
  assert.match(payload.token, /^[0-9a-f]{32}$/, 'and a token no one else knows')
})

test('a new run, or the task closed, lets the report of the run before go; a report is there after a relaunch', async (t) => {
  const { start, tasks, make, reports } = setup(t)
  const { task } = await start('整理发布说明')
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
  const { start, tasks, store, reports } = setup(t)
  // The latest kept have ended later than this one will: it is the oldest, let go as it ends.
  for (let i = 0; i < KEEP_ENDED; i++) store.add({ id: `kept-${i}`, segmentId: 'seg', title: `${i}`, endedAt: Date.now() + 1e9 + i, status: 'done' })
  const { task } = await start('整理发布说明')
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(store.list().some((entry) => entry.id === task.id), false, 'let go from the store')
  assert.deepEqual(reports(), [`${task.id}:run-1`], 'its report still queued')
  assert.equal(tasks.reports.superseded(task.id, 'run-1'), false, 'and not moot: it is reported')
})

test('a task let go among the oldest ended, then closed by the user: its report goes with it', async (t) => {
  const { start, tasks, store, reports } = setup(t)
  for (let i = 0; i < KEEP_ENDED; i++) store.add({ id: `kept-${i}`, segmentId: 'seg', title: `${i}`, endedAt: Date.now() + 1e9 + i, status: 'done' })
  const { task } = await start('整理发布说明')
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.equal(store.list().some((entry) => entry.id === task.id), false, 'let go from the store')
  assert.deepEqual(reports(), [`${task.id}:run-1`])
  await tasks.window.close(task.id)
  assert.deepEqual(reports(), [], 'closed: its report cancelled though its row was gone')
})

test('through the event core to the window, a piece keeps its own number: the push\'s `seq` is the event log\'s, `taskSeq` the task\'s', async (t) => {
  const { start, tasks, window } = setup(t)
  const { task } = await start('整理发布说明')
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
  const { start, tasks, failing, closed, store } = setup(t)
  failing.words = true
  await assert.rejects(start('整理发布说明'), /disk full/)
  assert.deepEqual(closed, ['task-0001'], 'the session dsh made for it, let go')
  assert.deepEqual(store.list(), [], 'no task kept')
  failing.words = false
  const again = await start('整理发布说明')
  assert.equal(again.ok, true, 'its place given back')
})

test('the completed run captures its report proof once and retains it across transaction retry', async t => {
  const witness: MemoryProvenance = { sources: ['bound-source'], epoch: 0, turnOnly: false }
  let captures = 0
  const { start, tasks, failing, effects, runDue, due } = setup(t, { captureReportMemory: async () => { captures++; return witness } })
  const { task } = await start('Captured brief')
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('Captured output') })
  failing.ending = true
  const event = { type: 'task_end', taskId: task.id, stopReason: 'end_turn' }
  tasks.dsh.receive(event)
  tasks.dsh.receive(event)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(captures, 1)
  assert(due() > 0)
  assert.equal(effects().length, 0)
  failing.ending = false
  runDue()
  const [report] = effects()
  assert.equal(report?.key, `${task.id}:run-1`)
  assert.deepEqual(report.payload && (report.payload as { memory?: unknown }).memory, witness)
  tasks.dsh.receive(event)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(captures, 1, 'a duplicate native end cannot capture a new snapshot for a completed run')
})

test('a captured task report cannot be queued by a late end after its precise evidence was erased', async t => {
  let resolveProof!: (memory: MemoryProvenance) => void
  const proof = new Promise<MemoryProvenance>(resolve => { resolveProof = resolve })
  const { start, tasks, history, reports, kept } = setup(t, { captureReportMemory: () => proof })
  const { task } = await start('Report awaiting its proof')
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('The erased part') })
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  const secret = 'The erased part', hash = (value: string) => createHash('sha256').update(value).digest('hex')
  history.eraseFileRanges([{ sourceId: 'selected-source', revision: 1, hash: hash(secret), afterHash: hash(' '.repeat(secret.length)),
    length: secret.length, spans: [{ start: 0, end: secret.length }] }])
  resolveProof({ sources: ['selected-source'], epoch: 0, turnOnly: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(kept()?.status, 'done', 'the task lifecycle settled even though the report itself was withheld')
  assert.deepEqual(reports(), [])
})

test('shutdown keeps the task end while withholding a report proof still in flight', async t => {
  let complete!: (memory: MemoryProvenance) => void
  const proof = new Promise<MemoryProvenance>(resolve => { complete = resolve })
  const { start, tasks, reports, kept } = setup(t, { captureReportMemory: () => proof })
  const { task } = await start('Close while awaiting proof')
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  await Promise.resolve()
  tasks.dispose()
  complete({ sources: [], epoch: 0, turnOnly: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(kept()?.status, 'done')
  assert.deepEqual(reports(), [])
})

test('a report retains the original brief proof after the owner snapshot changes and omits an unproved topic title', async t => {
  const first: MemoryProvenance = { sources: ['old-brief-source'], epoch: 0, turnOnly: false }
  const last: MemoryProvenance = { sources: ['new-result-source'], epoch: 0, turnOnly: false }
  const { tasks, effects, kept } = setup(t, { captureReportMemory: async () => last })
  const { taskId } = await tasks.agent.start('Original task instructions', undefined, async () => first)
  assert.deepEqual(kept()?.requestMemory, first)
  tasks.dsh.receive({ type: 'task_update', taskId, update: chunk('Current output') })
  tasks.dsh.receive({ type: 'task_end', taskId, stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  const [report] = effects()
  assert.equal(report?.key, `${taskId}:run-1`)
  const payload = report.payload as { topic: string | null, memory: MemoryProvenance }
  assert.equal(payload.topic, null)
  assert.deepEqual(payload.memory.sources, ['old-brief-source', 'new-result-source'])
})

test('an automatically recomputed report topic uses the evidence of the row that supplies its title', async t => {
  const blankSource = randomUUID()
  const titleSource = randomUUID()
  for (const [caseName, sourceId, expectedTopic] of [
    ['unproved title', blankSource, null],
    ['proved title', titleSource, 'Independent text'],
  ] as const) {
    await t.test(caseName, async subtest => {
      const memory: MemoryProvenance = { sources: [sourceId], epoch: 0, turnOnly: false }
      const { tasks, history, main, effects } = setup(subtest, {
        captureReportMemory: async () => memory,
        mainMessages: [
          { role: 'user', text: '', receipt: null, sourceId: blankSource },
          { role: 'user', text: 'Independent text', receipt: null, sourceId: titleSource },
        ],
      })
      const { taskId } = await tasks.agent.start('Generic task instructions', undefined, async () => memory)
      history.eraseMemoryCopies([randomUUID()])
      assert.equal(history.get(main.id)?.conversation.title, 'Independent text')
      tasks.dsh.receive({ type: 'task_end', taskId, stopReason: 'end_turn' })
      await new Promise(resolve => setImmediate(resolve))
      const [report] = effects()
      assert.equal((report?.payload as { topic: string | null }).topic, expectedTopic)
    })
  }
})
