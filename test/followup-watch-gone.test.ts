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
  const store = openFollowupStore({ db })
  assert.deepEqual([store.get('watch-only')?.status, store.get('timed')?.status], ['dismissed', 'scheduled'])
  assert.equal('watchPath' in (store.get('timed') ?? {}), false, 'no watched file on what is read')
})
