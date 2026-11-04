import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEventCore, type Push, type Routes } from '../src/backend/event-core.ts'

function core(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-event-core-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  app.db.exec('CREATE TABLE things (name TEXT)')
  const pushes: Push[] = []
  const events = createEventCore({ app, publish: (push) => pushes.push(push), now: () => 1000 })
  const count = () => Number((app.db.prepare('SELECT COUNT(*) AS n FROM things').get() as { n: number }).n)
  return { app, events, pushes, count }
}

const noRoutes = (): Routes => ({
  'chat.said': () => 'asked', 'agent.turn_ended': () => {}, 'agent.task_ended': () => {}, 'agent.followup_proposed': () => {},
  'clock.reminder_due': () => {}, 'clock.prepare_window': () => {}, 'system.woke': () => {}, 'system.user_returned': () => {}, 'window.foreground': () => {},
  'user.command': () => {},
})

test('a change and its event are written together, numbered without gaps, and pushed with their number', (t) => {
  const { app, events, pushes, count } = core(t)
  const first = events.apply('thing.added', { name: 'a' }, () => app.db.prepare("INSERT INTO things VALUES ('a')").run(), { type: 'things_changed' })
  const second = events.apply('thing.added', { name: 'b' }, () => app.db.prepare("INSERT INTO things VALUES ('b')").run())
  assert.deepEqual([first.seq, second.seq], [1, 2])
  assert.deepEqual(pushes, [{ type: 'things_changed', seq: 1 }])
  assert.equal(count(), 2)
  assert.deepEqual(events.since(1), [{ seq: 2, at: 1000, kind: 'thing.added', data: { name: 'b' } }], 'what came after a number, for a shell that missed it')
})

test('a write that fails leaves neither its change nor its event, and nothing is pushed', (t) => {
  const { app, events, pushes, count } = core(t)
  assert.throws(() => events.apply('thing.added', {}, () => {
    app.db.prepare("INSERT INTO things VALUES ('half')").run()
    throw new Error('disk full')
  }, { type: 'things_changed' }), /disk full/)
  assert.equal(count(), 0)
  assert.equal(events.lastSeq(), 0)
  assert.deepEqual(pushes, [])
  const nested = events.apply('outer', {}, () => events.apply('inner', {}, () => 'inside').value)
  assert.deepEqual([nested.value, events.since(0).map((event) => event.kind)], ['inside', ['inner', 'outer']], 'nested applies join one transaction')
})

test('a transient push carries the latest stored number and says it is transient', (t) => {
  const { events, pushes } = core(t)
  events.transient({ type: 'update', text: 'streamed' })
  events.apply('x', {}, () => undefined)
  events.transient({ type: 'update', text: 'more' })
  assert.deepEqual(pushes, [{ type: 'update', text: 'streamed', seq: 0, transient: true }, { type: 'update', text: 'more', seq: 1, transient: true }])
  assert.deepEqual(events.since(0).map((event) => event.kind), ['x'], 'transient pushes are not stored')
})

test('signals are recorded (never what was said) and routed; without routes, or a route, a signal is refused', (t) => {
  const { events } = core(t)
  assert.throws(() => events.signal({ kind: 'system.woke' }), /before the routes were set/)
  events.route(noRoutes())
  assert.equal(events.signal({ kind: 'chat.said', text: '我的银行卡密码是多少', images: [] }), 'asked')
  events.signal({ kind: 'window.foreground' })
  events.signal({ kind: 'system.woke' })
  assert.deepEqual(events.since(0).map((event) => [event.kind, event.data]), [['signal.chat.said', { chars: 10, images: 0 }], ['signal.system.woke', {}]])
  const { 'system.woke': _woke, ...partial } = noRoutes()
  events.route(partial as unknown as Routes)
  assert.throws(() => events.signal({ kind: 'system.woke' }), /no route for signal system.woke/)
})

test('only the latest events are kept: older ones go when the core opens', (t) => {
  const { app, events } = core(t)
  for (const name of ['a', 'b', 'c', 'd']) events.apply('thing.added', { name }, () => undefined)
  const reopened = createEventCore({ app, publish: () => {}, kept: 2 })
  assert.deepEqual(reopened.since(0).map((event) => event.seq), [3, 4])
  assert.equal(reopened.apply('thing.added', { name: 'e' }, () => undefined).seq, 5, 'numbers go on, never reused')
})
