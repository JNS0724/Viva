import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createTaskRuntime } from '../src/backend/task-runtime.ts'
import { createTaskStore, type StoredTask } from '../src/backend/task-store.ts'
import type { TaskSnapshot } from '../src/backend/task-registry.ts'

/**
 * TaskRuntime over the real thing (system-design §12.2): one app database holding the history, the task store and
 * the events, and the event core's apply, as compose.ts wires them. A change that cannot be written leaves nothing:
 * not in the database, and not in memory, so the same end can be kept when it comes again.
 */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
type Started = { ok: true, task: { id: string, segmentId: string } }

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-tx-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const core = createEventCore({ app, publish: () => {} })
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
  let runs = 0
  const make = () => createTaskRuntime({
    db, store, current: () => main, agentInfo: () => ({ mode: 'live', model: 'V4' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: 'task-0001' }), promptTask: () => {}, steerTask: () => ({ ok: true }),
      resumeTask: () => ({ ok: true }), cancelTask: () => {}, closeTask: () => {},
    },
    apply: (kind, data, write) => core.apply(kind, data, write),
    publish: ({ snapshot }) => { snapshots.push(snapshot) },
    newRunId: () => `run-${++runs}`,
    timers: { later: () => 0, cancel: () => {} },
  })
  const tasks = make()
  const status = (runtime = tasks) => (runtime.agent.query({ op: 'get', taskId: 'task-0001' }, { taskId: 'task-0001' }) as { task: { status: string } }).task.status
  const kept = () => realStore.list().find((entry) => entry.id === 'task-0001')
  const ended = () => core.since(0).filter((event) => event.kind === 'task.ended')
  return { tasks, make, failing, snapshots, status, kept, ended, history }
}

test('a task\'s end that cannot be kept leaves nothing, in the database or in memory; the end coming again is kept', async (t) => {
  const { tasks, failing, snapshots, status, kept, ended } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('写好了。') })
  failing.ending = true
  const before = snapshots.length
  assert.throws(() => tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' }), /disk full/)
  assert.equal(kept()?.endedAt, undefined, 'not kept as ended')
  assert.equal(ended().length, 0, 'no task.ended event')
  assert.equal(status(), 'running', 'still at work in memory')
  assert.equal(snapshots.length, before, 'the window was told nothing')

  failing.ending = false
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
  assert.deepEqual([kept()?.status, Number.isFinite(kept()?.endedAt)], ['done', true], 'the end kept when it comes again')
  assert.equal(ended().length, 1)
  assert.equal(snapshots.at(-1)?.status, 'done')
})

test('what the task said cannot be saved: its end is not kept either', async (t) => {
  const { tasks, failing, status, kept, ended, history } = setup(t)
  const { task } = await tasks.window.start({ text: '整理发布说明' }) as Started
  tasks.dsh.receive({ type: 'task_update', taskId: task.id, update: chunk('写好了。') })
  failing.words = true
  assert.throws(() => tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' }), /disk full/)
  assert.equal(kept()?.endedAt, undefined)
  assert.equal(ended().length, 0)
  assert.equal(status(), 'running')

  failing.words = false
  tasks.dsh.receive({ type: 'task_end', taskId: task.id, stopReason: 'end_turn' })
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
