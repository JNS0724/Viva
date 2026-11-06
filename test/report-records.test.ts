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
import { registerRewindIpc } from '../src/backend/rewind-ipc.ts'
import { createTaskReports, REPORT, reportId, type ReportPayload } from '../src/backend/task-reports.ts'

/**
 * A report read is kept as a record of the conversation of the session it went to (report-records.ts), on a real app
 * database: in a table of its own that only the backend writes, with the report done in the same change; the window
 * draws it and its saves never touch it.
 */

const TOKEN = 'a'.repeat(32)
const ID = reportId('task-0001', 'run-1')
const payload = (deliveredTo: string, extra: Partial<ReportPayload> = {}): ReportPayload =>
  ({ taskId: 'task-0001', runId: 'run-1', title: '整理发布说明', status: 'done', host: 'c-old', output: '写好了', token: TOKEN, deliveredTo, via: 'steer', ...extra })

function open(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-records-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return app
}

function setup(t: TestContext) {
  const app = open(t)
  const core = createEventCore({ app, publish: () => {}, now: () => 1_000 })
  const history = journaled(openHistoryDb({ db: app.db, now: () => 1_000 }), 'history', ['save', 'addRecord'], core.apply)
  const effects = createEffects({ db: app.db, apply: core.apply, now: () => 1_000 })
  const old = history.save(history.create({ sessionId: 's-old' }), [{ role: 'user', text: '整理一下发布说明' }, { role: 'assistant', text: '好的。', receipt: null }]) as Conversation
  const world = { current: history.save(history.create({ sessionId: 's-new' }), [{ role: 'user', text: '换个话题' }]) as Conversation }
  const shown: RecordShown[] = []
  const records = createReportRecords({
    history: () => history, effects: () => effects, apply: core.apply,
    current: () => world.current, show: (event) => { shown.push(event) }, now: () => 5_000,
  })
  const queue = (deliveredTo: string, extra: Partial<ReportPayload> = {}) => {
    core.apply('test.queued', {}, () => effects.queue(REPORT, ID, payload(deliveredTo, extra)))
    return effects.get(REPORT, ID) as Effect<ReportPayload>
  }
  return { app, core, history, effects, records, world, shown, old, queue }
}

test('read in a session whose conversation is not on screen: its record is kept there, after its messages, and the report done', (t) => {
  const { history, records, effects, shown, old, world, queue } = setup(t)
  records.read(queue('s-old'))
  assert.deepEqual(history.recordsOf(old.id).map(({ reportId, at, after }) => ({ reportId, at, after })), [{ reportId: ID, at: 5_000, after: 2 }])
  const [kept] = history.recordsOf(old.id)
  assert.ok(kept.text.includes('整理发布说明') && !kept.text.includes(TOKEN), 'the note as given, without its token')
  assert.deepEqual(history.recordsOf(world.current.id), [], 'none on the topic on screen')
  assert.deepEqual(shown, [], 'nothing drawn on the window')
  assert.equal(effects.get(REPORT, ID), null, 'done')
  assert.deepEqual(history.get(old.id)?.messages.map((m) => m.role), ['user', 'assistant'], 'its messages as they were')
})

