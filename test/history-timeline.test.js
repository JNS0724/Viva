import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openHistoryDb } from '../src/main/history-db.js'

/**
 * One timeline (single-conversation design): every stored conversation is a segment of it, with the dsh
 * session, the working directory and the segment it went on from; earlier segments are read back in pages.
 */

const user = (text) => ({ role: 'user', text, receipt: null })
const answer = (text) => ({ role: 'assistant', text, receipt: { ms: 10, tools: 0, thoughts: 0, stopReason: 'end_turn' } })

function freshDb(file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-timeline-')), 'history.db')) {
  let clock = 1_000_000
  let seq = 0
  const db = openHistoryDb({ file, now: () => (clock += 1000), newId: () => `c${++seq}` })
  return { db, file }
}

const segment = (db, messages, fields = {}) => db.save(db.create({ sessionId: 's', mode: 'live', model: 'V4', ...fields }), messages)

test('a segment keeps the working directory it ran in and the one it went on from', () => {
  const { db, file } = freshDb()
  const first = segment(db, [user('做周报')], { cwd: '/w/viva' })
  const second = segment(db, [user('改首页')], { cwd: '/w/site', parentId: first.id })

  const reopened = openHistoryDb({ file })
  assert.deepEqual([reopened.get(first.id).conversation.cwd, reopened.get(first.id).conversation.parentId], ['/w/viva', null])
  assert.deepEqual([reopened.get(second.id).conversation.cwd, reopened.get(second.id).conversation.parentId], ['/w/site', first.id])
})

test('a history file from before segments opens as it was, its conversations without a directory', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-timeline-')), 'history.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', title_custom INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, session_id TEXT, mode TEXT, model TEXT, pinned INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)`)
  old.exec(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('old-1', '旧的', 1, 2)`)
  old.close()

  const { db } = freshDb(file)
  assert.deepEqual([db.get('old-1').conversation.cwd, db.get('old-1').conversation.parentId], [null, null])
})

test('earlier segments come back oldest first, in pages, each message with its time; deleted ones are left out', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一'), answer('答一')], { cwd: '/w/a' })
  const b = segment(db, [user('二')], { cwd: '/w/b' })
  const gone = segment(db, [user('删掉的')])
  db.softDelete(gone.id)
  const c = segment(db, [user('三')], { cwd: '/w/b' })
  const now = segment(db, [user('现在')], { cwd: '/w/b' })

  const page = db.segmentsBefore(now.id, { limit: 2 })
  assert.deepEqual(page.segments.map((s) => s.id), [b.id, c.id], 'the two right before, oldest first')
  assert.equal(page.hasMore, true)
  assert.deepEqual(page.segments[0], {
    id: b.id, cwd: '/w/b', parentId: null, createdAt: b.createdAt,
    messages: [{ seq: 0, role: 'user', text: '二', receipt: null, at: page.segments[0].messages[0].at }],
  })
  assert.ok(Number.isFinite(page.segments[0].messages[0].at))

  const rest = db.segmentsBefore(b.id, { limit: 2 })
  assert.deepEqual([rest.segments.map((s) => s.id), rest.hasMore], [[a.id], false])
  assert.deepEqual(rest.segments[0].messages.map((m) => m.text), ['一', '答一'])

  const fresh = db.create({ cwd: '/w/c' })
  assert.deepEqual(db.segmentsBefore(fresh.id, { limit: 2 }).segments.map((s) => s.id), [c.id, now.id],
    'a segment not yet written (just switched to another directory) comes after all that are')
})

test('searching the timeline finds messages, newest first, with where each one is and its directory', () => {
  const { db } = freshDb()
  const a = segment(db, [user('帮我把周报整理一下'), answer('周报写好了')], { cwd: '/w/a' })
  const b = segment(db, [user('周报同步到 docs')], { cwd: '/w/b' })

  const hits = db.searchMessages('周报')
  assert.deepEqual(hits.map((hit) => [hit.segmentId, hit.seq]), [[b.id, 0], [a.id, 1], [a.id, 0]])
  assert.deepEqual([hits[0].cwd, hits[0].role, hits[0].snippet.hit], ['/w/b', 'user', '周报'])
  assert.ok(Number.isFinite(hits[0].at))
  assert.deepEqual(db.searchMessages('   '), [])
})
