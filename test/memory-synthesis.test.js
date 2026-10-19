import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { contextForTurn } from '../plugins/memory/lib/inject.js'
import { openMemoryDb } from '../plugins/memory/lib/store.js'
import {
  checkSynthesis, SYNTHESIS_INTERVAL_MS, SYNTHESIS_MIN_CHANGES, synthesisDue, synthesisInput, synthesizeProfile,
} from '../plugins/memory/lib/synthesize.js'

const HOUR = 60 * 60 * 1000

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-synthesis-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tempDb(t, now) {
  const db = openMemoryDb({ file: path.join(tempDir(t), 'memory.db'), now })
  t.after(() => db.close())
  return db
}

const reply = (text) => async () => text

test('a synthesis is due when something changed and there is none, it is a day old, or much changed', () => {
  const latest = { createdAt: 0 }
  assert.equal(synthesisDue({ latest: null, changes: 0, now: 0 }), false, 'nothing to say yet')
  assert.equal(synthesisDue({ latest: null, changes: 1, now: 0 }), true)
  assert.equal(synthesisDue({ latest, changes: 1, now: HOUR }), false, 'one change waits for the day to pass')
  assert.equal(synthesisDue({ latest, changes: 1, now: SYNTHESIS_INTERVAL_MS }), true)
  assert.equal(synthesisDue({ latest, changes: SYNTHESIS_MIN_CHANGES, now: HOUR }), true)
  assert.equal(synthesisDue({ latest, changes: 0, now: 10 * SYNTHESIS_INTERVAL_MS }), false, 'nothing changed, nothing to redo')
})

test('only the agreed form is kept: known headings in order, then "- " lines', () => {
  assert.equal(checkSynthesis('【身份与职责】\n- 支付平台部后端负责人\n\n【偏好】\n- 先给结论'), '【身份与职责】\n- 支付平台部后端负责人\n【偏好】\n- 先给结论')
  assert.throws(() => checkSynthesis(''), /空的/)
  assert.throws(() => checkSynthesis('好的，以下是画像：\n【偏好】\n- x'), /格式/)
  assert.throws(() => checkSynthesis('【偏好】\n- x\n【身份与职责】\n- y'), /顺序/)
  assert.throws(() => checkSynthesis('【爱好】\n- x'), /小标题/)
})

test('the synthesis reads the valid profile memories and the user profile, never the email or invalid memories', (t) => {
  const db = tempDb(t)
  db.setProfile({ role: '后端负责人', email: 'me@corp.example' })
  const old = db.addMemory({ text: '直属上级是张三', kind: 'person', source: 'agent' }).memory
  db.addMemory({ text: '直属上级是李四', kind: 'person', source: 'agent' })
  db.addMemory({ text: '对账服务 11 月迁移', kind: 'fact', source: 'agent' })
  db.invalidateMemory(old.id, { by: 'agent' })

  const input = JSON.parse(synthesisInput({ profile: db.getProfile(), memories: db.profileMemories() }))
  assert.deepEqual(input.userProfile, { role: '后端负责人' })
  assert.deepEqual(input.memories.map((m) => m.text), ['直属上级是李四'])
})

test('a due synthesis is saved; one in a bad form or with a secret is dropped and the old one stays', async (t) => {
  let clock = 1000
  const db = tempDb(t, () => clock)
  assert.equal(await synthesizeProfile({ db, complete: reply('不会被调用'), now: clock }), null, 'no memories, nothing to do')
  db.addMemory({ text: '回答先给结论', kind: 'preference', source: 'agent' })

  const saved = await synthesizeProfile({ db, complete: reply('【偏好】\n- 回答先给结论'), now: clock })
  assert.deepEqual([saved.text, saved.createdAt], ['【偏好】\n- 回答先给结论', 1000])
  clock = 2000
  assert.equal(await synthesizeProfile({ db, complete: reply('x'), now: clock }), null, 'nothing changed since')

  clock = 3000
  db.addMemory({ text: '张三是直属上级', kind: 'person', source: 'agent' })
  clock = 1000 + SYNTHESIS_INTERVAL_MS
  await assert.rejects(synthesizeProfile({ db, complete: reply('以下是画像'), now: clock }), /格式/)
  await assert.rejects(synthesizeProfile({ db, complete: reply('【身份与职责】\n- 密码是 hunter2'), now: clock }), /不会被记住/)
  assert.equal(db.latestSynthesis().text, '【偏好】\n- 回答先给结论')
})

test('the fixed layer carries the latest synthesis and only the profile memories written after it', (t) => {
  let clock = 1000
  const db = tempDb(t, () => clock)
  db.addMemory({ text: '回答先给结论', kind: 'preference', source: 'agent' })
  clock = 2000
  db.saveSynthesis('【偏好】\n- 回答先给结论')
  clock = 3000
  db.addMemory({ text: '李四是直属上级', kind: 'person', keywords: ['李四'], source: 'agent' })

  const text = contextForTurn(db, { sessionId: 's-1', turn: 1, question: '你好', epoch: 0, today: '2026-10-18（周日）' })
  assert.match(text, /【助手整理的画像】\n【偏好】\n- 回答先给结论\n【最近了解到的】\n- （\d{4}-\d{2}-\d{2}）李四是直属上级\n/)
  assert.equal(text.match(/回答先给结论/g).length, 1, 'what the synthesis covers is not listed again')
})

test('a new synthesis sends the fixed layer again; a memory learned mid-session does not', (t) => {
  let clock = 1000
  const db = tempDb(t, () => clock)
  db.addMemory({ text: '回答先给结论', kind: 'preference', source: 'agent' })
  const ask = (turn) => contextForTurn(db, { sessionId: 's-1', turn, question: '继续说', epoch: 0, today: '2026-10-18（周日）' })
  ask(1)
  clock = 2000
  db.addMemory({ text: '李四是直属上级', kind: 'person', source: 'agent' })
  assert.equal(ask(2), '', 'learned in this session: the model has it')
  clock = 3000
  db.saveSynthesis('【常打交道的人】\n- 李四是直属上级')
  assert.match(ask(3), /【助手整理的画像】/)
})

test('what the agent once appended to the profile becomes its memories; the user fields stay', (t) => {
  const file = path.join(tempDir(t), 'memory.db')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE profile (field TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO profile VALUES ('people', '张三：直属上级' || char(10) || '李四', 'agent', 1);
    INSERT INTO profile VALUES ('role', '后端负责人', 'user', 1);`)
  old.close()

  const db = openMemoryDb({ file })
  assert.deepEqual(Object.keys(db.getProfile()), ['role'])
  assert.deepEqual(db.listMemories().items.map((m) => [m.text, m.kind, m.source]).sort(), [
    ['常打交道的人：张三：直属上级', 'person', 'agent'],
    ['常打交道的人：李四', 'person', 'agent'],
  ])
  assert.deepEqual(db.claimChanges(0, 'conv').memories, [], 'moved, not newly learned: no "已记住" for them')
  db.close()
  const reopened = openMemoryDb({ file })
  t.after(() => reopened.close())
  assert.equal(reopened.listMemories().total, 2, 'runs once')
})
