import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openHistoryDb } from '../src/main/history-db.ts'

/** 回顾: the topics, the one last talked in first, the background tasks in them, and the messages starred. */

type Db = ReturnType<typeof openHistoryDb>
type Message = { role: string, text: string, receipt: null | Record<string, unknown>, images?: Array<{ id: string }> }

const user = (text: string, extra: Partial<Message> = {}): Message => ({ role: 'user', text, receipt: null, ...extra })
const answer = (text: string): Message => ({ role: 'assistant', text, receipt: { ms: 10, tools: 0, thoughts: 0, stopReason: 'end_turn' } })

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-review-')), 'history.db')
  let clock = 1_000_000
  let seq = 0
  const db = openHistoryDb({ file, now: () => (clock += 1000), newId: () => `c${++seq}` })
  return { db, file }
}

const segment = (db: Db, messages: Message[], fields: Parameters<Db['create']>[0] = {}) => db.save(db.create({ sessionId: 's', ...fields }), messages)

test('topics are listed the one last talked in first, each over all its segments, named by its first', () => {
  const { db } = freshDb()
  const weekly = segment(db, [user('整理周报'), answer('好')], { cwd: '/w/a' })
  const other = segment(db, [user('看看这个\n\n附带的文件（本机路径）：\n- /tmp/a.pdf'), answer('看了')])
  const later = segment(db, [user('加上下周计划'), answer('好')], { parentId: weekly.id, cwd: '/w/b' })

  const { topics, hasMore } = db.review()
  assert.equal(hasMore, false)
  assert.deepEqual(topics.map((t) => t.id), [weekly.topicId, other.topicId])
  const [first] = topics
  assert.deepEqual([first.title, first.turns, first.segments, first.head, first.cwds], ['整理周报', 2, [weekly.id, later.id], later.id, ['/w/a', '/w/b']])
  assert.equal(first.startedAt, weekly.createdAt)
  assert.equal(first.lastAt, later.updatedAt)
  assert.equal(topics[1].hasFiles, true)
})

test('a topic is the same however far the list has been read: what it holds comes from all of it', () => {
  const { db } = freshDb()
  const contract = segment(db, [user('审一下合同', { images: [{ id: `${'a'.repeat(64)}.png` }] }), answer('好')])
  for (let i = 0; i < 4; i += 1) segment(db, [user(`别的事 ${i}`)])
  segment(db, [user('继续改一下付款期限')], { parentId: contract.id })

  const [topic] = db.review({ limit: 1 }).topics
  assert.deepEqual([topic.id, topic.title, topic.turns, topic.hasFiles, topic.startedAt], [contract.id, '审一下合同', 2, true, contract.createdAt])
  assert.deepEqual(db.review({ filter: 'files' }).topics.map((t) => t.id), [contract.id])
})

test('topics last talked in at the same moment are all listed across pages', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-review-')), 'history.db')
  let seq = 0
  const db = openHistoryDb({ file, now: () => 5_000, newId: () => `s${++seq}` })
  for (let i = 0; i < 5; i += 1) segment(db, [user(`同一刻 ${i}`)])

  const first = db.review({ limit: 3 })
  const last = first.topics.at(-1)!
  const rest = db.review({ after: { lastAt: last.lastAt, topicId: last.id }, limit: 3 })
  assert.equal(first.hasMore, true)
  assert.deepEqual([...first.topics, ...rest.topics].map((t) => t.id).toSorted(), ['s1', 's2', 's3', 's4', 's5'])
  assert.equal(rest.hasMore, false)
})

test('a background task is listed under its topic, not counted in its turns; a path left behind is not listed', () => {
  const { db } = freshDb()
  const main = segment(db, [user('一'), answer('答')])
  const task = segment(db, [user('后台整理文档'), answer('在做')], { parentId: main.id })
  db.fold(task.id, { into: main.id, at: 2, kind: 'side' })
  const left = segment(db, [user('走了另一条路')], { parentId: main.id })
  db.fold(left.id, { into: main.id, at: 0 })
  segment(db, [user('二')])

  const topic = db.review().topics.find((t) => t.id === main.topicId)!
  assert.deepEqual(topic.segments, [main.id])
  assert.equal(topic.turns, 1)
  assert.deepEqual(topic.tasks.map((t) => [t.id, t.title, t.turns]), [[task.id, '后台整理文档', 1]])
  assert.deepEqual(db.review({ filter: 'tasks' }).topics.map((t) => t.id), [main.topicId])
})

