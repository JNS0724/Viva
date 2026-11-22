import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openIndependentHistory as openHistoryDb } from './fixtures/independent-history.ts'
import { historyRecall, historyRecallAsync } from '../src/backend/history-recall.ts'
import { verifiedHistoryCarry, publishHistoryCarry } from '../src/backend/history-carry.ts'
import { createHistoryDesk } from '../src/backend/history-channel.ts'
import { createHistoryChannel } from '../plugins/history/lib/channel.ts'

/** The assistant looks up the timeline: by words within a time range, with the topic; then reads around a hit. */

const day = (d: number, h = 10) => new Date(2026, 9, d, h).getTime()
type Message = { role: string, text: string, receipt: null }
const said = (role: string, text: string): Message => ({ role, text, receipt: null })

for (const phase of ['authorize', 'use'] as const) test(`history read and carry reject an erasure while awaiting ${phase}`, async t => {
  const db = openHistoryDb({ file: ':memory:' })
  t.after(() => db.close())
  const sourceId = randomUUID(), text = 'private fragment then independent tail'
  const segment = db.save(db.create({ sessionId: randomUUID() }), [{ role: 'user', text, receipt: null, sourceId }])
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const cut = () => db.eraseFileRanges([{ sourceId, revision: 1, length: text.length, hash: hash(text),
    afterHash: hash(' '.repeat(16) + text.slice(16)), spans: [{ start: 0, end: 16 }] }])
  const revision = db.fileErasureRevision()
  const rows = db.read(`s:${segment.id}`)!.messages
  const allowed = async () => { if (phase === 'authorize') cut(); return true }
  const used = async () => { if (phase === 'use') cut() }
  const recall = historyRecallAsync(db, allowed, used)
  assert.deepEqual(await recall.read({ segmentId: segment.id, seq: 0 }), { status: 'deleted' })
  const carry = await verifiedHistoryCarry(rows, allowed, revision, db.fileErasureRevision)
  assert.deepEqual(carry, { text: '', turns: 0, evidence: [], revision })
  assert.ok(!db.get(segment.id)!.messages[0]!.text.includes('private'))
})

test('carry publication rechecks its version after transferring sources and preserves a fresh retry', async () => {
  let revision = 0, selected = true
  const row = { segmentId: 'segment', role: 'user', text: 'safe words', sourceId: randomUUID() }
  const carry = await verifiedHistoryCarry([row], async () => true, revision, () => revision)
  const published: string[] = []
  assert.equal(await publishHistoryCarry(carry, () => selected && carry.revision === revision,
    async () => { revision++ }, () => published.push(carry.text)), false)
  const fresh = await verifiedHistoryCarry([row], async () => true, revision, () => revision)
  assert.equal(await publishHistoryCarry(fresh, () => selected && fresh.revision === revision,
    async () => { selected = false }, () => published.push(fresh.text)), false)
  selected = true
  assert.equal(await publishHistoryCarry(fresh, () => selected && fresh.revision === revision,
    async () => {}, () => published.push(fresh.text)), true)
  assert.equal(published.length, 1)
})

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
  const desk = createHistoryDesk({ send: (message) => port.emit('message', message), search: recall.search,
    read: (ref, around) => recall.read(ref, around), authorized: () => true })
  const channel = createHistoryChannel({ send: (message: object) => desk.receive(message), on: port.on.bind(port), off: port.off.bind(port) })
  return (request: object) => channel.request(request, 'main')
}

test('a search within days finds only what was said then, each hit with its topic and cwd when present', async () => {
  const { db } = seeded()
  const ask = joined(db)
  const all = await ask({ query: '付款期限' })
  assert.match(all, /找到 2 条/)
  const early = await ask({ query: '付款期限', since: '2026-10-01', until: '2026-10-10' })
  assert.match(early, /找到 1 条/)
  assert.match(early, /话题「审一下合同的付款期限」 · 你：/)
  assert.match(early, /read_conversation/)
  assert.doesNotMatch(early, /目录：/)
  db.save(db.create({ sessionId: 's-dir', cwd: '/repo/alpha' }), [said('user', '付款期限改到 15 天')])
  const withDir = await ask({ query: '付款期限' })
  assert.match(withDir, /目录：\/repo\/alpha/)
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

test('a rewind copy cannot turn an old assistant answer into output from the new session', () => {
  const { db, contract } = seeded()
  const next = db.create({ sessionId: 'fresh', topicId: db.topicOf(contract.id) })
  const old = db.get(contract.id)!.messages.slice(0, 2)
  db.save(next, [...old, said('user', '继续审合同')], { copy: { from: contract.id, count: 2 } })
  const used: string[] = []
  const recall = historyRecall(db, message => message.role === 'user' || message.sessionId === 'fresh', message => used.push(message.text))
  assert.equal(recall.search('建议改成 30 天').length, 0)
  assert.equal(recall.search('继续审合同').length, 1)
  assert.deepEqual(used, ['继续审合同'])
})

test('late routed output can move a message without changing its memory evidence or originating session', t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  const db = openHistoryDb({ db: database })
  const sourceId = randomUUID()
  const question = { ...said('user', '记住项目北辰'), key: 'user-route-key', sourceId }
  const answer = { ...said('assistant', '已记下'), key: 'answer-route-key' }
  const segment = db.save(db.create({ sessionId: 'old-session' }), [question, answer])
  const link = db.sourceLink(sourceId, segment.id)
  const before = db.timelineOf(segment.id)
  assert.ok(link?.includes('/0/'))

  db.save({ ...segment, sessionId: 'current-session' }, [
    { ...said('assistant', '上一轮延迟出现的回复'), key: 'late-answer-key' }, question, answer,
  ])

  const messages = db.read(`s:${segment.id}`)!.messages
  assert.deepEqual(messages.slice(1).map(row => [row.seq, row.id, row.key, row.sourceId, row.sessionId]), [
    [1, before[0].id, question.key, sourceId, 'old-session'],
    [2, before[1].id, answer.key, undefined, 'old-session'],
  ])
  assert.equal(db.sourceLink(sourceId, segment.id), `viva://timeline/${segment.id}/1/${before[0].id}`)
})

for (const action of ['search', 'read'] as const) test(`history ${action} does not return a result after the session expires during owner admission`, async () => {
  let current = true, release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const results: object[] = []
  const desk = createHistoryDesk({ send: message => { results.push(message) }, authorized: () => current,
    search: async () => { await waiting; return [] },
    read: async () => { await waiting; return { status: 'deleted' as const } },
  })
  const pending = desk.receive({ type: 'history_query', id: 'late-query', sessionId: 'session', request: action === 'read'
    ? { action: 'read', link: 'viva://timeline/segment/0' } : { query: '原文' } })
  current = false
  release()
  await pending
  assert.deepEqual(results, [{ type: 'history_result', id: 'late-query', ok: false, text: '会话已失效，无法查询聊天记录' }])
})
