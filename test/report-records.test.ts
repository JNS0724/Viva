import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { createEffects, type Effect } from '../src/backend/effects.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { openHistoryDb, type Conversation } from '../src/backend/history-db.ts'
import { journaled } from '../src/backend/journal.ts'
import { createReportRecords, type RecordShown } from '../src/backend/report-records.ts'
import { REPORT, reportId, type ReportPayload } from '../src/backend/task-reports.ts'

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

test('read in the session on screen: shown there, and done once the window saves it, not before', (t) => {
  const { records, effects, shown, world, queue } = setup(t)
  records.read(queue('s-new'))
  assert.deepEqual(shown, [{ type: 'report_delivered', conversationId: world.current.id, reportId: ID, text: shown[0]?.text, at: 5_000 }])
  assert.equal((effects.get(REPORT, ID)?.payload as ReportPayload).read, true, 'read, waiting for the window to keep it')
  records.saved([{ role: 'user', text: '换个话题', receipt: null }])
  assert.ok(effects.get(REPORT, ID), 'a save without its record: not done')
  records.saved([{ role: 'user', text: '换个话题', receipt: null }, { role: 'report', text: shown[0].text, receipt: null, report: { reportId: ID, at: 5_000 } }])
  assert.equal(effects.get(REPORT, ID), null, 'saved with its record: done')
})

test('written in the session on screen: shown at once, where it came; a save before it is read does not finish it', (t) => {
  const { records, effects, shown, queue } = setup(t)
  const effect = queue('s-new')
  records.written(effect)
  assert.equal(shown.length, 1)
  records.saved([{ role: 'report', text: shown[0].text, receipt: null, report: { reportId: ID, at: 5_000 } }])
  assert.ok(effects.get(REPORT, ID), 'written, not yet read: not done')
  records.written(queue('s-old'))
  assert.equal(shown.length, 1, 'written in another conversation\'s session: not drawn here')
})

test('its record kept already (the window saved it, or an earlier pass): done, not recorded again', (t) => {
  const { history, records, effects, old, queue, reportsIn } = setup(t)
  const found = history.get(old.id)!
  history.save(found.conversation, [...found.messages, { role: 'report', text: 'note', receipt: null, report: { reportId: ID, at: 4_000 } }])
  records.read(queue('s-old'))
  assert.equal(reportsIn(old.id).length, 1, 'one record')
  assert.equal(effects.get(REPORT, ID), null)
})

test('a session with no conversation kept: done with nothing to keep it in; one on screen not yet saved: shown there', (t) => {
  const { history, records, effects, shown, world, queue } = setup(t)
  records.read(queue('s-gone'))
  assert.equal(effects.get(REPORT, ID), null)
  world.current = history.create({ sessionId: 's-fresh' })
  records.read(queue('s-fresh'))
  assert.equal(shown.at(-1)?.conversationId, world.current.id, 'the conversation on screen, before its first save')
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