test('the record and the report done are one change: either failing, neither is', (t) => {
  const { app, history, records, effects, old, queue } = setup(t)
  const effect = queue('s-old')
  app.db.exec(`CREATE TRIGGER no_records BEFORE INSERT ON report_records BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  assert.throws(() => records.read(effect), /disk full/)
  assert.ok(effects.get(REPORT, ID), 'still queued: tried again on a later pass')
  app.db.exec('DROP TRIGGER no_records')
  app.db.exec(`CREATE TRIGGER kept_effects BEFORE DELETE ON effects BEGIN SELECT RAISE(ABORT, 'busy'); END`)
  assert.throws(() => records.read(effect), /busy/)
  assert.deepEqual(history.recordsOf(old.id), [], 'the report not done: its record not kept either')
})

test('on screen: drawn as the note is written, kept with the same time when read; the window\'s saves never touch it', (t) => {
  const { history, records, effects, shown, world, queue } = setup(t)
  records.written(queue('s-new'))
  assert.deepEqual(shown.map(({ conversationId, sessionId, reportId, at }) => ({ conversationId, sessionId, reportId, at })),
    [{ conversationId: world.current.id, sessionId: 's-new', reportId: ID, at: 5_000 }], 'drawn as soon as the note is in the session')
  assert.deepEqual(history.recordsOf(world.current.id), [], 'written, not yet read: not kept')
  records.read(effects.get(REPORT, ID) as Effect<ReportPayload>)
  assert.deepEqual(history.recordsOf(world.current.id).map(({ at, after }) => ({ at, after })), [{ at: 5_000, after: 1 }])
  assert.equal(effects.get(REPORT, ID), null, 'done, no save of the window\'s waited on')
  assert.equal(shown.length, 2, 'drawn again with it (the window draws a report once)')
  // The window's saves: longer (an answer that settled above it), and shorter (a turn redone).
  history.save(world.current, [{ role: 'user', text: '换个话题' }, { role: 'assistant', text: '我先看一下。', receipt: null }, { role: 'assistant', text: '后台查完了。', receipt: null }])
  history.save(world.current, [{ role: 'user', text: '换个话题' }])
  assert.deepEqual(history.recordsOf(world.current.id).map(({ reportId, after }) => ({ reportId, after })), [{ reportId: ID, after: 1 }])
  assert.deepEqual(history.get(world.current.id)?.messages.map((m) => m.role), ['user'], 'the messages are the window\'s alone')
  records.written(queue('s-old'))
  assert.equal(shown.length, 2, 'written in another conversation\'s session: not drawn here')
})

test('a report is recorded once, read however many times', (t) => {
  const { history, records, old, queue } = setup(t)
  records.read(queue('s-old'))
  records.read(queue('s-old'))
  assert.equal(history.recordsOf(old.id).length, 1)
  assert.equal(history.hasRecord(ID), true)
})

test('no conversation for its session: done, nothing kept; a blank topic on screen: kept before its first message, and loaded with it', (t) => {
  const { history, records, effects, shown, world, queue } = setup(t)
  records.read(queue('s-gone'))
  assert.equal(effects.get(REPORT, ID), null)
  assert.equal(history.hasRecord(ID), false)
  world.current = history.create({ sessionId: 's-fresh' })
  records.read(queue('s-fresh'))
  assert.equal(shown.at(-1)?.conversationId, world.current.id, 'drawn on the topic on screen, before its first save')
  history.save(world.current, [{ role: 'assistant', text: '后台查完了。', receipt: null }])
  assert.deepEqual(history.get(world.current.id)?.records.map(({ reportId, after }) => ({ reportId, after })), [{ reportId: ID, after: 0 }])
})

test('a conversation\'s records go with it, and come with it in the timeline', (t) => {
  const { history, records, old, world, queue } = setup(t)
  records.read(queue('s-old'))
  assert.deepEqual(history.segmentsBefore(world.current.id).segments.find((segment) => segment.id === old.id)?.records?.map((r) => r.reportId), [ID])
  history.softDelete(old.id)
  history.purgeDeleted({ olderThanMs: 0 })
  assert.equal(history.hasRecord(ID), false)
})

for (const [where, session] of [['another conversation', 's-old'], ['the conversation on screen', 's-new']] as const) {
  test(`a late confirmation whose record cannot be kept (${where}): the queue tries again after its wait, and keeps it once the database is back`, async (t) => {
    const app = open(t)
    let clock = 1_000
    let timers: Array<{ run: () => void, at: number }> = []
    const core = createEventCore({ app, publish: () => {}, now: () => clock })
    const history = journaled(openHistoryDb({ db: app.db, now: () => clock }), 'history', ['save', 'addRecord'], core.apply)
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
    app.db.exec(`CREATE TRIGGER no_records BEFORE INSERT ON report_records BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    // The confirmation came, its record could not be kept (compose.ts: logged, then a pass now).
    assert.throws(() => records.read(effects.get(REPORT, ID) as Effect<ReportPayload>), /disk full/)
    await effects.wake()
    assert.equal(timers.length, 1, 'put off: a wake is set, not left waiting for one')
    assert.equal(timers[0].at - clock, RETRY_MS[0])
    app.db.exec('DROP TRIGGER no_records')
    const [due] = timers
    clock = due.at
    timers = []
    due.run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(history.recordsOf(session === 's-old' ? old.id : here.id).length, 1, 'kept where it was read')
    assert.equal(effects.get(REPORT, ID), null, 'and done')
  })
}

