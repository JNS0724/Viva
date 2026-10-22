import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { migrateLegacyHistory } from '../src/main/history-migrate.ts'
import { autoTitle, normalizeMessages, normalizeTitle } from '../src/main/history-schema.ts'

const receipt = { ms: 4200, tools: 2, thoughts: 1, stopReason: 'end_turn' }
const MESSAGES = [
  { role: 'user', text: '整理文件', receipt: null },
  { role: 'assistant', text: '好了', receipt },
]

test('normalizeMessages keeps role, text and receipt, and drops UI-only fields', () => {
  const input = [{ id: 'm0', role: 'assistant', text: '你好', shown: 1, open: false, restored: true, receipt }]

  assert.deepEqual(normalizeMessages(input), [{ role: 'assistant', text: '你好', receipt }])
  assert.deepEqual(normalizeMessages([{ role: 'note', text: '已停止', receipt: { ...receipt, extra: 1 } }])[0].receipt, receipt)
})

test('normalizeMessages rejects anything that is not a list of valid messages', () => {
  assert.throws(() => normalizeMessages('nope'), /消息列表/)
  assert.throws(() => normalizeMessages([{ role: 'system', text: 'x' }]), /role/)
  assert.throws(() => normalizeMessages([{ role: 'user', text: 42 }]), /text/)
  assert.throws(() => normalizeMessages([{ role: 'user', text: 'x', receipt: { ms: -1 } }]), /receipt/)
  assert.throws(() => normalizeMessages(Array.from({ length: 5001 }, () => MESSAGES[0])), /太多/)
})

test('titles: automatic ones come from the first question, custom ones are trimmed and bounded', () => {
  assert.equal(autoTitle([{ role: 'assistant', text: '欢迎' }, { role: 'user', text: '  多行\n问题  ' }]), '多行 问题')
  assert.equal(autoTitle([{ role: 'user', text: 'a😀'.repeat(15) }]), `${'a😀'.repeat(10)}…`)
  assert.equal(autoTitle([]), '')
  assert.equal(normalizeTitle('  周报  '), '周报')
  assert.throws(() => normalizeTitle('x'.repeat(81)), /标题/)
})

function legacyDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'))
  const dir = path.join(root, 'history')
  fs.mkdirSync(dir)
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data))
  return { root, dir, write }
}

test('legacy JSON history is imported once, keeping timestamps, and the old folder is kept as a backup', () => {
  // Arrange
  const { root, dir, write } = legacyDir()
  write('a.json', { version: 1, id: 'a', createdAt: 10, updatedAt: 20, sessionId: 's-a', messages: MESSAGES })
  write('broken.json', '{ nope')
  write('notes.txt', 'ignored')
  const db = openHistoryDb({ file: path.join(root, 'history.db') })
  const errors = []

  // Act
  const imported = migrateLegacyHistory({ dir, db, onError: (err) => errors.push(err.message) })
  const again = migrateLegacyHistory({ dir, db })

  // Assert
  assert.equal(imported, 1)
  assert.equal(again, 0)
  assert.equal(errors.length, 1)
  const { conversation, messages } = db.get('a')
  assert.deepEqual([conversation.createdAt, conversation.updatedAt, conversation.sessionId, conversation.title], [10, 20, 's-a', '整理文件'])
  assert.deepEqual(messages, MESSAGES)
  assert.deepEqual(db.sessionIds('a'), ['s-a'])
  assert.equal(fs.existsSync(dir), false)
  assert.deepEqual(fs.readdirSync(`${dir}-imported`).sort(), ['a.json', 'broken.json', 'notes.txt'])
})

test('legacy import does nothing when there is no old folder', () => {
  const { root } = legacyDir()
  const db = openHistoryDb({ file: path.join(root, 'history.db') })
  assert.equal(migrateLegacyHistory({ dir: path.join(root, 'missing'), db }), 0)
})
