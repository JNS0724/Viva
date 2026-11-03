import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateFollowups, openAppDb } from '../src/backend/app-db.ts'
import { openFollowupStore } from '../src/main/followup-store.ts'

function folder(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-app-db-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the follow-ups an earlier version kept in followups.db move into app.db once, and the old file is kept aside', (t) => {
  const dir = folder(t)
  const legacyFile = path.join(dir, 'followups.db')
  const legacy = openFollowupStore({ file: legacyFile })
  const kept = legacy.add({ title: '周报', ask: '起草周报', origin: { kind: 'chat', conversationId: 'c1' }, remindAt: Date.now() + 60_000 })
  legacy.logEvent('suggest_shown', { from: 'chat' })
  legacy.logNotice('ready', [kept.id], true)
  legacy.close()

  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => app.close())
  const store = openFollowupStore({ db: app.db })
  assert.equal(migrateFollowups(app, legacyFile), 1)
  assert.deepEqual(store.list().map((followup) => [followup.id, followup.title, followup.origin.conversationId]), [[kept.id, '周报', 'c1']])
  assert.equal(store.countEvents('suggest_shown', 0), 1, 'the week\'s events came along')
  assert.equal(store.interruptionsOn(), 1, 'and the notices counted against the day')
  assert.equal(fs.existsSync(legacyFile), false)
  assert.ok(fs.existsSync(`${legacyFile}.migrated`), 'the old file is kept, moved aside')

  fs.copyFileSync(`${legacyFile}.migrated`, legacyFile)
  assert.equal(migrateFollowups(app, legacyFile), 0, 'once only')
  assert.equal(store.list().length, 1)
  store.close()
  assert.equal(app.db.isOpen, true, 'a store on the app database leaves it open')
})

test('without an old file there is nothing to move, and the app database starts with its tables', (t) => {
  const dir = folder(t)
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => app.close())
  assert.equal(migrateFollowups(app, path.join(dir, 'followups.db')), 0)
  const tables = (app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name)
  assert.ok(tables.includes('app_events') && tables.includes('meta'))
})