test('a blank topic whose record is kept before its first save: stored with it, so it comes back after a restart', (t) => {
  const { app, history, records, world, queue } = setup(t)
  world.current = history.create({ sessionId: 's-fresh' })
  records.read(queue('s-fresh'))
  const again = openHistoryDb({ db: app.db })
  assert.equal(again.latest()?.conversation.id, world.current.id, 'the topic is there, the latest')
  assert.deepEqual(again.get(world.current.id)?.records.map(({ reportId, after }) => ({ reportId, after })), [{ reportId: ID, after: 0 }])
})

test('going back, and back onto the path left: the records of the shared part go with the path on screen, the others stay with the folded one', async (t) => {
  const app = open(t)
  let n = 0
  const history = openHistoryDb({ db: app.db, newId: () => `c-${String(++n).padStart(4, '0')}` })
  const words = ['做周报', '写好了', '太正式了', '改了']
  let current = history.save(history.create({ sessionId: 's1', cwd: '/w' }), words.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text, receipt: null }))) as Conversation
  const before = current
  history.addRecord({ conversationId: before.id, reportId: 'task-0001:run-1', at: 1, text: 'r1' }) // after 4 messages: on the part left
  app.db.prepare('UPDATE report_records SET after_seq = 1 WHERE report_id = ?').run('task-0001:run-1') // after the first: shared
  history.addRecord({ conversationId: before.id, reportId: 'task-0002:run-1', at: 2, text: 'r2' }) // after the fourth: the part left
  const handlers: Record<string, (event: unknown, request: unknown) => Promise<any> | any> = {}
  registerRewindIpc({ handle: (channel: string, fn: (event: unknown, request: unknown) => unknown) => { handlers[channel] = fn as never } } as never, {
    db: history, current: () => current, isBusy: () => false, agentInfo: () => ({ mode: 'live', model: 'V4' }),
    selectSession: async work => work({ select: next => { current = next }, forkAgent: async () => ({ ok: true, info: { sessionId: 's2', mode: 'live', model: 'V4', cwd: '/w' } as never }),
    switchAgent: async (sessionId) => ({ sessionId, cwd: '/w', resumed: true, mode: 'live', model: 'V4' } as never) }),
  })
  const rewound = await handlers['timeline:rewind']({}, { words: '太正式了', occurrence: 0, keep: 2, text: '口语一点' })
  assert.deepEqual(rewound.conversation.records.map((r: { reportId: string, after: number }) => [r.reportId, r.after]), [['task-0001:run-1', 1]], 'the shared part\'s record, on screen')
  const opened = await handlers['timeline:folded']({}, before.id)
  assert.deepEqual(opened.records.map((r: { reportId: string, after: number }) => [r.reportId, r.after]), [['task-0002:run-1', 2]], 'the path left: its own, placed in what it holds after the shared part')
  const back = await handlers['timeline:switch-path']({}, before.id)
  assert.deepEqual(back.conversation.records.map((r: { reportId: string }) => r.reportId), ['task-0001:run-1', 'task-0002:run-1'], 'back onto it: all of its records again')
})
