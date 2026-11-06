import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb } from '../src/backend/app-db.ts'
import { openFeedStore } from '../src/backend/feed-store.ts'
import { createScheduleRuns } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'

/** A fresh folder with the app database open in it; closed before the folder goes (Windows keeps an open file). */
function appDbIn(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-app-db-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => {
    app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, app }
}

test('the app database starts with its tables, and the schedules and 动态 open on it beside the events', (t) => {
  const { app } = appDbIn(t)
  const store = openScheduleStore({ db: app.db })
  const feed = openFeedStore({ db: app.db })
  createScheduleRuns({ db: app.db, store, feed, run: async () => ({ ok: true, text: '' }), delivered: () => {} }).close()
  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  for (const name of ['app_events', 'meta', 'schedules', 'schedule_runs', 'feed_items']) assert.ok(tables.includes(name), name)
  app.setMeta('k', 'v')
  assert.equal(app.meta('k'), 'v')
  assert.equal(app.db.isOpen, true, 'a store on the app database leaves it open')
})
