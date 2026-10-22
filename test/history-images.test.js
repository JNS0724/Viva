import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { earlierRows, historyMessages } from '../src/renderer/selectors.ts'

/** Pictures pasted with a question: kept with the message, by name, through saving, reopening and the timeline. */

const PIC = { id: `${'a'.repeat(64)}.png` }
const freshDb = () => openHistoryDb({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-images-')), 'history.db') })

test('a question\'s pictures are saved with it and come back when the conversation is opened', () => {
  const db = freshDb()
  const saved = db.save(db.create({ sessionId: 's-1' }), [
    { role: 'user', text: '这是什么', receipt: null, images: [PIC] },
    { role: 'assistant', text: '一张图', receipt: null },
  ])
  const { messages } = db.get(saved.id)
  assert.deepEqual(messages[0].images, [PIC])
  assert.equal('images' in messages[1], false, 'messages without pictures say nothing about them')
  db.close()
})

test('the earlier part of the timeline shows a segment\'s pictures too', () => {
  const db = freshDb()
  const first = db.save(db.create({ sessionId: 's-1' }), [{ role: 'user', text: '看图', receipt: null, images: [PIC] }])
  const later = db.save(db.create({ sessionId: 's-2' }), [{ role: 'user', text: '下一个', receipt: null }])
  const { segments } = db.segmentsBefore(later.id)
  assert.equal(segments[0].id, first.id)
  assert.deepEqual(segments[0].messages[0].images, [PIC])
  const rows = earlierRows({ segments }, { now: Date.now() }).filter((row) => row.kind === 'message')
  assert.deepEqual(rows[0].images, [PIC])
  db.close()
})

test('only picture names are stored; anything else is refused', () => {
  const db = freshDb()
  assert.throws(() => db.save(db.create({}), [{ role: 'user', text: 'x', receipt: null, images: [{ id: '../secret' }] }]), /images/)
  db.close()
})

test('a question sent with pictures carries them in the thread, in what is saved, and when reopened', () => {
  const asked = reduce(initialState, { type: 'user_prompt', text: '这是什么', at: 1, images: [PIC] })
  assert.deepEqual(asked.messages[0].images, [PIC])
  assert.deepEqual(historyMessages(asked)[0], { role: 'user', text: '这是什么', receipt: null, images: [PIC] })
  const reopened = reduce(initialState, { type: 'history_loaded', conversationId: 'c1', messages: [{ role: 'user', text: '这是什么', images: [PIC] }], savedAt: 1 })
  assert.deepEqual(reopened.messages[0].images, [PIC])
  const plain = reduce(initialState, { type: 'user_prompt', text: '没有图', at: 1 })
  assert.equal('images' in plain.messages[0], false)
})
