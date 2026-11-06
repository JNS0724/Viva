import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openFollowupStore } from '../src/backend/followup-store.ts'

/** Follow-ups no longer watch a file (system-design §12.2): one kept from before that only watched one is let go. */

test('a follow-up kept from before that only watched a file is dismissed when the store opens; one with a time stays', () => {
  const db = new DatabaseSync(':memory:')
  openFollowupStore({ db })
  const insert = db.prepare(`INSERT INTO followups (id, title, ask, origin, created_at, remind_at, prepare_by, files, watch_path, status)
    VALUES (?, ?, ?, '{"kind":"chat"}', 0, ?, NULL, '[]', ?, 'scheduled')`)
  insert.run('watch-only', '设计稿', '写摘要', null, '/work/design.md')
  insert.run('timed', '周报', '提醒', 1_000, '/work/notes.md')
  db.prepare(`UPDATE followups SET prepare_by = 2000, files = '["/work/brief.md","/work/notes.md"]' WHERE id = 'timed'`).run()
  const store = openFollowupStore({ db })
  assert.deepEqual([store.get('watch-only')?.status, store.get('timed')?.status], ['dismissed', 'scheduled'])
  assert.deepEqual(store.get('timed')?.files, ['/work/brief.md', '/work/notes.md'], 'the watched file among what it reads, once')
  assert.equal('watchPath' in (store.get('timed') ?? {}), false, 'no watched file on what is read')
})

test('a timed follow-up that watched a file still reads it when prepared, once the store opens; opened again, nothing changes', () => {
  const db = new DatabaseSync(':memory:')
  openFollowupStore({ db })
  db.prepare(`INSERT INTO followups (id, title, ask, origin, created_at, remind_at, prepare_by, files, watch_path, status)
    VALUES ('design', '设计稿', '写摘要', '{"kind":"chat"}', 0, NULL, 5000, '[]', '/work/设计稿.md', 'scheduled')`).run()
  const first = openFollowupStore({ db }).get('design')
  assert.deepEqual([first?.status, first?.files], ['scheduled', ['/work/设计稿.md']])
  const again = openFollowupStore({ db }).get('design')
  assert.deepEqual(again?.files, ['/work/设计稿.md'], 'done once: the path is cleared')
  assert.equal(db.prepare(`SELECT watch_path FROM followups WHERE id = 'design'`).get()?.watch_path, null)
})
