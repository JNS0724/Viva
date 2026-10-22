import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'

const receipt = { ms: 4200, tools: 2, thoughts: 1, stopReason: 'end_turn' }
const user = (text) => ({ role: 'user', text, receipt: null })
const answer = (text, withReceipt = receipt) => ({ role: 'assistant', text, receipt: withReceipt })
const DAY = 86_400_000

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-db-')), 'history.db')
  let clock = 1_000_000
  let seq = 0
  const db = openHistoryDb({ file, now: () => (clock += 1000), newId: () => `c${++seq}` })
  return { db, file, advance: (ms) => { clock += ms } }
}

/** Creates and saves a conversation in one go. */
function saved(db, messages, fields = {}) {
  return db.save({ ...db.create({ sessionId: 's-1', mode: 'live', model: 'V4', ...fields }), }, messages)
}

test('a new conversation is not written until it has messages', () => {
  const { db } = freshDb()
  const fresh = db.create({ sessionId: 's-1', mode: 'live', model: 'V4' })

  db.save(fresh, [])

  assert.equal(db.latest(), null)
  assert.deepEqual(db.list(), { items: [], hasMore: false })
})

test('saving keeps messages in order, titles from the first question, and reloads intact', () => {
  // Arrange
  const { db, file } = freshDb()

  // Act
  const conversation = saved(db, [user('帮我把工作区里的资料整理成一份摘要，越短越好'), answer('好的')])
  const reopened = openHistoryDb({ file }).get(conversation.id)

  // Assert
  assert.equal(conversation.title, '帮我把工作区里的资料整理成一份摘要，越短…')
  assert.deepEqual(reopened.messages, [user('帮我把工作区里的资料整理成一份摘要，越短越好'), answer('好的')])
  assert.deepEqual([reopened.conversation.sessionId, reopened.conversation.model], ['s-1', 'V4'])
})

test('saving again only appends new messages and updates the last one, keeping each message session', () => {
  const { db } = freshDb()
  const first = saved(db, [user('一'), answer('回答一', null)])

  const resumedElsewhere = { ...first, sessionId: 's-2' }
  db.save(resumedElsewhere, [user('一'), answer('回答一'), user('二'), answer('回答二')])

  assert.deepEqual(db.get(first.id).messages.map((m) => m.receipt?.tools ?? null), [null, 2, null, 2])
  assert.deepEqual(db.sessionIds(first.id), ['s-1', 's-2'])
  assert.equal(db.get(first.id).conversation.sessionId, 's-2')
})

test('list puts pinned first, then most recent, and pages through the rest', () => {
  const { db } = freshDb()
  const old = saved(db, [user('最早')])
  const middle = saved(db, [user('中间')])
  const recent = saved(db, [user('最新')])
  db.setPinned(old.id, true)

  const firstPage = db.list({ limit: 2 })
  const secondPage = db.list({ offset: 2, limit: 2 })

  assert.deepEqual(firstPage.items.map((c) => [c.title, c.pinned]), [['最早', true], ['最新', false]])
  assert.equal(firstPage.hasMore, true)
  assert.deepEqual(secondPage, { items: [{ ...secondPage.items[0], title: '中间' }], hasMore: false })
  assert.equal(secondPage.items[0].id, middle.id)
  assert.equal(db.latest().conversation.id, recent.id)
})

test('rename sticks even after more messages are saved', () => {
  const { db } = freshDb()
  const conversation = saved(db, [user('原来的问题')])

  db.rename(conversation.id, '  周报整理  ')
  db.save(db.get(conversation.id).conversation, [user('原来的问题'), answer('好')])

  assert.equal(db.get(conversation.id).conversation.title, '周报整理')
  assert.throws(() => db.rename(conversation.id, '   '), /标题/)
})

test('search finds long and short Chinese queries in messages and titles, with a snippet around the hit', () => {
  const { db } = freshDb()
  const notes = saved(db, [user('整理周会纪要'), answer('第一项：接口联调还没有完成，需要在周五前确认负责人。')])
  saved(db, [user('今天天气怎么样'), answer('晴')])

  const long = db.search('接口联调')
  const short = db.search('晴')
  const title = db.search('周会')

  assert.deepEqual(long.map((r) => r.id), [notes.id])
  assert.deepEqual(long[0].snippet, { before: '第一项：', hit: '接口联调', after: '还没有完成，需要在周五前确认负责人。' })
  assert.deepEqual(short.map((r) => r.title), ['今天天气怎么样'])
  assert.deepEqual(title.map((r) => r.id), [notes.id])
  assert.deepEqual(db.search('  '), [])
  assert.deepEqual(db.search('"引号" OR *'), [])
})

test('deleted conversations disappear at once, can be restored, and are purged for good later', () => {
  const { db, advance } = freshDb()
  const keep = saved(db, [user('保留')])
  const gone = saved(db, [user('删掉的内容')])

  db.softDelete(gone.id)
  const hidden = db.list().items.map((c) => c.id)
  db.restore(gone.id)
  const back = db.list().items.map((c) => c.id)
  db.softDelete(gone.id)
  advance(DAY)
  db.purgeDeleted({ olderThanMs: 8000 })

  assert.deepEqual(hidden, [keep.id])
  assert.deepEqual(back, [gone.id, keep.id])
  assert.equal(db.get(gone.id), null)
  assert.deepEqual(db.search('删掉的内容'), [])
  assert.equal(db.latest().conversation.id, keep.id)
})

test('history db rejects bad input before touching the database', () => {
  const { db } = freshDb()
  assert.throws(() => db.save({ ...db.create({}), id: '../x' }, [user('x')]), /id/)
  assert.throws(() => db.save(db.create({}), [{ role: 'system', text: 'x' }]), /role/)
  assert.equal(db.get('missing'), null)
})
