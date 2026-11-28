import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { scratch } from './fixtures/scratch.js'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { createScheduleRuns } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'
import { createEffects } from '../src/backend/effects.ts'
import { createEventCore } from '../src/backend/event-core.ts'
import { LEGACY_FEED_NOTICE, migrateLegacyFeed, SCHEDULE_NOTICE } from '../src/backend/legacy-feed-migration.ts'
import { noteFor, REPORT, reportId, SCHEDULE_RECORD_MAX_CHARS, type ReportPayload } from '../src/backend/task-reports.ts'
import { describeError } from '../src/backend/session-info.ts'

/** A fresh folder with the app database open in it; closed before the folder goes (Windows keeps an open file). */
function appDbIn(t: TestContext) {
  const { dir, defer } = scratch(t, 'viva-app-db-')
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  defer(() => app.close())
  return { dir, app, defer }
}

test('the app database starts with its tables, and the schedules open on it beside the events', (t) => {
  const { app } = appDbIn(t)
  const store = openScheduleStore({ db: app.db })
  createScheduleRuns({ db: app.db, store, run: async () => ({ ok: true, text: '' }), keep: () => {}, delivered: () => {} }).close()
  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  for (const name of ['app_events', 'meta', 'schedules', 'schedule_runs']) assert.ok(tables.includes(name), name)
  app.setMeta('k', 'v')
  assert.equal(app.meta('k'), 'v')
  assert.equal(app.db.isOpen, true, 'a store on the app database leaves it open')
})

test('storage diagnostics classify actual SQLite contention and rollback without copying SQL or changing thrown objects', t => {
  const { dir, app, defer } = appDbIn(t)
  const other = new DatabaseSync(path.join(dir, 'app.db'))
  defer(() => other.close())
  other.exec('PRAGMA busy_timeout=0')
  const events: DiagnosticEvent[] = []
  const restore = installDiagnosticPort(recordingDiagnosticPort(event => { events.push(event); return undefined }))
  t.after(restore)
  app.db.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => transaction(other, () => other.exec("INSERT INTO meta VALUES ('PRIVATE_SQL_KEY','PRIVATE_SQL_VALUE')")), { code: 'ERR_SQLITE_ERROR' })
    assert.ok(events.some(event => event.operation === 'storage' && event.event === 'operation.end' && event.reason === 'busy' && event.outcome === 'failed'))
  } finally { app.db.exec('ROLLBACK') }
  const original = new Error('PRIVATE_STORAGE_ERROR')
  assert.throws(() => transaction(app.db, () => { app.setMeta('PRIVATE_SQL_KEY', 'PRIVATE_SQL_VALUE'); throw original }), error => error === original)
  assert.equal(app.meta('PRIVATE_SQL_KEY'), null)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SQL|PRIVATE_STORAGE_ERROR|INSERT INTO/)
  restore()
  const broken = installDiagnosticPort({ emit() { throw new Error('observer failed') } })
  try {
    assert.equal(transaction(app.db, () => 42), 42)
    assert.throws(() => transaction(app.db, () => { throw original }), error => error === original)
  } finally { broken() }
})