test('a turn moved to the background is named, counted and read from its own question on', () => {
  const { db } = freshDb()
  const moved = segment(db, [user('报销模板放哪了'), answer('在共享盘'), user('生成一份周报'), answer('在写')])
  const next = segment(db, [user('报销模板放哪了'), answer('在共享盘')], { topicId: moved.topicId })
  db.fold(moved.id, { into: next.id, at: 2, kind: 'task' })

  const [topic] = db.review().topics
  assert.deepEqual([topic.title, topic.turns, topic.segments], ['报销模板放哪了', 1, [next.id]])
  assert.deepEqual(topic.tasks.map((t) => [t.title, t.turns]), [['生成一份周报', 1]])
  assert.deepEqual(db.segmentMessages(moved.id).map((m) => [m.seq, m.text]), [[2, '生成一份周报'], [3, '在写']])
  assert.deepEqual(db.segmentMessages(moved.id, true).map((m) => m.seq), [0, 1, 2, 3])
})

test('a topic is read segment after segment, each message with its segment and id; 回顾 reads a task on its own', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一'), answer('答一')])
  const b = segment(db, [user('二')], { parentId: a.id })
  const task = segment(db, [user('后台')], { parentId: b.id })
  db.fold(task.id, { into: b.id, at: 1, kind: 'side' })

  const read = db.topicMessages(a.topicId)!
  assert.deepEqual(read.messages.map((m) => [m.segmentId, m.seq, m.text]), [[a.id, 0, '一'], [a.id, 1, '答一'], [b.id, 0, '二']])
  assert.equal(read.messages.every((m) => Number.isInteger(m.id)), true)
  assert.deepEqual(db.readerOf(b.id), { key: `t:${a.topicId}`, topicId: a.topicId })
  assert.deepEqual(db.readerOf(task.id), { key: `s:${task.id}`, topicId: a.topicId })
  db.softDelete(b.id)
  assert.equal(db.readerOf(b.id), null)
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
  const texts = (query: string) => db.searchMessages(query).map((hit) => `${hit.snippet.before}${hit.snippet.hit}${hit.snippet.after}`)
  assert.equal(texts('报销 模板').length, 2)
  assert.equal(texts('行政共享盘 报销').length, 1)
  assert.equal(texts('模板   周报').length, 1)
  assert.deepEqual(texts('报销 不存在的词'), [])
  assert.equal(db.searchMessages('报销 模板').every((hit) => Number.isInteger(hit.messageId)), true)
})

test('a star is kept per message, counted on its topic, and listed with the message it marks', () => {
  const { db } = freshDb()
  const a = segment(db, [user('报销模板放哪了'), answer('在 共享盘/行政/报销.xlsx')])
  db.setStar(a.id, 1, true)

  assert.deepEqual(db.starsIn([a.id, 'other']), [{ segmentId: a.id, seq: 1 }])
  assert.equal(db.review().topics[0].stars, 1)
  const [starred] = db.starredMessages()
  assert.deepEqual([starred.segmentId, starred.seq, starred.role, starred.text, starred.title, starred.deleted], [a.id, 1, 'assistant', '在 共享盘/行政/报销.xlsx', '报销模板放哪了', false])

  db.setStar(a.id, 1, false)
  assert.deepEqual(db.starsIn([a.id]), [])
  assert.deepEqual(db.starredMessages(), [])
})

test('a star on a deleted record is listed as deleted until the record is gone for good, then goes with it', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一'), answer('答')])
  db.setStar(a.id, 1, true)
  db.save(a, [user('一')])
  assert.deepEqual(db.starredMessages(), [], 'a message cut off takes its star along')

  const b = segment(db, [user('二')])
  db.setStar(b.id, 0, true)
  db.softDelete(b.id)
  assert.deepEqual(db.starredMessages().map((item) => [item.segmentId, item.deleted]), [[b.id, true]])
  assert.equal(db.review().topics.some((t) => t.id === b.topicId), false)
  db.restore(b.id)
  assert.equal(db.starredMessages()[0].deleted, false)
  db.softDelete(b.id)
  db.purgeDeleted({ olderThanMs: 0 })
  assert.deepEqual(db.starredMessages(), [])
})

test('a star on a message that does not exist is refused', () => {
  const { db } = freshDb()
  assert.throws(() => db.setStar('nope', 0, true), /找不到这条消息/)
})

test('a message keeps its id while it finishes; said again differently it is another one, and its star goes', () => {
  const { db } = freshDb()
  const a = segment(db, [user('写首诗'), answer('春')])
  const idOf = (seq: number) => db.timelineOf(a.id).find((m) => m.seq === seq)!.id
  const first = idOf(1)
  db.save(a, [user('写首诗'), answer('春眠不觉晓')])
  assert.equal(idOf(1), first, 'the same answer going on')
  db.setStar(a.id, 1, true)

  db.save(a, [user('写首诗'), answer('床前明月光')])
  assert.notEqual(idOf(1), first, 'redone: another message')
  assert.deepEqual(db.starsIn([a.id]), [])

  const before = idOf(1)
  db.save(a, [user('写首诗')])
  db.save(a, [user('写首诗'), answer('白日依山尽')])
  assert.ok(idOf(1) > before, 'an id cut off is never given again, so a link to it cannot name another message')
})

