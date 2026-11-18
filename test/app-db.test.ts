import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { scratch } from './fixtures/scratch.js'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { openFeedStore } from '../src/backend/feed-store.ts'
import { createScheduleRuns } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'

/** A fresh folder with the app database open in it; closed before the folder goes (Windows keeps an open file). */
function appDbIn(t: TestContext) {
  const { dir, defer } = scratch(t, 'viva-app-db-')
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  defer(() => app.close())
  return { dir, app, defer }
}

test('the app database starts with its tables, and the schedules and 动态 open on it beside the events', (t) => {
  const { app } = appDbIn(t)
  const store = openScheduleStore({ db: app.db })
  const feed = openFeedStore({ db: app.db })
  createScheduleRuns({ db: app.db, store, feed, run: async () => ({ ok: true, text: '' }), keep: () => {}, delivered: () => {} }).close()
  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  for (const name of ['app_events', 'meta', 'schedules', 'schedule_runs', 'feed_items']) assert.ok(tables.includes(name), name)
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