test('legacy feed upgrade preserves unread schedule items as main-conversation reports, skips plugin sources and seen items, and drops feed tables atomically', (t) => {
  const { app } = appDbIn(t)
  const core = createEventCore({ app, publish: () => {}, now: () => 2_000 })
  const store = openScheduleStore({ db: app.db, now: () => 1_000, newId: () => 's1' })
  store.create({ title: '周五周报', prompt: '起草本周周报全文', cwd: '/work/weekly', rule: { kind: 'daily', daily: { time: '16:00:00', time_zone: 'Asia/Shanghai' } } })
  const effects = createEffects({ db: app.db, apply: core.apply, now: () => 2_000 })

  app.db.exec(`
    CREATE TABLE feed_items (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      seen_at INTEGER,
      UNIQUE (source, key)
    );
    CREATE TABLE feed_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE feed_source_runs (key TEXT PRIMARY KEY, source_id TEXT NOT NULL);
  `)
  const longBody = `${'A'.repeat(1500)}\nUNIQUE_LEGACY_CONCLUSION\n${'B'.repeat(1500)}`
  app.db.prepare('INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'f-unread', 'schedule', 's1@2026-11-06T08:00:00.000Z', '周五周报', longBody, JSON.stringify({ label: '定时', ref: 's1' }), 1_500, null,
  )
  app.db.prepare('INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'f-seen', 'schedule', 's1@2026-11-05T08:00:00.000Z', '周四周报', '已读内容', JSON.stringify({ label: '定时', ref: 's1' }), 1_200, 1_300,
  )
  app.db.prepare('INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'f-plugin', 'mail:work', 'msg-1', '外部邮件', '插件源旧条目\n这个定时要读的文件夹 /Users/secret/private-dir 已经不在了。', JSON.stringify({ label: '邮件', ref: 'https://mail.example.internal/thread/42' }), 1_600, null,
  )
  core.apply('legacy.notice', {}, () => {
    effects.queue(LEGACY_FEED_NOTICE, 'f-unread', { title: '周五周报', body: '摘录' })
    effects.queue(LEGACY_FEED_NOTICE, 'f-plugin', { title: '外部邮件', body: '插件源旧条目' })
  })

  app.db.exec(`CREATE TRIGGER fail_once BEFORE DELETE ON effects BEGIN SELECT RAISE(ABORT, 'disk busy'); END`)
  assert.throws(() => migrateLegacyFeed({ db: app.db, apply: core.apply, effects, now: () => 2_000 }), /disk busy/)
  assert.ok(app.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed_items'").get(), 'rollback keeps legacy tables intact')
  app.db.exec('DROP TRIGGER fail_once')

  const migrated = migrateLegacyFeed({
    db: app.db,
    apply: core.apply,
    effects,
    scheduleCwd: (id) => store.get(id)?.cwd ?? null,
    now: () => 2_000,
  })
  assert.deepEqual(migrated, {
    migratedReports: 1,
    migratedNotices: 1,
    archivedItems: 2,
    droppedTables: ['feed_items', 'feed_sources', 'feed_source_runs'],
  })

  const reportEffect = effects.get(REPORT, reportId('schedule:s1', 's1@2026-11-06T08:00:00.000Z'))
  assert.ok(reportEffect)
  const payload = reportEffect.payload as ReportPayload
  assert.equal(payload.by, 'schedule')
  assert.equal(payload.cwd, '/work/weekly')
  assert.equal(payload.request, '', 'does not attach a potentially mutated current prompt to an old occurrence')
  assert.match(payload.output, /UNIQUE_LEGACY_CONCLUSION/)
  assert.equal(effects.get(REPORT, reportId('schedule:s1', 's1@2026-11-05T08:00:00.000Z')), null, 'seen schedule item is not re-delivered')
  assert.ok(effects.get(SCHEDULE_NOTICE, 's1:s1@2026-11-06T08:00:00.000Z'), 'pending schedule notice is migrated')
  assert.equal(effects.list().some((effect) => effect.kind === LEGACY_FEED_NOTICE), false, 'legacy feed-notice rows removed through Effects')

  // Seen schedule items and plugin feed items are preserved locally (including origin.ref) as foreground_only=1 without leaking host paths or model recall.
  const archivedRows = app.db.prepare("SELECT role, text, foreground_only FROM messages WHERE conversation_id = 'legacy-feed-archive' ORDER BY seq").all() as Array<{ role: string, text: string, foreground_only: number }>
  const archivedText = archivedRows.map((r) => r.text).join('\n')
  assert.match(archivedText, /周四周报/)
  assert.match(archivedText, /已读内容/)
  assert.match(archivedText, /外部邮件/)
  assert.match(archivedText, /https:\/\/mail\.example\.internal\/thread\/42/, 'origin.ref provenance is preserved in archive')
  assert.match(archivedText, /插件源旧条目/)
  assert.doesNotMatch(archivedText, /\/Users\/secret\/private-dir/, 'legacy missing-folder host path is scrubbed')
  assert.ok(archivedRows.every((r) => r.foreground_only === 1), 'archived legacy items are marked foreground_only')

  const remainingTables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  for (const dropped of ['feed_items', 'feed_sources', 'feed_source_runs']) {
    assert.equal(remainingTables.includes(dropped), false, `${dropped} was dropped`)
  }

  const again = migrateLegacyFeed({ db: app.db, apply: core.apply, effects, now: () => 3_000 })
  assert.deepEqual(again, { migratedReports: 0, migratedNotices: 0, archivedItems: 0, droppedTables: [] }, 're-entrant second run is a no-op')
  assert.equal(effects.hasKind(REPORT), true)
  assert.equal(effects.hasKind(LEGACY_FEED_NOTICE), false)

  // Fast-path startup check uses indexed `hasKind` rather than scanning and JSON.parsing all queued effect payloads.
  let listCalls = 0
  const noOp = migrateLegacyFeed({
    db: app.db,
    apply: core.apply,
    effects: {
      get: effects.get,
      hasKind: effects.hasKind,
      queue: effects.queue,
      cancelStarting: effects.cancelStarting,
      ...({ list: () => { listCalls += 1; return effects.list() } }),
    },
    now: () => 4_000,
  })
  assert.deepEqual(noOp, { migratedReports: 0, migratedNotices: 0, archivedItems: 0, droppedTables: [] })
  assert.equal(listCalls, 0, 'startup migration check does not materialize or parse queued payloads')
})

test('legacy feed upgrade strips host diagnostics from failed schedule reports and preserves oversized >180k originals in local archive', (t) => {
  const { app } = appDbIn(t)
  const core = createEventCore({ app, publish: () => {}, now: () => 5_000 })
  const effects = createEffects({ db: app.db, apply: core.apply, now: () => 5_000 })

  app.db.exec(`
    CREATE TABLE feed_items (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      seen_at INTEGER,
      UNIQUE (source, key)
    );
  `)
  const failureWithStderr = `This scheduled run did not finish after several tries: ${describeError(new Error('prompt failed'), 'could not load /fixture/local-only/settings.yml')}`
  const oversizedUnread = `${'H'.repeat(95_000)}\nMIDDLE_UNREAD_MARKER\n${'T'.repeat(105_000)}`
  const oversizedSeen = `${'X'.repeat(95_000)}\nMIDDLE_SEEN_MARKER\n${'Y'.repeat(105_000)}`
  app.db.prepare('INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'f-err', 'schedule', 's-err@once', '失败提醒', failureWithStderr, JSON.stringify({ label: '定时', ref: 's-err' }), 1_000, null,
  )
  app.db.prepare('INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'f-huge-unread', 'schedule', 's-huge@once', '超长未读', oversizedUnread, JSON.stringify({ label: '定时', ref: 's-huge' }), 1_100, null,
  )
  app.db.prepare('INSERT INTO feed_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'f-huge-seen', 'schedule', 's-seen@once', '超长已读', oversizedSeen, JSON.stringify({ label: '定时', ref: 's-seen' }), 1_200, 1_300,
  )

  migrateLegacyFeed({ db: app.db, apply: core.apply, effects, now: () => 5_000 })

  const errPayload = effects.get(REPORT, reportId('schedule:s-err', 's-err@once'))?.payload as ReportPayload
  assert.ok(errPayload)
  assert.equal(errPayload.status, 'error')
  assert.doesNotMatch(errPayload.output, /\/fixture\/local-only\/settings\.yml|prompt failed|dsh:/)
  assert.doesNotMatch(noteFor([errPayload]), /\/fixture\/local-only\/settings\.yml|prompt failed|dsh:/)

  const hugePayload = effects.get(REPORT, reportId('schedule:s-huge', 's-huge@once'))?.payload as ReportPayload
  assert.ok(hugePayload)
  assert.equal(hugePayload.outputTruncated, true)
  assert.ok(hugePayload.output.length <= SCHEDULE_RECORD_MAX_CHARS, 'model/record delivery stays bounded at 180k')

  const archivedRows = app.db.prepare("SELECT text FROM messages WHERE conversation_id = 'legacy-feed-archive' AND role = 'assistant' ORDER BY seq").all() as Array<{ text: string }>
  assert.equal(archivedRows.length, 2, 'both oversized unread and oversized seen schedule originals are preserved in local archive')
  assert.equal(archivedRows[0]?.text, oversizedUnread, 'full 200k+ unread original including middle marker is preserved locally')
  assert.match(archivedRows[0]!.text, /MIDDLE_UNREAD_MARKER/)
  assert.equal(archivedRows[1]?.text, oversizedSeen, 'full 200k+ seen original including middle marker is preserved locally')
  assert.match(archivedRows[1]!.text, /MIDDLE_SEEN_MARKER/)
})
