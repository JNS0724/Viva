import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEffects, RETRY_MS, type Effect } from '../src/backend/effects.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { openHistoryDb, type Conversation } from '../src/backend/history-db.ts'
import { journaled } from '../src/backend/journal.ts'
import { createReportRecords, type RecordShown } from '../src/backend/report-records.ts'
import { createTaskReports, REPORT, reportId, type ReportPayload } from '../src/backend/task-reports.ts'

/**
 * A report read is kept as a record in the conversation of the session it went to (report-records.ts), on a real
 * app database: written there when that conversation is not on screen, shown and done once the window saves it when it
 * is; done only once its record is kept, and recorded once.
 */

const TOKEN = 'a'.repeat(32)
const ID = reportId('task-0001', 'run-1')
const payload = (deliveredTo: string, extra: Partial<ReportPayload> = {}): ReportPayload =>
  ({ taskId: 'task-0001', runId: 'run-1', title: '整理发布说明', status: 'done', host: 'c-old', output: '写好了', token: TOKEN, deliveredTo, via: 'steer', ...extra })

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-records-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const core = createEventCore({ app, publish: () => {}, now: () => 1_000 })
  const history = journaled(openHistoryDb({ db: app.db, now: () => 1_000 }), 'history', ['save'], core.apply)
  const effects = createEffects({ db: app.db, apply: core.apply, now: () => 1_000 })
  const old = history.save({ ...history.create({ sessionId: 's-old' }) }, [{ role: 'user', text: '整理一下发布说明' }]) as Conversation
  const world = { current: history.save({ ...history.create({ sessionId: 's-new' }) }, [{ role: 'user', text: '换个话题' }]) as Conversation }
  const shown: RecordShown[] = []
  const records = createReportRecords({
    history: () => history, effects: () => effects, apply: core.apply,
    current: () => world.current, show: (event) => { shown.push(event) }, now: () => 5_000,
  })
  const queue = (deliveredTo: string, extra: Partial<ReportPayload> = {}) => {
    core.apply('test.queued', {}, () => effects.queue(REPORT, ID, payload(deliveredTo, extra)))
    return effects.get(REPORT, ID) as Effect<ReportPayload>
  }
  const reportsIn = (id: string) => (history.get(id)?.messages ?? []).filter((message) => message.role === 'report')
  return { app, core, history, effects, records, world, shown, old, queue, reportsIn }
}

test('read in a session whose conversation is not on screen: its record is kept there, not here, and the report is done', (t) => {
  const { records, effects, shown, old, world, queue, reportsIn } = setup(t)
  records.read(queue('s-old'))
  assert.equal(reportsIn(old.id).length, 1, 'kept in the conversation it went to')
  assert.deepEqual(reportsIn(old.id)[0].report, { reportId: ID, at: 5_000 })
  assert.ok(reportsIn(old.id)[0].text.includes('整理发布说明') && !reportsIn(old.id)[0].text.includes(TOKEN), 'the note as given, without its token')
  assert.equal(reportsIn(world.current.id).length, 0, 'none on the topic on screen')
  assert.deepEqual(shown, [], 'nothing drawn on the window')
  assert.equal(effects.get(REPORT, ID), null, 'done')
})

