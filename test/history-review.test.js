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
  const next = db.review({ after: first.segments.at(-1).id, limit: 2 })
  assert.deepEqual(next.segments.map((s) => s.id), [a.id])
  assert.equal(next.hasMore, false)
})

test('a page ending among segments written at the same moment goes on with the rest of them', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-review-')), 'history.db')
  let seq = 0
  const db = openHistoryDb({ file, now: () => 5_000, newId: () => `s${++seq}` })
  for (let i = 0; i < 5; i += 1) segment(db, [user(`同一刻 ${i}`)])

  const first = db.review({ limit: 3 })
  const rest = db.review({ after: first.segments.at(-1).id, limit: 3 })
  assert.equal(first.hasMore, true)
  assert.deepEqual([...first.segments, ...rest.segments].map((s) => s.id).toSorted(), ['s1', 's2', 's3', 's4', 's5'])
  assert.equal(rest.hasMore, false)
})

test('a turn moved to the background is counted, named and read from its own question on, not the talk before it', () => {
  const { db } = freshDb()
  const moved = segment(db, [user('报销模板放哪了'), answer('在共享盘'), user('生成一份周报'), answer('在写')])
  const next = segment(db, [user('报销模板放哪了'), answer('在共享盘')])
  db.fold(moved.id, { into: next.id, at: 2, kind: 'task' })

  const listed = db.review().segments.find((s) => s.id === moved.id)
  assert.deepEqual([listed.kind, listed.title, listed.turns], ['task', '生成一份周报', 1])
  assert.deepEqual(db.segmentMessages(moved.id).map((m) => [m.seq, m.text]), [[2, '生成一份周报'], [3, '在写']])
  assert.deepEqual(db.segmentMessages(next.id).map((m) => m.seq), [0, 1])
})

test('starring a message already starred changes nothing, and says so', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一'), answer('答')])
  assert.equal(db.setStar(a.id, 1, true), true)
  assert.equal(db.setStar(a.id, 1, true), false)
  assert.equal(db.setStar(a.id, 1, false), true)
  assert.equal(db.setStar(a.id, 1, false), false)
})

test('words apart in the search are each looked for: a message has them all, long or short', () => {
  const { db } = freshDb()
  segment(db, [user('报销模板放哪里'), answer('报销用的模板在行政共享盘'), user('周报模板呢')])
  const texts = (query) => db.searchMessages(query).map((hit) => `${hit.snippet.before}${hit.snippet.hit}${hit.snippet.after}`)
  assert.equal(texts('报销 模板').length, 2)
  assert.equal(texts('行政共享盘 报销').length, 1)
  assert.equal(texts('模板   周报').length, 1)
  assert.deepEqual(texts('报销 不存在的词'), [])
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
