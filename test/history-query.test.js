import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { createHistoryDesk, historyAnswer } from '../src/main/history-channel.ts'
import { createHistoryChannel } from '../plugins/history/lib/channel.ts'

/** search_conversations: the assistant looks up what was said before, and says where it is with a link. */

const hit = (fields = {}) => ({
  segmentId: 'seg-1', seq: 3, role: 'assistant', at: new Date(2026, 9, 25, 14, 20).getTime(), cwd: '/w/viva',
  snippet: { before: '模板在 ', hit: '报销', after: '.xlsx 里' },
  before: { role: 'user', text: '报销模板放哪了' }, after: null, ...fields,
})

test('the answer lists each hit with when, who, the words around it and a link back to it', () => {
  const text = historyAnswer('报销', [hit()])
  assert.match(text, /找到 1 条/)
  assert.match(text, /2026-10-25 14:20/)
  assert.match(text, /Viva：模板在 报销\.xlsx 里/)
  assert.match(text, /前一句（你）：报销模板放哪了/)
  assert.match(text, /viva:\/\/timeline\/seg-1\/3/)
})

test('nothing found says so plainly, so the model does not make it up', () => {
  assert.match(historyAnswer('不存在', []), /没有找到/)
})

test('the plugin asks the app over the process channel and gets the answer back', async () => {
  const port = new EventEmitter()
  const asked = []
  const desk = createHistoryDesk({
    send: (message) => port.emit('message', message),
    search: (query) => { asked.push(query); return [hit()] },
    authorized: (id) => id === 'main',
  })
  const channel = createHistoryChannel({ send: (message) => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  const text = await channel.request({ query: '报销' }, 'main')
  assert.deepEqual(asked, ['报销'])
  assert.match(text, /viva:\/\/timeline\/seg-1\/3/)
})

test('the keywords the tool suggests, apart, find what a real history has, through the plugin channel', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-query-')), 'history.db')
  const db = openHistoryDb({ file })
  db.save(db.create({}), [{ role: 'user', text: '报销模板放哪里', receipt: null }, { role: 'assistant', text: '报销模板在行政共享盘', receipt: null }])
  const port = new EventEmitter()
  const desk = createHistoryDesk({ send: (message) => port.emit('message', message), search: (query) => db.searchMessages(query), authorized: () => true })
  const channel = createHistoryChannel({ send: (message) => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  const text = await channel.request({ query: '报销 模板' }, 'main')
  assert.match(text, /找到 2 条/)
})

test('a session the app does not know, or an empty query, is refused', async () => {
  const port = new EventEmitter()
  const desk = createHistoryDesk({ send: (message) => port.emit('message', message), search: () => [], authorized: (id) => id === 'main' })
  const channel = createHistoryChannel({ send: (message) => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  await assert.rejects(channel.request({ query: '报销' }, 'stranger'), /会话已失效/)
  await assert.rejects(channel.request({ query: '  ' }, 'main'), /关键词/)
})
