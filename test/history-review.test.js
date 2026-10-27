import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'

/** 回顾: the timeline read back by day (newest first), the background tasks in it, and the messages starred. */

const user = (text, extra = {}) => ({ role: 'user', text, receipt: null, ...extra })
const answer = (text) => ({ role: 'assistant', text, receipt: { ms: 10, tools: 0, thoughts: 0, stopReason: 'end_turn' } })

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-review-')), 'history.db')
  let clock = 1_000_000
  let seq = 0
  const db = openHistoryDb({ file, now: () => (clock += 1000), newId: () => `c${++seq}` })
  return { db, file }
}

const segment = (db, messages, fields = {}) => db.save(db.create({ sessionId: 's', ...fields }), messages)

test('review lists the segments newest first, with title, turns and whether files came with them', () => {
  const { db } = freshDb()
  const a = segment(db, [user('整理周报'), answer('好'), user('加上下周计划'), answer('好')])
  const b = segment(db, [user('看看这个\n\n附带的文件（本机路径）：\n- /tmp/a.pdf'), answer('看了')])
  const c = segment(db, [user('配图', { images: [{ id: `${'a'.repeat(64)}.png` }] }), answer('收到')], { parentId: b.id })

  const { segments, hasMore } = db.review()
  assert.equal(hasMore, false)
  assert.deepEqual(segments.map((s) => s.id), [c.id, b.id, a.id])
  assert.deepEqual(segments.map((s) => [s.turns, s.hasFiles, s.kind]), [[1, true, 'talk'], [1, true, 'talk'], [2, false, 'talk']])
  assert.equal(segments[2].title, '整理周报')
  assert.equal(segments[0].parentId, b.id)
})

test('review comes in pages before a time; a background task is listed as one, a path left behind is not', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一')])
  const task = segment(db, [user('后台整理文档'), answer('在做')])
  db.fold(task.id, { into: a.id, at: 0, kind: 'side' })
  const left = segment(db, [user('走了另一条路')])
  db.fold(left.id, { into: a.id, at: 0 })
  const b = segment(db, [user('二')])

  const first = db.review({ limit: 2 })
  assert.deepEqual(first.segments.map((s) => [s.id, s.kind]), [[b.id, 'talk'], [task.id, 'task']])
  assert.equal(first.hasMore, true)
  const next = db.review({ before: first.segments.at(-1).createdAt, limit: 2 })
  assert.deepEqual(next.segments.map((s) => s.id), [a.id])
  assert.equal(next.hasMore, false)
})

test('a star is kept per message, counted per segment, and listed with the message it marks', () => {
  const { db } = freshDb()
  const a = segment(db, [user('报销模板放哪了'), answer('在 共享盘/行政/报销.xlsx')])
  db.setStar(a.id, 1, true)

  assert.deepEqual(db.starsIn([a.id, 'other']), [{ segmentId: a.id, seq: 1 }])
  assert.equal(db.review().segments[0].stars, 1)
  const [starred] = db.starredMessages()
  assert.deepEqual([starred.segmentId, starred.seq, starred.role, starred.text, starred.title], [a.id, 1, 'assistant', '在 共享盘/行政/报销.xlsx', '报销模板放哪了'])

  db.setStar(a.id, 1, false)
  assert.deepEqual(db.starsIn([a.id]), [])
  assert.deepEqual(db.starredMessages(), [])
})

test('a star on a message that is no longer there is not listed, and a deleted segment takes its stars along', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一'), answer('答')])
  db.setStar(a.id, 1, true)
  db.save(a, [user('一')])
  assert.deepEqual(db.starredMessages(), [])

  const b = segment(db, [user('二')])
  db.setStar(b.id, 0, true)
  db.softDelete(b.id)
  assert.deepEqual(db.starredMessages(), [])
  assert.equal(db.review().segments.some((s) => s.id === b.id), false)
})

test('a star on a message that does not exist is refused', () => {
  const { db } = freshDb()
  assert.throws(() => db.setStar('nope', 0, true), /找不到这条消息/)
})
