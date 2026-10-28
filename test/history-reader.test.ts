import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'

/** 回顾 reads a long topic a part at a time: from a place, or around a message, never more than asked. */

type Db = ReturnType<typeof openHistoryDb>

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-reader-')), 'history.db')
  let clock = 1_000_000
  let seq = 0
  return openHistoryDb({ file, now: () => (clock += 1000), newId: () => `c${++seq}` })
}

const turns = (count: number, from = 0) => Array.from({ length: count }, (_, i) => [
  { role: 'user', text: `问 ${from + i}`, receipt: null },
  { role: 'assistant', text: `答 ${from + i}`, receipt: null },
]).flat()

const segment = (db: Db, messages: object[], fields: Parameters<Db['create']>[0] = {}) => db.save(db.create({ sessionId: 's', ...fields }), messages)

test('a long topic is read a part at a time, in order across its segments', () => {
  const db = freshDb()
  const a = segment(db, turns(300))
  const b = segment(db, turns(200, 300), { parentId: a.id })

  const first = db.read(`t:${a.topicId}`, { from: 0, count: 100 })!
  assert.deepEqual([first.total, first.from, first.messages.length], [1000, 0, 100])
  assert.equal(first.topic?.title, '问 0')

  const across = db.read(`t:${a.topicId}`, { from: 550, count: 100 })!
  assert.deepEqual([across.messages[0].segmentId, across.messages[49].segmentId, across.messages[50].segmentId], [a.id, a.id, b.id])
  assert.deepEqual([across.messages[0].text, across.messages[50].text], ['问 275', '问 300'])
})

test('around a message the part has it in the middle, kept within the topic at either end', () => {
  const db = freshDb()
  const a = segment(db, turns(500))
  const middle = db.read(`t:${a.topicId}`, { around: { segmentId: a.id, seq: 600 }, count: 100 })!
  assert.equal(middle.from, 550)
  assert.equal(middle.messages.findIndex((m) => m.seq === 600), 50)

  const start = db.read(`t:${a.topicId}`, { around: { segmentId: a.id, seq: 3 }, count: 100 })!
  const end = db.read(`t:${a.topicId}`, { around: { segmentId: a.id, seq: 999 }, count: 100 })!
  assert.deepEqual([start.from, end.from, end.messages.at(-1)!.seq], [0, 900, 999])
})

test('never more than 200 at a time; a segment read alone, whole or its own part; a deleted one is gone', () => {
  const db = freshDb()
  const moved = segment(db, [...turns(1), ...turns(1, 1)])
  const next = segment(db, turns(1), { topicId: moved.topicId })
  db.fold(moved.id, { into: next.id, at: 2, kind: 'task' })

  assert.equal(db.read(`t:${moved.topicId}`, { count: 10_000 })!.messages.length, 2)
  assert.deepEqual(db.read(`s:${moved.id}`)!.messages.map((m) => m.seq), [2, 3])
  assert.deepEqual(db.read(`s:${moved.id}`, { whole: true })!.messages.map((m) => m.seq), [0, 1, 2, 3])

  db.softDelete(next.id)
  db.softDelete(moved.id)
  assert.equal(db.read(`s:${moved.id}`), null)
  assert.equal(db.read(`t:${moved.topicId}`), null)
  assert.throws(() => db.read('x:nothing'), /invalid reader key/)

  const long = segment(db, turns(300))
  assert.equal(db.read(`t:${long.topicId}`, { count: 10_000 })!.messages.length, 200)
})