test('the record and the report done are one change: a record that cannot be kept leaves the report to be done', (t) => {
  const { app, records, effects, old, queue, reportsIn } = setup(t)
  const effect = queue('s-old')
  app.db.exec(`CREATE TRIGGER no_reports BEFORE INSERT ON messages WHEN NEW.role = 'report' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  assert.throws(() => records.read(effect), /disk full/)
  assert.equal(reportsIn(old.id).length, 0)
  assert.ok(effects.get(REPORT, ID), 'still queued: tried again on a later pass')
  app.db.exec('DROP TRIGGER no_reports')
  app.db.exec(`CREATE TRIGGER kept_effects BEFORE DELETE ON effects BEGIN SELECT RAISE(ABORT, 'busy'); END`)
  assert.throws(() => records.read(effect), /busy/)
  assert.equal(reportsIn(old.id).length, 0, 'the report not done: its record not kept either, so the next pass keeps it once')
})

test('read in the session on screen: written there and done in one change, and drawn by the window, at the time it was shown', (t) => {
  const { records, effects, shown, world, queue, reportsIn } = setup(t)
  const effect = queue('s-new')
  records.written(effect)
  assert.equal(shown.length, 1, 'drawn as soon as the note is in the session')
  assert.equal(reportsIn(world.current.id).length, 0, 'written, not yet read: not kept')
  assert.ok(effects.get(REPORT, ID), 'nor done')
  records.read(effects.get(REPORT, ID) as Effect<ReportPayload>)
  assert.deepEqual(reportsIn(world.current.id).map((m) => m.report), [{ reportId: ID, at: 5_000 }], 'kept, with the time it was drawn at')
  assert.equal(effects.get(REPORT, ID), null, 'done: no save of the window\'s waited on')
  assert.deepEqual(shown.map((event) => [event.conversationId, event.sessionId, event.at]), [[world.current.id, 's-new', 5_000], [world.current.id, 's-new', 5_000]],
    'shown again with it (the window draws a report once)')
  records.written(queue('s-old'))
  assert.equal(shown.length, 2, 'written in another conversation\'s session: not drawn here')
})

test('the window\'s next save, its whole list with the record where it came: the stored order follows it, one record', (t) => {
  const { history, records, world, queue } = setup(t)
  records.read(queue('s-new'))
  // The window had more by then than was saved: an answer before the record (its stream settled late), one after.
  const text = (history.get(world.current.id)!.messages.find((m) => m.role === 'report'))!.text
  const windowList = [{ role: 'user', text: '换个话题' }, { role: 'assistant', text: '我先看一下。', receipt: null },
    { role: 'report', text, receipt: null, report: { reportId: ID, at: 5_000 } }, { role: 'assistant', text: '后台查完了。', receipt: null }]
  history.save(world.current, windowList)
  assert.deepEqual(history.get(world.current.id)!.messages.map((m) => m.role), ['user', 'assistant', 'report', 'assistant'])
  assert.equal(history.hasReport(world.current.id, ID), true)
})

test('its record kept already (the window saved it, or an earlier pass): done, not recorded again', (t) => {
  const { history, records, effects, old, queue, reportsIn } = setup(t)
  const found = history.get(old.id)!
  history.save(found.conversation, [...found.messages, { role: 'report', text: 'note', receipt: null, report: { reportId: ID, at: 4_000 } }])
  records.read(queue('s-old'))
  assert.equal(reportsIn(old.id).length, 1, 'one record')
  assert.equal(effects.get(REPORT, ID), null)
})

test('a session with no conversation kept: done with nothing to keep it in; one on screen not yet saved: kept as its first message, and shown', (t) => {
  const { history, records, effects, shown, world, queue } = setup(t)
  records.read(queue('s-gone'))
  assert.equal(effects.get(REPORT, ID), null)
  world.current = history.create({ sessionId: 's-fresh' })
  records.read(queue('s-fresh'))
  assert.equal(shown.at(-1)?.conversationId, world.current.id, 'the conversation on screen, before its first save')
  assert.deepEqual(history.get(world.current.id)?.messages.map((m) => m.role), ['report'], 'kept as its first message')
  assert.equal(effects.get(REPORT, ID), null)
})

test('a history kept before records had marks: opened, it takes them; its old messages read as before', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-records-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const before = openHistoryDb({ db: app.db })
  const kept = before.save(before.create({ sessionId: 's-old' }), [{ role: 'user', text: '旧的话' }]) as Conversation
  app.db.exec('ALTER TABLE messages DROP COLUMN meta')
  const after = openHistoryDb({ db: app.db })
  assert.deepEqual(after.get(kept.id)?.messages.map((m) => [m.role, m.text, m.report]), [['user', '旧的话', undefined]])
  after.save(kept, [...after.get(kept.id)!.messages, { role: 'report', text: 'note', receipt: null, report: { reportId: ID, at: 7 } }])
  assert.equal(after.hasReport(kept.id, ID), true)
  assert.equal(after.bySession('s-old')?.id, kept.id)
})

for (const [where, session] of [['another conversation', 's-old'], ['the conversation on screen', 's-new']] as const) {
test(`a late confirmation whose record cannot be kept (${where}): the queue tries again after its wait, and keeps it once the database is back`, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-records-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  let clock = 1_000
  let timers: Array<{ run: () => void, at: number }> = []
  const core = createEventCore({ app, publish: () => {}, now: () => clock })
  const history = journaled(openHistoryDb({ db: app.db, now: () => clock }), 'history', ['save'], core.apply)
  const effects = createEffects({
    db: app.db, apply: core.apply, now: () => clock,
    later: (run, ms) => { const timer = { run, at: clock + ms }; timers = [...timers, timer]; return timer },
    cancel: (timer) => { timers = timers.filter((entry) => entry !== timer) },
  })
  const old = history.save(history.create({ sessionId: 's-old' }), [{ role: 'user', text: '整理一下发布说明' }]) as Conversation
  const here = history.save(history.create({ sessionId: 's-new' }), [{ role: 'user', text: '换个话题' }]) as Conversation
  const records = createReportRecords({ history: () => history, effects: () => effects, apply: core.apply, current: () => here, show: () => {}, now: () => clock })
  effects.runs(REPORT, createTaskReports({
    conversation: () => 'idle', currentConversation: () => here.id, session: () => 's-new', superseded: () => false,
    holds: (effect) => effects.holds(effect), status: async () => 'read', deliver: async () => 'read', report: () => true,
    amend: (effect, payload) => effects.amend(effect, payload), onRead: (effect) => records.read(effect),
  }))
  core.apply('test.queued', {}, () => effects.queue(REPORT, ID, payload(session)))
  const target = session === 's-old' ? old : here
  app.db.exec(`CREATE TRIGGER no_reports BEFORE INSERT ON messages WHEN NEW.role = 'report' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  // The confirmation came, its record could not be kept (compose.ts: logged, then a pass now).
  assert.throws(() => records.read(effects.get(REPORT, ID) as Effect<ReportPayload>), /disk full/)
  await effects.wake()
  assert.equal(timers.length, 1, 'put off: a wake is set, not left waiting for one')
  assert.equal(timers[0].at - clock, RETRY_MS[0])
  app.db.exec('DROP TRIGGER no_reports')
  clock = timers[0].at
  const [due] = timers
  timers = []
  due.run()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal((history.get(target.id)?.messages ?? []).filter((message) => message.role === 'report').length, 1, 'kept where it was read')
  assert.equal(effects.get(REPORT, ID), null, 'and done')
})
}
