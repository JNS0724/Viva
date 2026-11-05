import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEventCore, type DshTaskEvent, type Routes } from '../src/backend/event-core.ts'
import { createTaskSignals, taskEventOf } from '../src/backend/task-signals.ts'

/**
 * What dsh reports of a task reaches the task runtime first, as compose.ts wires it, on a real event core; its signal
 * is recorded after, for the record only, and one that cannot be recorded loses nothing.
 */

function setup(t: TestContext, { failReceive = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-signals-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const core = createEventCore({ app, publish: () => {} })
  const received: DshTaskEvent[] = []
  const problems: unknown[] = []
  const signals = createTaskSignals({
    signal: (input) => core.signal(input),
    receive: (event) => {
      received.push(event)
      if (failReceive) throw new Error('the runtime failed')
    },
    onError: (err) => problems.push(err),
  })
  const idle = () => undefined
  const routes: Routes = {
    'chat.said': idle, 'agent.turn_ended': idle, 'agent.followup_proposed': idle, 'clock.reminder_due': idle,
    'clock.prepare_window': idle, 'system.woke': idle, 'system.user_returned': idle, 'window.foreground': idle, 'user.command': idle,
    'agent.task_ended': idle,
    'agent.task_waits': idle,
  }
  core.route(routes)
  /** The database refuses every new event, as a full disk would. */
  const refuseEvents = () => app.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON app_events BEGIN SELECT RAISE(FAIL, 'disk full'); END")
  const recorded = () => core.since(0).map((event) => [event.kind, event.data])
  return { signals, received, problems, refuseEvents, recorded }
}

const end = (): DshTaskEvent => ({ type: 'task_end', taskId: 'task-0001', stopReason: 'end_turn' })

test('a task\'s end and its waits reach the runtime, then are recorded as signals by kind and task; what it says only reaches it', (t) => {
  const { signals, received, recorded } = setup(t)
  signals.report({ type: 'task_update', taskId: 'task-0001', update: {} })
  signals.report({ type: 'task_question', taskId: 'task-0001', questionId: 'q1', questions: [] })
  signals.report(end())
  assert.deepEqual(received.map((event) => event.type), ['task_update', 'task_question', 'task_end'])
  assert.deepEqual(recorded(), [
    ['signal.agent.task_waits', { type: 'task_question', taskId: 'task-0001' }],
    ['signal.agent.task_ended', { type: 'task_end', taskId: 'task-0001' }],
  ])
})

test('a signal that cannot be recorded: its event reached the runtime already, once, and why is said', (t) => {
  const { signals, received, problems, refuseEvents, recorded } = setup(t)
  refuseEvents()
  signals.report(end())
  assert.deepEqual(received.map((event) => event.type), ['task_end'], 'the end reached the runtime, which keeps it')
  assert.equal(recorded().length, 0)
  assert.match(String(problems[0]), /disk full/)
})

test('the runtime failing on an event: it is not handed again, and its signal is still recorded', (t) => {
  const { signals, received, recorded } = setup(t, { failReceive: true })
  assert.throws(() => signals.report(end()), /the runtime failed/)
  assert.equal(received.length, 1)
  assert.deepEqual(recorded().map(([kind]) => kind), ['signal.agent.task_ended'])
})

test('the record comes after the runtime: an end is kept by the runtime before its signal is written', (t) => {
  const order: string[] = []
  const { signals } = setup(t)
  const tracked = createTaskSignals({ signal: () => { order.push('recorded') }, receive: () => { order.push('received') } })
  tracked.report(end())
  signals.report({ type: 'task_update', taskId: 'task-0001', update: {} })
  assert.deepEqual(order, ['received', 'recorded'])
})

test('only a task\'s events are its: the conversation\'s own permission names no task', () => {
  assert.equal(taskEventOf({ type: 'permission', requestId: 'r1' }), null)
  assert.equal(taskEventOf({ type: 'turn_end' }), null)
  assert.equal(taskEventOf({ type: 'permission', taskId: 'task-0001' })?.taskId, 'task-0001')
})