test('a message named by a link or a star is found where it is now, or said to be missing or deleted', () => {
  const { db } = freshDb()
  const a = segment(db, [user('写首诗'), answer('春眠不觉晓'), user('再来一首'), answer('床前明月光')])
  const named = db.timelineOf(a.id).find((m) => m.seq === 3)!
  assert.deepEqual(db.locate({ segmentId: a.id, seq: 3, messageId: named.id }), { status: 'found', segmentId: a.id, seq: 3, messageId: named.id })
  assert.equal(db.locate({ segmentId: a.id, seq: 3 }).status, 'found', 'a link from before ids were kept names its place')

  db.save(a, [user('写首诗'), answer('春眠不觉晓'), user('再来一首'), answer('白日依山尽')])
  assert.deepEqual(db.locate({ segmentId: a.id, seq: 3, messageId: named.id }), { status: 'missing', segmentId: a.id, seq: 3 })
  db.save(a, [user('写首诗'), answer('春眠不觉晓')])
  assert.deepEqual(db.locate({ segmentId: a.id, seq: 3, messageId: named.id }), { status: 'missing', segmentId: a.id, seq: 1 })

  db.softDelete(a.id)
  assert.deepEqual(db.locate({ segmentId: a.id, seq: 1 }), { status: 'deleted', segmentId: a.id })
  db.purgeDeleted({ olderThanMs: 0 })
  assert.deepEqual(db.locate({ segmentId: a.id, seq: 1, messageId: named.id }), { status: 'deleted', segmentId: a.id })
})

test('a segment takes its topic when first saved: its parent’s, the one given, or its own; and keeps it', () => {
  const { db } = freshDb()
  const a = segment(db, [user('一')])
  const b = segment(db, [user('二')], { parentId: a.id })
  const back = segment(db, [user('一'), user('换个说法')], { topicId: a.topicId })
  const alone = segment(db, [user('新话题')])
  assert.deepEqual([a.topicId, b.topicId, back.topicId, alone.topicId], [a.id, a.id, a.id, alone.id])

  db.softDelete(a.id)
  db.purgeDeleted({ olderThanMs: 0 })
  db.save(b, [user('二'), answer('答')])
  assert.equal(db.topicOf(b.id), a.id, 'deleting the first segment leaves the rest where they were')
  assert.deepEqual(db.review().topics.map((t) => t.id).toSorted(), [a.id, alone.id].toSorted())
})

/** A file from before topics were kept: the same segments with no topic_id. */
function withoutTopics(file: string, change = '') {
  const raw = new DatabaseSync(file)
  if (change) raw.exec(change)
  raw.exec('UPDATE conversations SET topic_id = NULL')
  raw.close()
}

test('a file from before gets its topics once, from how its segments go on from each other', () => {
  const { db, file } = freshDb()
  const a = segment(db, [user('一'), answer('答')])
  const b = segment(db, [user('换目录接着聊')], { parentId: a.id })
  const back = segment(db, [user('一'), user('换个说法')])
  db.fold(a.id, { into: back.id, at: 1 })
  const side = segment(db, [user('后台做')], { parentId: b.id })
  db.fold(side.id, { into: b.id, at: 1, kind: 'side' })
  const alone = segment(db, [user('新话题')])
  const orphan = segment(db, [user('父段已清掉')], { parentId: 'gone' })
  db.close()
  withoutTopics(file)

  const ids = [a, b, back, side, alone, orphan].map((s) => s.id)
  const reopened = openHistoryDb({ file })
  const topics = ids.map((id) => reopened.topicOf(id))
  assert.deepEqual(topics, [a.id, a.id, a.id, a.id, alone.id, orphan.id])
  reopened.close()

  const again = openHistoryDb({ file })
  assert.deepEqual(ids.map((id) => again.topicOf(id)), topics, 'opening again changes nothing')
})

test('links that come back round are one topic, started by its oldest segment', () => {
  const { db, file } = freshDb()
  const a = segment(db, [user('一')])
  const b = segment(db, [user('二')], { parentId: a.id })
  db.close()
  withoutTopics(file, `UPDATE conversations SET parent_id = '${b.id}' WHERE id = '${a.id}'`)

  const reopened = openHistoryDb({ file })
  assert.deepEqual([reopened.topicOf(a.id), reopened.topicOf(b.id)], [a.id, a.id])
})
