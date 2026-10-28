import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openHistoryDb } from '../src/main/history-db.ts'
import { historyRecall } from '../src/main/history-recall.ts'
import { createHistoryDesk } from '../src/main/history-channel.ts'
import { createHistoryChannel } from '../plugins/history/lib/channel.ts'

/** The assistant looks up the timeline: by words within a time range, with the topic; then reads around a hit. */

const day = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()
type Message = { role: string, text: string, receipt: null }
const said = (role: string, text: string): Message => ({ role, text, receipt: null })

function seeded() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'history-recall-')), 'history.db')
  let clock = day(1)
  const db = openHistoryDb({ file, now: () => clock })
  const at = (when: number, messages: Message[], fields = {}) => {
    clock = when
    return db.save(db.create({ sessionId: 's', ...fields }), messages)
  }
  const contract = at(day(3), [said('user', '审一下合同的付款期限'), said('assistant', '建议改成 30 天'), said('user', '对方要 60 天'), said('assistant', '那就 60 天，违约金按 0.05% 每天')])
  at(day(20), [said('user', '付款期限的模板在哪'), said('assistant', '在共享盘/合同模板')])
  return { db, contract }
}

/** The plugin's channel and the app's desk, joined as dsh joins them. */
function joined(db: ReturnType<typeof openHistoryDb>) {
  const recall = historyRecall(db)
  const port = new EventEmitter()
  const desk = createHistoryDesk({ send: (message) => port.emit('message', message), search: recall.search, read: recall.read, authorized: () => true })
  const channel = createHistoryChannel({ send: (message: object) => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  return (request: object) => channel.request(request, 'main')
}

test('a search within days finds only what was said then, each hit with its topic', async () => {
  const { db } = seeded()
  const ask = joined(db)
  const all = await ask({ query: '付款期限' })
  assert.match(all, /找到 2 条/)
  const early = await ask({ query: '付款期限', since: '2026-10-01', until: '2026-10-10' })
  assert.match(early, /找到 1 条/)
  assert.match(early, /话题「审一下合同的付款期限」 · 你：/)
  assert.match(early, /read_conversation/)
  await assert.rejects(ask({ query: '付款期限', since: '十月' }), /日期要写成/)
})

test('reading around a hit gives what was said before and after it, who said it, the hit marked', async () => {
  const { db } = seeded()
  const ask = joined(db)
  const found = await ask({ query: '对方要', until: '2026-10-10' })
  const link = /原文：(viva:\/\/timeline\/\S+)/.exec(found)![1]
  const read = await ask({ action: 'read', link, around: 2 })
  assert.match(read, /话题「审一下合同的付款期限」里的 4 条记录/)
  assert.match(read, /→ 2026-10-03 10:00 · 你：对方要 60 天/)
  assert.match(read, / 2026-10-03 10:00 · Viva：那就 60 天，违约金按 0\.05% 每天/)
  assert.match(read, /以最后的为准/)
  await assert.rejects(ask({ action: 'read', link: 'https://example.com' }), /原文链接/)
})

test('a message said again since is read as the ones near where it was, not as the original; a deleted one says so', () => {
  const { db, contract } = seeded()
  const recall = historyRecall(db)
  const [hit] = recall.search('违约金')
  db.save(contract, [said('user', '审一下合同的付款期限'), said('assistant', '建议改成 30 天'), said('user', '对方要 60 天'), said('assistant', '按 45 天谈')])
  const missing = recall.read({ segmentId: hit.segmentId, seq: hit.seq, messageId: hit.messageId })
  assert.equal(missing.status, 'missing')
  assert.equal('messages' in missing && missing.messages.some((m) => m.target), false, 'nothing taken for the original')
  db.softDelete(contract.id)
  assert.deepEqual(recall.read({ segmentId: hit.segmentId, seq: hit.seq }), { status: 'deleted' })
})
