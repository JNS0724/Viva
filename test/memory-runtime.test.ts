import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { historyRecall } from '../src/backend/history-recall.ts'
import { localDay, resolveMemoryTime } from '../src/backend/memory-facts.ts'
import type { MemoryCompute, MemoryProposal, MemoryTemporal } from '../src/shared/memory-contract.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { resolve, promise }
}

const origin = { conversation: 'first-conversation', session: 'first-session' }
const proposal = (text: string, props: Partial<MemoryProposal> = {}) => JSON.stringify({ proposals: [{
  spans: [{ start: 0, end: text.length }], kind: 'fact', scope: 'user', modality: 'asserted',
  attribution: 'self', keywords: [], ...props,
}] })

function fixture(t: TestContext, extract: (job: MemoryCompute) => Promise<string> | null = () => null, now = Date.now,
  review: (job: MemoryCompute) => Promise<string> | null = job => Promise.resolve(confirmedReviews(job))) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-memory-runtime-'))
  const file = path.join(dir, 'memory.db')
  let current: ReturnType<typeof createMemoryRuntime> | undefined
  let store: ReturnType<typeof openMemoryStore>
  const notifications: number[][] = []
  function start() {
    current?.close()
    store = openMemoryStore(file, now)
    current = createMemoryRuntime({ store, compute: job => job.stage === 'review' ? review(job) : extract(job), route: () => ({ provider: 'fake', model: 'fake' }),
      now, quiesce: async () => {}, changed: change => notifications.push(change.ids) })
    return { memory: current, store }
  }
  t.after(() => { current?.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { start, file, dir, notifications }
}

test('receipt and extraction recover with the same source ID after restart', async t => {
  let connected = false
  const text = '我住在紫藤城'
  const f = fixture(t, () => connected ? Promise.resolve(proposal(text)) : null)
  const first = f.start()
  const op = randomUUID()
  assert.equal(first.memory.accept(text, origin, op).outcome, 'pending')
  await first.memory.wake()
  connected = true
  const second = f.start()
  await second.memory.wake()
  assert.equal(second.memory.accept(text, origin, op).outcome, 'accepted')
  assert.equal(second.memory.listMemories().items[0].text, text)
  assert.deepEqual(second.memory.listMemories().items[0].evidence.map(item => item.sourceId), [op])
  assert.throws(() => second.memory.accept('我住在松木城', origin, op))
  assert.equal(second.store.db.prepare('SELECT count(*) AS n FROM effects').get()?.n, 0)
})

test('deletion clears a value quoted by an unrelated pending answer without consuming its receipt', async t => {
  let connected = false
  const marker = 'amber-cleanup-9d2a@example.com'
  const answer = '先使用提交时的规则'
  const answerId = randomUUID()
  const deleteId = randomUUID()
  const inputs: object[] = []
  const f = fixture(t, job => {
    if (!connected) return null
    if (job.sourceId === answerId) inputs.push(JSON.parse(job.input))
    return Promise.resolve('{"proposals":[]}')
  })
  const { memory, store } = f.start()
  const entry = memory.addMemory(`我的周报提交邮箱是 ${marker}`)
  assert.ok(entry)
  const details = { question: `刚才的邮箱 ${marker} 是否用于这次？`, requestId: 'request', questionId: 'submission', custom: true } as const
  assert.equal(memory.accept(answer, origin, answerId, details).outcome, 'pending')
  await memory.wake()
  assert.equal(store.readSource(answerId)?.question, details.question)

  assert.deepEqual(await memory.deleteMemory(entry.id, entry.revision, deleteId), { status: 'cleared' })
  assert.equal(store.readSource(answerId)?.question, null)
  assert.equal(store.readSource(answerId)?.text, answer)
  for (const name of [f.file, `${f.file}-wal`]) assert.equal(fs.readFileSync(name).includes(marker), false, name)

  connected = true
  const restarted = f.start()
  assert.equal(restarted.memory.accept(answer, origin, answerId, details).outcome, 'pending')
  await restarted.memory.wake()
  assert.equal(inputs.length, 1)
  assert.equal(Object.hasOwn(inputs[0], 'question'), false)
  assert.equal(JSON.stringify(inputs).includes(marker), false)
})

test('verified deletion repairs malformed semantic storage instead of trusting stale table receipts', async t => {
  const f = fixture(t)
  const { memory, store } = f.start()
  const marker = 'stale-derived-copy-c9f5de'
  const entry = memory.addMemory(marker)
  assert.ok(entry)
  store.db.exec('DROP TABLE memory_semantic_vectors; CREATE TABLE memory_semantic_vectors (stale TEXT)')
  store.db.prepare('INSERT INTO memory_semantic_vectors VALUES (?)').run(marker)
  assert.deepEqual(await memory.deleteMemory(entry.id, entry.revision), { status: 'cleared' })
  assert.deepEqual(store.db.prepare('PRAGMA table_info(memory_semantic_vectors)').all().map(column => column.name), ['memory', 'revision', 'vector'])
  for (const name of [f.file, `${f.file}-wal`]) assert.equal(fs.readFileSync(name).includes(marker), false, name)
})

test('forgotten memory cannot reappear through a stale result, history, or an unauthorized tool call', async t => {
  const text = '我住在紫藤城'
  let modelCalls = 0
  const reached = deferred<void>()
  const delayed = deferred<string>()
  const f = fixture(t, () => {
    if (++modelCalls === 1) return Promise.resolve(proposal(text))
    reached.resolve()
    return delayed.promise
  })
  const { memory, store } = f.start()
  const source = memory.accept(text, origin)
  await memory.wake()
  const entry = memory.listMemories().items[0]
  assert.ok(entry)
  const result = JSON.parse(memory.handle({ op: 'forget', session: origin.session, id: entry.id }, origin))
  assert.equal(result.status, 'rejected')
  assert.equal(memory.listMemories().total, 1)
  const history = openHistoryDb({ file: path.join(f.dir, 'history.db') })
  t.after(() => history.close())
  const saved = history.save(history.create(), [{ role: 'user', text, sourceId: source.sourceId }])
  assert.match(history.sourceLink(source.sourceId, saved.id) ?? '', new RegExp(`^viva://timeline/${saved.id}/0/\\d+$`))
  const pending = memory.accept(text, origin)
  await reached.promise
  memory.recordSession(origin.session)
  assert.equal(await memory.forget(entry.id, entry.revision, 'forget'), true)
  assert.equal(memory.sourceCurrent(source.sourceId), false)
  delayed.resolve(proposal(text))
  await memory.wake()
  assert.equal(memory.listMemories().total, 0)
  assert.equal(memory.accept(text, origin, pending.sourceId).sourceId, pending.sourceId)
  assert.equal(memory.sourceCurrent(source.sourceId), false)
  const filtered = historyRecall(history, memory.allowedHistory)
  assert.deepEqual(filtered.search('紫藤城'), [])
  assert.equal(filtered.read({ segmentId: saved.id, seq: 0 }).status, 'deleted')
  assert.ok(history.get(saved.id)?.messages.some(message => message.text === text))
  assert.equal(store.get(entry.id)?.retention, 'forgotten')
  assert.equal(JSON.parse(memory.handle({ op: 'remember', session: origin.session, text }, origin)).status, 'rejected')
  assert.ok(memory.restore(entry.id, store.get(entry.id)!.revision))
  assert.equal(memory.listMemories().total, 1)
  assert.equal(JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '紫藤城' }, origin)).memories.length, 1)
  assert.equal(filtered.read({ segmentId: saved.id, seq: 0 }).status, 'deleted')
})

test('withdrawal replay keeps independently sourced facts and excludes restored history', async t => {
  const text = '我住在紫藤城'
  const f = fixture(t, async () => proposal(text))
  const first = f.start()
  const original = first.memory.accept(text, origin)
  await first.memory.wake()
  const secondOrigin = { conversation: 'other-conversation', session: 'other-session' }
  first.memory.accept(text, secondOrigin)
  await first.memory.wake()
  assert.equal(first.memory.listMemories().items[0].evidence.length, 2)
  const reopened = f.start()
  const withdrawal = { conversation: origin.conversation, ids: [original.sourceId] }
  reopened.memory.withdraw(withdrawal)
  const revision = reopened.memory.revision()
  reopened.memory.withdraw(withdrawal)
  assert.equal(reopened.memory.revision(), revision)
  assert.equal(reopened.memory.allowedHistory({ segmentId: origin.conversation, sourceId: original.sourceId, role: 'user', text }), false)
  assert.equal(reopened.store.readSource(original.sourceId)?.text, null)
  assert.equal(JSON.parse(reopened.memory.handle({ op: 'recall', session: secondOrigin.session, query: '紫藤城' }, secondOrigin)).memories.length, 1)
  reopened.memory.withdraw({ conversation: secondOrigin.conversation, ids: [] })
  assert.equal(reopened.memory.listMemories().total, 0)
  assert.equal(reopened.memory.accept(text, origin, original.sourceId).outcome, 'withdrawn')
})

test('scope, qualifiers, credential filtering and compare-and-set are enforced before a write', async t => {
  const seen: MemoryCompute[] = []
  const f = fixture(t, job => {
    seen.push(job)
    const { user } = JSON.parse(job.input) as { user: string }
    return Promise.resolve(proposal(user, { kind: 'preference', scope: 'conversation', conditionSpans: [sourceSpan(user, '闲聊除外')] }))
  })
  const { memory, store } = f.start()
  assert.equal(memory.accept('记住密码：synthetic-private-value', origin).outcome, 'rejected')
  const refresh = memory.accept('项目测试回调 https://example.test/callback#refresh_token=syntheticABc123456789', origin)
  assert.equal(refresh.outcome, 'rejected')
  assert.equal(store.readSource(refresh.sourceId)?.text, null)
  const source = memory.accept('这次先给结论，闲聊除外', origin)
  await memory.wake()
  assert.equal(seen.length, 1)
  assert.equal(store.readSource(source.sourceId)?.outcome, 'accepted')
  const entry = memory.listMemories().items[0]
  assert.ok(entry?.conditional)
  const request = { op: 'recall' as const, session: origin.session, query: '结论' }
  assert.deepEqual(JSON.parse(memory.handle(request, origin)).memories, [])
  assert.equal(JSON.parse(memory.handle(request, { ...origin, scope: { kind: 'conversation', id: origin.conversation } })).memories.length, 1)
  await assert.rejects(memory.editMemory(entry.id, '新内容', entry.revision + 1))
  assert.equal(store.get(entry.id)?.text, '这次先给结论，闲聊除外')
})

const date = (day: string) => localDay(day, Intl.DateTimeFormat().resolvedOptions().timeZone)!
type Ref = { id: number, revision: number, text: string }
type ReviewDraft = { id: string, oldConditions: string[], oldWindows: unknown[], newWindow: unknown, changeWindow: unknown }
const computeInput = (input: string) => JSON.parse(input) as {
  user: string, related: Ref[], proposals?: { index: number, proposal: MemoryProposal, draft: ReviewDraft }[]
}
function confirmedReviews(job: MemoryCompute) {
  const { proposals } = computeInput(job.input)
  return JSON.stringify({ reviews: proposals?.map(({ index, draft }) => ({ index, verdict: 'confirmed', draftId: draft.id })) ?? [] })
}
function reviewVerdict(job: MemoryCompute, verdict: 'rejected' | 'uncertain' | 'confirmed') {
  return JSON.stringify({ reviews: computeInput(job.input).proposals?.map(({ index, draft }) => ({ index, verdict, draftId: draft.id })) ?? [] })
}
function sourceInterval(text: string, evidence: string, from: string, to: string | null = null): MemoryTemporal {
  return { kind: 'interval', from: { date: from }, to: to ? { date: to } : null, evidence: [sourceSpan(text, evidence)] }
}

function proposedChange(text: string, kind: NonNullable<MemoryProposal['change']>['kind'], old: Ref,
  action: string, target: string, effective?: string, from?: string) {
  const temporal = kind === 'supersede' || kind === 'end'
    ? (effective && from ? sourceInterval(text, effective, from) : { kind: 'current' as const })
    : undefined
  return {
    kind, target: { id: old.id, revision: old.revision }, temporal,
    evidence: { action: sourceSpan(text, action), target: sourceSpan(text, target), ...(effective ? { effective: sourceSpan(text, effective) } : {}) },
  }
}

const residenceProposal = async ({ input }: MemoryCompute) => {
  const { user } = computeInput(input)
  return proposal(user, { fact: structured(user, '住在', user.split('住在')[1], 'residence'),
    ...(user.includes('去年') ? { temporal: sourceInterval(user, '去年', '2025-01-01', '2026-01-01') } : {}) })
}

test('historical and scheduled assertions keep the dates of their sources, regardless of arrival order', async t => {
  let clock = date('2026-06-10') + 36_000
  const now = () => clock
  const future = '从明天起，我的居住地从杭州改为北京'
  const f = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const value = user.endsWith('杭州') ? '杭州' : user.endsWith('上海') ? '上海' : '北京'
    const old = related.find(entry => entry.text.endsWith('杭州'))
    return proposal(user, {
      fact: structured(user, '居住地', value, 'residence'),
      ...(user.includes('去年') ? { temporal: sourceInterval(user, '去年', '2025-01-01', '2026-01-01') } : {}),
      ...(user === future && old ? { change: proposedChange(user, 'supersede', old, '改为', '杭州', '从明天起', '2026-06-11') } : {}),
    })
  }, now)
  const { memory, store } = f.start()
  const ask = (asOf?: string) => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '居住地', asOf }, origin))
  memory.accept('我现在的居住地是杭州', origin)
  await memory.wake()
  memory.accept('我去年的居住地是上海', origin)
  await memory.wake()
  assert.deepEqual(ask().memories.map((item: { text: string }) => item.text), ['我现在的居住地是杭州'])
  assert.deepEqual(ask('2025-10-15').memories.map((item: { text: string }) => item.text), ['我去年的居住地是上海'])
  assert.deepEqual(ask('2024-06-01').memories, [])

  const revision = memory.revision()
  memory.accept(future, origin)
  await memory.wake()
  assert.equal(memory.revision(), revision + 1)
  assert.equal(store.list().find(entry => entry.text.endsWith('杭州'))?.validTo, date('2026-06-11'))
  assert.equal(ask().memories[0].text, '我现在的居住地是杭州')
  clock = date('2026-06-11')
  const current = ask().memories[0]
  assert.equal(current.id, store.list().find(entry => entry.text === future)?.id)
  assert.match(current.text, /北京/)
  assert.doesNotMatch(current.text, /杭州/)
  assert.equal(ask('2026-06-10').memories[0].text, '我现在的居住地是杭州')
  assert.equal(store.list().find(entry => entry.text.endsWith('杭州'))?.links[0]?.kind, 'supersedes')
  assert.equal(resolveMemoryTime(sourceInterval('从今天起，我住在北京', '从今天起', '2026-01-02'),
    Date.parse('2026-01-01T17:00Z'), 'Asia/Shanghai').from, Date.parse('2026-01-01T16:00Z'))
})

test('a disagreement stays separate from current facts and requires a versioned resolution', async t => {
  const one = '我的直属上级是张三'
  const two = '我唯一的直属上级是李四'
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const old = related.find(entry => entry.text === one)
    return proposal(user, {
      fact: structured(user, '直属上级', user === one ? '张三' : '李四', 'manager'),
      ...(user === two && old ? { change: proposedChange(user, 'possible_conflict', old, '唯一', '直属上级') } : {}),
    })
  }).start()
  memory.accept(one, origin)
  await memory.wake()
  const old = memory.listMemories().items[0]
  memory.accept(two, origin)
  await memory.wake()
  const other = store.list().find(entry => entry.text === two)!
  const read = () => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '直属上级' }, origin))
  assert.deepEqual(read().memories, [])
  assert.deepEqual(read().conflicts[0].sides.map((item: { id: number }) => item.id), [old.id, other.id])
  assert.equal(memory.listInvalid().filter(item => item.state === 'disputed').length, 2)
  await assert.rejects(() => memory.resolveConflict(old.id, old.revision))
  const chosen = await memory.resolveConflict(old.id, store.get(old.id)!.revision)
  assert.equal(chosen?.id, old.id)
  assert.deepEqual(read().conflicts, [])
  assert.equal(read().memories[0].id, old.id)
  assert.ok(store.get(other.id)?.links.some(link => link.kind === 'corrects'))
})

test('multi-valued predicates and project scopes keep independent facts', async t => {
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user } = JSON.parse(input) as { user: string }
    return proposal(user, { scope: 'project', fact: structured(user, '直属上级', user.split('是')[1], 'manager') })
  }).start()
  memory.addMemory('我会说中文')
  memory.addMemory('我会说英语')
  const read = (query: string, scope?: { kind: 'project', id: string }) =>
    JSON.parse(memory.handle({ op: 'recall', session: origin.session, query }, { ...origin, scope }))
  assert.equal(read('会说').memories.length, 2)
  assert.deepEqual(read('会说').conflicts, [])
  const projectA = { kind: 'project', id: 'project-a' } as const
  const projectB = { kind: 'project', id: 'project-b' } as const
  memory.accept('我的直属上级是周一', { ...origin, scope: projectA })
  await memory.wake()
  memory.accept('我的直属上级是王二', { ...origin, scope: projectB })
  await memory.wake()
  assert.deepEqual(read('直属上级').memories, [])
  assert.equal(read('直属上级', projectA).memories[0].text, '我的直属上级是周一')
  assert.deepEqual(read('直属上级', projectB).conflicts, [])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get()?.n, 2)
})

test('an explicit correction of a historical memory preserves its validity interval', async t => {
  const { memory, store } = fixture(t, residenceProposal, () => date('2026-11-13')).start()
  memory.accept('我去年住在上海', origin)
  await memory.wake()
  const old = memory.listInvalid()[0]
  const fixed = await memory.editMemory(old.id, '我住在苏州', old.revision)
  await memory.wake()
  assert.equal(fixed?.validFrom, date('2025-01-01'))
  assert.equal(fixed?.validTo, date('2026-01-01'))
  assert.equal(store.get(old.id)?.state, 'retracted')
  const result = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '苏州', asOf: '2025-05-01' }, origin))
  assert.deepEqual(result.memories.map((item: { id: number }) => item.id), [fixed?.id])
})

test('a direct historical self-correction inherits the uniquely referenced assertion interval', async t => {
  const before = '我去年在支付组'
  const after = '之前说错了，我那时在风控组'
  const present = '我现在在财务组'
  const f = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const value = user === before ? '支付组' : user === after ? '风控组' : '财务组'
    const old = related.find(entry => entry.text === before)
    return proposal(user, { fact: structured(user, '在', value, 'work_group'),
      ...(user === before ? { temporal: sourceInterval(user, '去年', '2025-01-01', '2026-01-01') } : {}),
      ...(user === after && old ? { change: proposedChange(user, 'correct', old, '说错了', '之前') } : {}) })
  }, () => date('2026-11-14'))
  const { memory, store } = f.start()
  for (const text of [before, present, after]) {
    memory.accept(text, origin)
    await memory.wake()
  }
  const read = (query: string, asOf?: string) => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query, asOf }, origin))
  const historical = read('风控组', '2025-04-01').memories
  assert.deepEqual(historical.map((entry: { id: number }) => entry.id), [store.list().find(entry => entry.text === after)?.id])
  assert.match(historical[0].text, /风控组/)
  assert.deepEqual(read('支付组', '2025-04-01').memories, [])
  assert.deepEqual(read('财务组').memories.map((entry: { text: string }) => entry.text), [present])
  assert.equal(memory.listChanges()[0]?.kind, 'correct')
})

test('explicit transitions persist and an undo removes only the selected transition', async t => {
  const first = '从2026-01-01起，我的周报邮箱是 A@example.test'
  const second = '从2026-03-01起，我的周报邮箱从 A@example.test 改为 B@example.test'
  const third = '从2026-06-01起，我的备用邮箱是 C@example.test'
  const f = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const value = user === first ? 'A@example.test' : user === second ? 'B@example.test' : 'C@example.test'
    const old = related.find(entry => entry.text === first)
    return proposal(user, {
      fact: structured(user, user === third ? '备用邮箱' : '周报邮箱', value, user === third ? 'backup_email' : 'report_email'),
      temporal: sourceInterval(user, user.slice(0, 12), user.slice(1, 11)),
      ...(user === second && old ? { change: proposedChange(user, 'supersede', old, '改为', 'A@example.test', '从2026-03-01起', '2026-03-01') } : {}),
    })
  }, () => date('2026-07-01'))
  const { memory } = f.start()
  for (const text of [first, second, third]) {
    memory.accept(text, origin)
    await memory.wake()
  }
  const { memory: reopened, store } = f.start()
  const read = (query: string, asOf?: string) => JSON.parse(reopened.handle({ op: 'recall', session: origin.session, query, asOf }, origin))
  for (const [day, expected] of [['2026-02-01', first], ['2026-03-01', second], ['2026-06-01', second]]) {
    const { memories } = read('周报邮箱', day)
    assert.deepEqual(memories.map((item: { id: number }) => item.id), [store.list().find(entry => entry.text === expected)?.id])
    if (expected === second) {
      assert.match(memories[0].text, /B@example\.test/)
      assert.doesNotMatch(memories[0].text, /A@example\.test/)
    }
  }
  const changes = reopened.listChanges()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before, first)
  assert.equal(changes[0].after, second)
  assert.equal(changes[0].effectiveAt, date('2026-03-01'))
  const change = changes[0]
  assert.deepEqual(await reopened.undoChange(change.id, change.revision + 1, undefined, change.expectedRevisions),
    { status: 'conflict', current: change.expectedRevisions })
  assert.deepEqual(await reopened.undoChange(change.id, change.revision, undefined, change.expectedRevisions), { status: 'applied' })
  assert.deepEqual(read('周报邮箱').memories.map((item: { text: string }) => item.text), [first])
  assert.deepEqual(read('备用邮箱').memories.map((item: { text: string }) => item.text), [third])
  assert.equal(reopened.listChanges()[0].status, 'undone')
})

function sourceSpan(text: string, part: string, from = 0) {
  const start = text.indexOf(part, from)
  assert.notEqual(start, -1)
  return { start, end: start + part.length }
}

const structured = (text: string, relation: string, value: string, predicate: string, options: Partial<NonNullable<MemoryProposal['fact']>> = {}) => ({
  subject: { kind: 'user' as const, span: sourceSpan(text, '我') },
  relation: sourceSpan(text, relation, text.lastIndexOf(relation, text.indexOf(value) - 1)), object: sourceSpan(text, value), predicate, polarity: 'positive' as const, ...options,
})

test('a historical disagreement can be resolved without changing the current value', async t => {
  const one = '我去年的周报提交邮箱是 ops@example.com'
  const two = '我去年唯一的周报提交邮箱是 team@example.com'
  const current = '我现在的周报提交邮箱是 report@example.com'
  const f = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const old = related.find(entry => entry.text === one)
    const value = user === one ? 'ops@example.com' : user === two ? 'team@example.com' : 'report@example.com'
    return proposal(user, { fact: structured(user, '周报提交邮箱', value, 'report_email'),
      ...(user === current ? {} : { temporal: sourceInterval(user, '去年', '2025-01-01', '2026-01-01') }),
      ...(user === two && old ? { change: proposedChange(user, 'possible_conflict', old, '唯一', '周报提交邮箱') } : {}),
    })
  }, () => date('2026-11-14'))
  const { memory, store } = f.start()
  const first = memory.accept(one, origin)
  await memory.wake()
  const old = store.list()[0]
  assert.equal(old.fact?.predicate, 'report_email')
  assert.equal(old.fact?.object, 'ops@example.com')
  assert.equal(old.evidence[0].sourceId, first.sourceId)

  memory.accept(two, origin)
  await memory.wake()
  memory.accept(current, origin)
  await memory.wake()
  const read = (asOf?: string) => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报提交邮箱', asOf }, origin))
  const past = read('2025-06-01')
  assert.deepEqual(past.memories, [])
  assert.equal(past.conflicts.length, 1)
  assert.deepEqual(read().memories.map((entry: { text: string }) => entry.text), [current])
  const chosen = past.conflicts[0].sides.find((entry: { text: string }) => entry.text === two)
  await memory.resolveConflict(chosen.id, chosen.revision)
  assert.deepEqual(read('2025-06-01').memories.map((entry: { text: string }) => entry.text), [two])
  assert.deepEqual(read().memories.map((entry: { text: string }) => entry.text), [current])
  assert.equal(store.get(old.id)?.state, 'retracted')
})

test('unknown predicate values can coexist and invalid evidence cannot create a structured fact', async t => {
  const f = fixture(t, async ({ input }) => {
    const { user } = JSON.parse(input) as { user: string }
    const value = user.endsWith('红茶') ? '红茶' : '绿茶'
    const fact = structured(user, '常喝', value, 'drink_preference')
    return proposal(user, { fact: user.includes('暂时') ? { ...fact, object: { start: 0, end: user.length + 10 } } : fact })
  })
  const { memory, store } = f.start()
  for (const text of ['我常喝绿茶', '我常喝红茶', '我暂时常喝绿茶']) {
    memory.accept(text, origin)
    await memory.wake()
  }
  assert.equal(memory.listMemories().items.length, 2)
  assert.equal(memory.listInvalid().length, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_facts').get()?.n, 2)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_candidates').get()?.n, 1)
})

test('manual writes keep their identity while structured evidence is added in the background', async t => {
  const text = '我的订阅续费方式是发票'
  const { memory, store } = fixture(t, async () =>
    proposal(text, { fact: structured(text, '订阅续费方式', '发票', 'subscription_payment') })).start()
  const saved = memory.addMemory(text)!
  assert.equal(saved.fact, null)
  await memory.wake()
  const after = store.get(saved.id)!
  assert.equal(after.source, 'user')
  assert.equal(after.fact?.object, '发票')
  assert.equal(after.evidence.length, 1)
  assert.equal(memory.listMemories().total, 1)
})

test('a model cannot borrow an unrelated change or lift another person’s fact into user scope', async t => {
  const prior = '我的直属上级是张三'
  const fake = '我的笔记本从张三改为李四，我的直属上级是王五'
  const thirdParty = '我同事赵六的私人邮箱是 person@example.test'
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const old = related.find(entry => entry.text === prior)
    if (user === thirdParty) return proposal(user, { attribution: 'third_party', fact: structured(user, '私人邮箱', 'person@example.test', 'private_email',
      { subject: { kind: 'named', span: sourceSpan(user, '赵六') } }) })
    const fact = structured(user, '直属上级', user === prior ? '张三' : '王五', 'manager')
    if (user === fake) {
      const owner = user.lastIndexOf('我')
      fact.subject.span = { start: owner, end: owner + 1 }
    }
    return proposal(user, { fact,
      ...(user === fake ? { independent: true, fact: { ...fact, spans: [sourceSpan(user, '我的直属上级是王五')] } } : {}),
      ...(user === fake && old ? { change: proposedChange(user, 'supersede', old, '改为', '张三') } : {}),
    })
  }, Date.now, job => Promise.resolve(reviewVerdict(job, 'rejected'))).start()
  memory.accept(prior, origin)
  await memory.wake()
  const manager = memory.listMemories().items[0]
  memory.accept(fake, origin)
  await memory.wake()
  memory.accept(thirdParty, origin)
  await memory.wake()
  assert.equal(memory.listMemories().total, 2)
  assert.equal(store.get(manager.id)?.state, 'active')
  assert.equal(store.get(manager.id)?.validTo, null)
  assert.equal(memory.listChanges().length, 0)
  assert.equal(store.list().find(entry => entry.fact?.object === '王五')?.text, '我的直属上级是王五')
  assert.equal(store.list().some(entry => entry.fact?.object === 'person@example.test'), false)
})

test('grounded named subjects stay in the originating conversation when no broader scope is verified', async t => {
  const text = '北辰服务的维护窗口是周二上午'
  const { memory } = fixture(t, async () => proposal(text, {
    scope: 'conversation', attribution: 'third_party',
    fact: {
      polarity: 'positive', subject: { kind: 'named', span: sourceSpan(text, '北辰服务') },
      predicate: 'maintenance_window', relation: sourceSpan(text, '维护窗口'), object: sourceSpan(text, '周二上午'),
    },
  })).start()
  memory.accept(text, origin)
  await memory.wake()
  const entry = memory.listMemories().items[0]
  assert.equal(entry.fact?.subject, 'named:北辰服务')
  assert.deepEqual(entry.scope, { kind: 'conversation', id: origin.conversation })
  const request = { op: 'recall' as const, session: origin.session, query: '维护窗口' }
  assert.equal(JSON.parse(memory.handle(request, origin)).memories.length, 0)
  assert.equal(JSON.parse(memory.handle(request, { ...origin, context: { kind: 'conversation', id: origin.conversation } })).memories.length, 1)
})

test('explicit chat saves durably acknowledge pending work and recover with the same receipt', async t => {
  let connected = false
  const f = fixture(t, job => {
    if (!connected) return null
    const { user, spans } = JSON.parse(job.input) as { user: string, spans: Array<{ start: number, end: number }> }
    return Promise.resolve(proposal(user, { spans, scope: 'conversation' }))
  })
  const first = f.start()
  const text = '记住：我偏好 JetBrains Mono'
  const op = randomUUID()
  const receipt = first.memory.accept(text, origin, op)
  assert.equal(receipt.outcome, 'pending')
  assert.equal(first.memory.listMemories().items.length, 0)
  first.memory.bindSource(receipt.sourceId, origin.session)
  const request = { op: 'remember', session: origin.session, text: '我偏好 JetBrains Mono' } as const
  assert.deepEqual(JSON.parse(first.memory.handle(request, origin)), { status: 'pending' })
  const read = first.memory.handle({ op: 'recall', session: 'unrelated-session', query: 'JetBrains' },
    { session: 'unrelated-session', conversation: 'unrelated-conversation' })
  assert.deepEqual(JSON.parse(read).memories, [])
  const second = f.start()
  assert.deepEqual(second.memory.accept(text, origin, op), receipt)
  connected = true
  await second.memory.wake()
  assert.equal(second.memory.listMemories().items.length, 1)
  assert.equal(second.memory.listMemories().items[0].text, '我偏好 JetBrains Mono')
  assert.deepEqual(second.memory.listMemories().items[0].scope, { kind: 'conversation', id: origin.conversation })
  assert.equal(second.memory.listMemories().items[0].evidence[0].sourceId, op)
  assert.equal(second.memory.forgetIntent('忘记带伞了怎么办'), null)
  for (const words of ['记住了吗', '记住没有', '记住这个快捷键有什么技巧？']) {
    const question = second.memory.accept(words, origin)
    assert.equal(question.outcome, 'pending')
  }
  assert.equal(second.memory.listMemories().items.length, 1)
})

test('an explicit save with no admissible proposal leaves no active placeholder or accepted receipt', async t => {
  const { memory, store } = fixture(t, async () => JSON.stringify({ proposals: [] })).start()
  const text = '记住：你刚才说你可能会搬家'
  const source = memory.accept(text, origin)
  memory.bindSource(source.sourceId, origin.session)
  const remember = { op: 'remember', session: origin.session, text: '你刚才说你可能会搬家' } as const
  assert.equal(source.outcome, 'pending')
  assert.deepEqual(JSON.parse(memory.handle(remember, origin)), { status: 'pending' })
  assert.equal(memory.listMemories().total, 0)
  await memory.wake()
  assert.equal(store.readSource(source.sourceId)?.outcome, 'skipped')
  assert.equal(memory.listMemories().total, 0)
  assert.equal(memory.listInvalid().length, 0)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM effects').get()?.n, 0)
  assert.equal(memory.accept(text, origin, source.sourceId).outcome, 'skipped')
})

test('an explicitly saved change uses independent review before replacing the previous fact', async t => {
  const previous = '我的周报邮箱是 amber@example.test'
  const update = '记住：我的周报邮箱从 amber@example.test 改为 cobalt@example.test'
  let at = date('2026-07-01')
  const { memory, store } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const before = related.find(item => item.text === previous)
    if (!before) return proposal(user, { fact: structured(user, '周报邮箱', 'amber@example.test', 'report_email') })
    const words = update.slice('记住：'.length)
    return proposal(user, { spans: [sourceSpan(user, words)], fact: structured(user, '周报邮箱', 'cobalt@example.test', 'report_email'),
      change: proposedChange(user, 'supersede', before, '改为', 'amber@example.test') })
  }, () => at).start()
  memory.accept(previous, origin)
  await memory.wake()
  at++
  const source = memory.accept(update, origin)
  assert.equal(source.outcome, 'pending')
  const visible = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报邮箱' },
    { ...origin, context: { kind: 'conversation', id: origin.conversation } }))
  assert.doesNotMatch(JSON.stringify(visible), /cobalt@example\.test/)
  await memory.wake()
  assert.equal(memory.listChanges().length, 1)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.fact?.object), ['cobalt@example.test'])
  assert.equal(store.readSource(source.sourceId)?.outcome, 'explicit-accepted')
  assert.equal(memory.accept(update, origin, source.sourceId).outcome, 'accepted')
})

test('review cannot apply a change across different conditions or an incompatible new start', async t => {
  const before = '客户故障时，我的周报邮箱是 amber@example.test'
  const other = '内部演练时，我的周报邮箱从 amber@example.test 改为 cobalt@example.test'
  const differentStart = '从2026-07-02起，客户故障时，我的周报邮箱从 amber@example.test 改为 jade@example.test。新值从2026-08-01起启用。'
  let at = date('2026-07-01')
  const drafts: ReviewDraft[] = []
  const { memory } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const old = related.find(item => item.text === before)
    const value = user === before ? 'amber@example.test' : user === other ? 'cobalt@example.test' : 'jade@example.test'
    const conditions = [sourceSpan(user, user === other ? '内部演练时' : '客户故障时')]
    return proposal(user, {
      conditionSpans: conditions, fact: structured(user, '周报邮箱', value, 'report_email'),
      ...(old ? { change: proposedChange(user, 'supersede', old, '改为', 'amber@example.test',
        user === differentStart ? '从2026-07-02起' : undefined, user === differentStart ? '2026-07-02' : undefined) } : {}),
      ...(user === differentStart ? { temporal: sourceInterval(user, '从2026-08-01起', '2026-08-01') } : {}),
    })
  }, () => at, async job => {
    drafts.push(computeInput(job.input).proposals![0].draft)
    return confirmedReviews(job)
  }).start()
  for (const words of [before, other, differentStart]) {
    at++
    memory.accept(words, origin)
    await memory.wake()
  }
  assert.equal(memory.listChanges().length, 0)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.text), [before])
  assert.equal(drafts.length, 2)
  assert.deepEqual(drafts[0].oldConditions, ['客户故障时'])
  assert.deepEqual(drafts[1].newWindow, { from: date('2026-08-01'), to: null, dated: true, uncertain: false })
})

test('a reviewed equivalent condition can preserve meaning across rephrasing, while overlap only becomes provisional', async t => {
  const before = '平日工作时，我的周报邮箱是 amber@example.test'
  const overlap = '星期一到星期三上班时，我的周报邮箱从 amber@example.test 改为 jade@example.test'
  const update = '星期一到星期五上班时，我的周报邮箱从 amber@example.test 改为 cobalt@example.test'
  let at = date('2026-07-01')
  const { memory } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const target = related.find(item => item.text === before)
    const condition = user.slice(0, user.indexOf('，'))
    const value = user === before ? 'amber@example.test' : user === overlap ? 'jade@example.test' : 'cobalt@example.test'
    return proposal(user, { conditionSpans: [sourceSpan(user, condition)], keywords: ['周报邮箱'], fact: structured(user, '周报邮箱', value, 'report_email'),
      ...(target ? { change: proposedChange(user, 'supersede', target, '改为', 'amber@example.test') } : {}) })
  }, () => at, async job => {
    const { user, proposals } = computeInput(job.input)
    return JSON.stringify({ reviews: proposals?.map(({ index, draft }) => user === overlap
      ? { index, draftId: draft.id, verdict: 'uncertain', sameRelation: true, conditions: 'overlap' }
      : { index, draftId: draft.id, verdict: 'confirmed', conditions: 'equivalent' }) })
  }).start()
  const read = () => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报邮箱' },
    { ...origin, foregroundTurn: 'verify', turn: 'verify' }))
  memory.accept(before, origin)
  await memory.wake()
  at++
  memory.accept(overlap, origin)
  await memory.wake()
  assert.equal(memory.listChanges().length, 0)
  const [pending] = read().pendingChanges
  assert.equal(pending.alternative.value, 'jade@example.test')
  assert.match(pending.alternative.text, /星期一到星期三上班时/)
  at++
  memory.accept(update, origin)
  await memory.wake()
  assert.equal(memory.listChanges().length, 1)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.fact?.object), ['cobalt@example.test'])
})

test('an event-based ending remains pending, includes the event on demand, and does not close the old fact', async t => {
  const before = '我的周报邮箱是 amber@example.test'
  const ending = '项目验收后，我不再用周报邮箱 amber@example.test'
  const { memory } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const target = related.find(item => item.text === before)
    if (!target) return proposal(user, { fact: structured(user, '周报邮箱', 'amber@example.test', 'report_email') })
    const change = proposedChange(user, 'end', target, '不再用', 'amber@example.test')
    return proposal(user, { keywords: ['周报邮箱'], change: { ...change,
      temporal: { kind: 'event', evidence: [sourceSpan(user, '项目验收后')] } } })
  }, () => date('2026-07-01')).start()
  memory.accept(before, origin)
  await memory.wake()
  memory.accept(ending, origin)
  await memory.wake()
  assert.equal(memory.listChanges().length, 0)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.text), [before])
  const foreground = { ...origin, turn: 'ask', foregroundTurn: 'ask' }
  const read = (query: string) => JSON.parse(memory.handle({ op: 'recall', session: origin.session, query }, foreground))
  assert.deepEqual(read('公司食堂').pendingChanges, [])
  const [pending] = read('周报邮箱').pendingChanges
  assert.equal(pending.event, '项目验收后')
  assert.equal(pending.kind, 'end')
  const ready = JSON.parse(memory.handle({ op: 'clarify', session: origin.session, ref: pending.ref }, foreground))
  assert.equal(ready.status, 'ready')
  assert.match(ready.question.question, /项目验收后/)
})

test('a reviewed batch commits two disjoint corrections to the same old record', async t => {
  const before = '从2026-01-01起，我的周报邮箱是 amber@example.test'
  const early = '2026-02-01到2026-03-01，我的周报邮箱 amber@example.test 有误，应为 cobalt@example.test'
  const late = '2026-04-01到2026-05-01，我的周报邮箱 amber@example.test 有误，应为 jade@example.test'
  const words = `${early}。${late}`
  const { memory } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const target = related.find(item => item.text === before)
    if (!target) return proposal(user, { temporal: sourceInterval(user, '从2026-01-01起', '2026-01-01'),
      fact: structured(user, '周报邮箱', 'amber@example.test', 'report_email') })
    const revisions = [[early, '2026-02-01', '2026-03-01', 'cobalt@example.test'], [late, '2026-04-01', '2026-05-01', 'jade@example.test']]
    return JSON.stringify({ proposals: revisions.map(([clause, from, to, value]) => {
      const start = user.indexOf(clause)
      const part = (value: string) => sourceSpan(user, value, start)
      const evidence = part(`${from}到${to}`)
      return { ...JSON.parse(proposal(user)).proposals[0], spans: [part(clause)],
        fact: { predicate: 'report_email', subject: { kind: 'user', span: part('我') }, relation: part('周报邮箱'), object: part(value), polarity: 'positive' },
        change: { kind: 'correct', target: { id: target.id, revision: target.revision },
          evidence: { action: part('有误'), target: part('amber@example.test'), effective: evidence },
          temporal: { kind: 'interval', from: { date: from }, to: { date: to }, evidence: [evidence] } },
      }
    }) })
  }, () => date('2026-07-01')).start()
  for (const input of [before, words]) {
    memory.accept(input, origin)
    await memory.wake()
  }
  assert.equal(memory.listChanges().length, 2)
  for (const [asOf, value] of [['2026-02-10', 'cobalt'], ['2026-03-10', 'amber'], ['2026-04-10', 'jade']]) {
    const recalled = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报邮箱', asOf }, origin))
    assert.equal(recalled.memories.length, 1)
    assert.match(recalled.memories[0].text, new RegExp(`${value}@example\\.test`))
  }
})

test('transport failures and mismatched draft replies retry without invalidating old memories', async t => {
  const before = '我的周报邮箱是 amber@example.test'
  const update = '我的周报邮箱改为 cobalt@example.test'
  let at = date('2026-07-01')
  let attempts = 0
  const { memory, store } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const old = related.find(item => item.text === before)
    return proposal(user, { fact: structured(user, '周报邮箱', user === before ? 'amber@example.test' : 'cobalt@example.test', 'report_email'),
      ...(old ? { change: proposedChange(user, 'supersede', old, '改为', '周报邮箱') } : {}) })
  }, () => at, async job => {
    attempts++
    if (attempts === 1) throw new Error('temporary transport error')
    if (attempts === 2) return JSON.stringify({ reviews: [{ index: 0, verdict: 'confirmed', draftId: '0'.repeat(64) }] })
    return confirmedReviews(job)
  }).start()
  memory.accept(before, origin)
  await memory.wake()
  at++
  const source = memory.accept(update, origin)
  await memory.wake()
  assert.equal(store.readSource(source.sourceId)?.outcome, 'pending')
  assert.deepEqual(memory.listMemories().items.map(entry => entry.text), [before])
  at += 5_001
  await memory.wake()
  assert.equal(store.readSource(source.sourceId)?.outcome, 'pending')
  assert.equal(memory.listChanges().length, 0)
  at += 30_001
  await memory.wake()
  assert.equal(attempts, 3)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.fact?.object), ['cobalt@example.test'])
})

test('question choices are context only, while an exact custom save stays in its bound conversation', async t => {
  const text = '记住：我的字体是 Inter'
  const { memory, store } = fixture(t, async job => {
    const { user, spans } = JSON.parse(job.input) as { user: string, spans: { start: number, end: number }[] }
    return proposal(user, { spans, ...(user === text ? { fact: structured(user, '字体', 'Inter', 'font') } : {}) })
  }).start()
  const answer = { requestId: 'request', questionId: 'which-font', question: '你要用哪个字体？' }
  const option = memory.accept('Inter', origin, randomUUID(), answer)
  await memory.wake()
  assert.equal(store.readSource(option.sourceId)?.outcome, 'rejected')
  assert.equal(store.readSource(option.sourceId)?.text, null)
  const saved = memory.accept(text, origin, randomUUID(), { ...answer, custom: true })
  assert.equal(saved.outcome, 'pending')
  await memory.wake()
  assert.equal(store.readSource(saved.sourceId)?.questionId, 'which-font')
  assert.deepEqual(memory.listMemories().items[0].scope, { kind: 'conversation', id: origin.conversation })
  assert.equal(memory.listMemories().items[0].fact?.object, 'Inter')
})

test('only a custom card answer with grounded lasting intent can change memory', async t => {
  const initial = '我的周报邮箱是 amber@example.test'
  const update = '以后我的周报邮箱改为 cobalt@example.test'
  const local = 'jade@example.test'
  const answer = { question: '这次用哪个周报邮箱？', requestId: 'question', questionId: 'mail', custom: true } as const
  let now = date('2026-07-01')
  const { memory, store } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    if (user === local) return proposal(user, { durableIntent: sourceSpan(user, local) })
    const previous = related.find(item => item.text === initial)
    const value = user === initial ? 'amber@example.test' : 'cobalt@example.test'
    return proposal(user, { fact: structured(user, '周报邮箱', value, 'report_email'), ...(previous ? {
      durableIntent: sourceSpan(user, '以后'), change: proposedChange(user, 'supersede', previous, '改为', '周报邮箱'),
    } : {}) })
  }, () => now).start()
  memory.accept(initial, origin)
  await memory.wake()
  const bare = memory.accept(local, origin, randomUUID(), answer)
  await memory.wake()
  assert.equal(store.readSource(bare.sourceId)?.outcome, 'candidate')
  assert.deepEqual(memory.listMemories().items.map(item => item.fact?.object), ['amber@example.test'])
  now++
  const grounded = memory.accept(update, origin, randomUUID(), answer)
  await memory.wake()
  assert.equal(store.readSource(grounded.sourceId)?.questionId, 'mail')
  assert.deepEqual(memory.listMemories().items.map(item => item.fact?.object), ['cobalt@example.test'])
})

test('a card answer with a structurally valid intent span still needs independent lasting authorization', async t => {
  const oneTime = '这次用蓝色'
  const lasting = '以后请用绿色'
  const answer = { question: '这次用哪个颜色？', requestId: 'question', questionId: 'color', custom: true } as const
  const { memory } = fixture(t, async job => {
    const { user } = computeInput(job.input)
    const value = user === oneTime ? '蓝色' : '绿色'
    return proposal(user, { durableIntent: sourceSpan(user, user.slice(0, 2)),
      fact: { predicate: 'display_color', subject: { kind: 'user' }, relation: sourceSpan(user, '用'),
        object: sourceSpan(user, value), polarity: 'positive' } })
  }, Date.now, async job => {
    const input = JSON.parse(job.input)
    assert.equal(input.proposals[0].draft.purpose, 'answer-intent')
    return reviewVerdict(job, input.user === oneTime ? 'rejected' : 'confirmed')
  }).start()
  memory.accept(oneTime, origin, undefined, answer)
  await memory.wake()
  assert.equal(memory.listMemories().total, 0)
  memory.accept(lasting, origin, undefined, answer)
  await memory.wake()
  assert.deepEqual(memory.listMemories().items.map(entry => entry.fact?.object), ['绿色'])
})

test('withdrawing a saved question answer withdraws every typed source from that card only', t => {
  const answer = { requestId: 'this-card', questionId: 'one', question: 'Which one?', custom: true } as const
  const { memory, store } = fixture(t).start()
  const first = memory.accept('First answer', origin, undefined, answer).sourceId
  const second = memory.accept('Second answer', origin, undefined, { ...answer, questionId: 'two' }).sourceId
  const other = memory.accept('Other answer', origin, undefined, { ...answer, requestId: 'another-card' }).sourceId
  memory.holdWithdrawal(origin.conversation, [first])
  assert.equal(memory.sourceCurrent(second), false)
  memory.withdraw({ conversation: origin.conversation, ids: [first], onlySources: true })
  memory.releaseWithdrawal(origin.conversation, [first])
  assert.equal(store.readSource(first)?.withdrawn, true)
  assert.equal(store.readSource(second)?.withdrawn, true)
  assert.equal(memory.sourceCurrent(other), true)
})

test('explicitly saved future plans remain recallable as plans while keeping their intended date', async t => {
  const words = '记住：我明年可能搬去杭州'
  const { memory } = fixture(t, async job => {
    const input = JSON.parse(job.input) as { user: string, spans: Array<{ start: number, end: number }> }
    return proposal(input.user, { spans: input.spans, modality: 'planned', fact: { ...structured(words, '搬去', '杭州', 'planned_move'), polarity: 'uncertain' },
      temporal: sourceInterval(words, '明年', '2027-01-01', '2028-01-01') })
  }, () => date('2026-07-01')).start()
  memory.accept(words, origin)
  await memory.wake()
  const [saved] = memory.listMemories().items
  assert.equal(saved.modality, 'planned')
  assert.equal(saved.fact?.intendedFrom, date('2027-01-01'))
  assert.equal(saved.fact?.intendedTo, date('2028-01-01'))
  const recalled = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '杭州' }, origin))
  assert.equal(recalled.memories[0].modality, 'planned')
  assert.doesNotMatch(memory.handle({ op: 'context', session: origin.session, turn: 1, question: '杭州' }, origin), /杭州/)
})

test('a natural save request can preserve an uncertain plan without promoting an unsaved plan', async t => {
  const unsaved = '我明年可能搬去厦门'
  const requested = '请记住我明年可能搬去杭州'
  const { memory } = fixture(t, async job => {
    const { user } = computeInput(job.input)
    return proposal(user, {
      modality: 'planned', fact: { ...structured(user, '搬去', user === unsaved ? '厦门' : '杭州', 'planned_move'), polarity: 'uncertain' },
      temporal: sourceInterval(user, '明年', '2027-01-01', '2028-01-01'),
      ...(user === requested ? { durableIntent: sourceSpan(user, '请记住') } : {}),
    })
  }, () => date('2026-07-01')).start()
  memory.accept(unsaved, origin)
  await memory.wake()
  assert.equal(memory.listMemories().total, 0)
  assert.equal(memory.accept(requested, origin).outcome, 'pending')
  await memory.wake()
  const [saved] = memory.listMemories().items
  assert.equal(saved.modality, 'planned')
  assert.equal(saved.fact?.object, '杭州')
  assert.equal(saved.fact?.intendedFrom, date('2027-01-01'))
  assert.equal(saved.fact?.intendedTo, date('2028-01-01'))
  assert.equal(memory.listChanges().length, 0)
})

test('deleting one fact preserves a separately supported clause of the same source', async t => {
  const coffee = '我的常喝饮品是咖啡'
  const font = '我的首选字体是 Inter'
  const text = `${coffee}，${font}`
  const { memory, store } = fixture(t, async () => {
    const make = (relation: string, value: string, predicate: string, first: boolean) => {
      const owner = first ? text.indexOf('我') : text.lastIndexOf('我')
      return { ...JSON.parse(proposal(text)).proposals[0], spans: [sourceSpan(text, first ? coffee : font)], fact: {
        ...structured(text, relation, value, predicate),
        subject: { kind: 'user', span: { start: owner, end: owner + 1 } },
      } }
    }
    return JSON.stringify({ proposals: [make('常喝饮品', '咖啡', 'favorite_drink', true), make('首选字体', 'Inter', 'preferred_font', false)] })
  }).start()
  const receipt = memory.accept(text, origin)
  await memory.wake()
  const entries = memory.listMemories().items
  const removed = entries.find(entry => entry.text === coffee)!
  const retained = entries.find(entry => entry.text === font)!
  assert.equal(removed.evidence[0].sourceId, receipt.sourceId)
  assert.equal(retained.evidence[0].sourceId, receipt.sourceId)
  assert.deepEqual(await memory.deleteMemory(removed.id, removed.revision), { status: 'cleared' })
  assert.equal(store.get(removed.id), null)
  assert.equal(store.get(retained.id)?.text, font)
  assert.equal(store.readSource(receipt.sourceId)?.text?.includes(coffee), false)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.text), [font])
})

test('deleting overlapping evidence removes an unsupported peer projection even with a withdrawn edge', async t => {
  const { memory, store } = fixture(t).start()
  const marker = '测试删除残留 amber-9a2a@example.com'
  const target = memory.addMemory(marker)
  const peer = memory.addMemory('另有独立但已撤回的证据')
  assert.ok(target && peer)
  assert.equal(target.evidence.length, 1)
  assert.equal(peer.evidence.length, 1)
  const [sourceEdge] = target.evidence
  const source = store.readSource(sourceEdge.sourceId)!
  const [withdrawnEdge] = peer.evidence
  store.tx(() => {
    store.withdrawSource(withdrawnEdge.sourceId)
    const revision = store.nextRevision()
    const window = { from: peer.assertedFrom, to: peer.assertedTo }
    store.evidence(peer.id, source, sourceEdge.start, sourceEdge.end, null, null, window, sourceEdge.spans)
    store.project(peer.id, { ...peer, text: marker }, revision)
  })
  assert.equal(store.storedEvidence(peer.id).length, 2)
  assert.deepEqual(await memory.deleteMemory(target.id, target.revision), { status: 'cleared' })
  assert.equal(store.get(peer.id), null)
  assert.equal(store.storedEvidence(peer.id).length, 0)
})

test('replay validates every original source even after its extraction text was discarded', async t => {
  const { memory, store } = fixture(t, async () => '{"proposals":[]}').start()
  const first = '修改草稿\n\n别改标题 🟣'
  const second = '完成以后告诉我'
  const a = memory.accept(first, origin).sourceId
  const b = memory.accept(second, origin).sourceId
  await memory.wake()
  assert.equal(store.readSource(a)?.text, null)
  assert.equal(memory.replaySources([a, b], `${first}\n\n${second}`), true)
  assert.equal(memory.replaySources([a, b], `${first}\n${second}`), false)
  assert.equal(memory.replaySources([b, a], `${first}\n\n${second}`), false)
  memory.withdraw({ conversation: origin.conversation, ids: [a] })
  assert.equal(memory.replaySources([a, b], `${first}\n\n${second}`), false)
})

test('a replacement loses its effect when its only source is withdrawn', async t => {
  const before = '从2026-01-01起，我的周报邮箱是 amber@example.test'
  const update = '从2026-03-01起，我的周报邮箱从 amber@example.test 改为 cobalt@example.test'
  const changeOrigin = { conversation: 'change-conversation', session: 'change-session' }
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const previous = related.find(entry => entry.text === before)
    return proposal(user, {
      fact: structured(user, '周报邮箱', user === before ? 'amber@example.test' : 'cobalt@example.test', 'report_email'),
      temporal: sourceInterval(user, user.slice(0, 12), user.slice(1, 11)),
      ...(user === update && previous ? { change: proposedChange(user, 'supersede', previous, '改为', 'amber@example.test', '从2026-03-01起', '2026-03-01') } : {}),
    })
  }, () => date('2026-07-01')).start()
  const first = memory.accept(before, origin)
  await memory.wake()
  const change = memory.accept(update, changeOrigin)
  await memory.wake()
  assert.equal(memory.sourceCurrent(first.sourceId), false)
  assert.equal(memory.sourceCurrent(change.sourceId), false)
  assert.equal(memory.listMemories().items[0]?.fact?.object, 'cobalt@example.test')
  memory.withdraw({ conversation: changeOrigin.conversation, ids: [change.sourceId] })
  assert.equal(memory.sourceCurrent(first.sourceId), true)
  assert.equal(memory.sourceCurrent(change.sourceId), false)
  assert.equal(memory.listMemories().items[0]?.fact?.object, 'amber@example.test')
  assert.equal(memory.listMemories().items[0]?.validTo, null)
  assert.equal(memory.listChanges()[0]?.status, 'withdrawn')
  assert.equal(store.readSource(change.sourceId)?.text, null)
})

test('deleting the replaced fact redacts its quoted value from the change source', async t => {
  const before = '从2026-01-01起，我的周报邮箱是 amber@example.test'
  const update = '从2026-03-01起，我的周报邮箱从 amber@example.test 改为 cobalt@example.test'
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const previous = related.find(entry => entry.text === before)
    return proposal(user, {
      fact: structured(user, '周报邮箱', user === before ? 'amber@example.test' : 'cobalt@example.test', 'report_email'),
      temporal: sourceInterval(user, user.slice(0, 12), user.slice(1, 11)),
      ...(user === update && previous ? { change: proposedChange(user, 'supersede', previous, '改为', 'amber@example.test', '从2026-03-01起', '2026-03-01') } : {}),
    })
  }, () => date('2026-07-01')).start()
  memory.accept(before, origin)
  await memory.wake()
  const old = memory.listMemories().items[0]
  const source = memory.accept(update, origin)
  await memory.wake()
  assert.deepEqual(await memory.deleteMemory(old.id, store.get(old.id)!.revision), { status: 'cleared' })
  assert.equal(store.get(old.id), null)
  assert.doesNotMatch(store.readSource(source.sourceId)?.text ?? '', /amber@example\.test/)
  assert.doesNotMatch(JSON.stringify(memory.listChanges()), /amber@example\.test/)
  assert.equal(memory.listMemories().items[0]?.fact?.object, 'cobalt@example.test')
})

test('deleting a fact clears unconfirmed candidates that quoted it and keeps separately grounded facts', async t => {
  const marker = 'amber-candidate-cleanup@example.test'
  const before = `我的周报邮箱是 ${marker}`
  const update = `以后我的周报邮箱从 ${marker} 改为 cobalt@example.test`
  const surviving = '我习惯先看摘要'
  let at = date('2026-07-01')
  let old: Ref | undefined
  const f = fixture(t, async job => {
    const { user } = computeInput(job.input)
    if (user === before) return proposal(user, { fact: structured(user, '周报邮箱', marker, 'report_email') })
    assert.ok(old)
    const main = JSON.parse(proposal(user, { spans: [sourceSpan(user, update)],
      fact: structured(user, '周报邮箱', 'cobalt@example.test', 'report_email'),
      change: proposedChange(user, 'supersede', old, '改为', marker, undefined),
    })).proposals[0]
    if (user === update) return JSON.stringify({ proposals: [main] })
    const independent = JSON.parse(proposal(user, { spans: [sourceSpan(user, surviving)] })).proposals[0]
    return JSON.stringify({ proposals: [main, independent] })
  }, () => at, async job => {
    const reviews = computeInput(job.input).proposals?.map(({ index, draft }) => ({ index, draftId: draft.id, verdict: 'uncertain', sameRelation: true }))
    return JSON.stringify({ reviews })
  })
  const { memory, store } = f.start()
  memory.accept(before, origin)
  await memory.wake()
  old = store.list().find(entry => entry.text === before)
  assert.ok(old)
  at += 1_000
  const { sourceId } = memory.accept(`${update}。${surviving}`, origin)
  await memory.wake()
  assert.equal(store.db.prepare('SELECT reason FROM memory_candidates WHERE source=?').get(sourceId)?.reason, 'uncertain-change')
  assert.ok(store.readSource(sourceId)?.text?.includes(marker))

  assert.deepEqual(await memory.deleteMemory(old.id, old.revision), { status: 'cleared' })
  assert.equal(store.db.prepare('SELECT 1 FROM memory_candidates WHERE source=?').get(sourceId), undefined)
  assert.equal(store.readSource(sourceId)?.text?.trim(), surviving)
  assert.deepEqual(memory.listMemories().items.map(({ text }) => text), [surviving])
  for (const file of [f.file, `${f.file}-wal`]) assert.equal(fs.readFileSync(file).includes(marker), false, file)

  const retry = memory.accept(update, origin)
  await memory.wake()
  assert.equal(store.db.prepare('SELECT 1 FROM memory_candidates WHERE source=?').get(retry.sourceId), undefined)
  assert.equal(store.readSource(retry.sourceId)?.text, null)
})

test('a change without a unique target does not become a current fact', async t => {
  const before = '我的周报邮箱是 amber@example.test'
  const other = '我的周报邮箱是 mint@example.test'
  const update = '请把周报邮箱改为 cobalt@example.test'
  let now = date('2026-07-01')
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const previous = related.find(entry => entry.text === before)
    const object = user.split(' ').at(-1)!
    const fact = user === update
      ? { subject: { kind: 'user' as const }, polarity: 'positive' as const, predicate: 'report_email', relation: sourceSpan(user, '周报邮箱'), object: sourceSpan(user, object) }
      : structured(user, '周报邮箱', object, 'report_email')
    return proposal(user, {
      fact, ...(user === update && previous ? { change: proposedChange(user, 'supersede', previous, '改为', '周报邮箱') } : {}),
    })
  }, () => now, job => Promise.resolve(reviewVerdict(job, 'uncertain'))).start()
  for (const text of [before, other, update]) {
    now += 1_000
    memory.accept(text, origin)
    await memory.wake()
  }
  assert.equal(memory.listChanges().length, 0)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.text).sort(), [before, other].sort())
  assert.equal(store.db.prepare('SELECT reason FROM memory_candidates').get()?.reason, 'uncertain-change')
  const foreground = { ...origin, foregroundTurn: 'pending-update-test' }
  const recall = (query: string, reader = foreground) =>
    JSON.parse(memory.handle({ op: 'recall', session: origin.session, query }, reader))
  const result = recall('周报邮箱')
  assert.equal(result.pendingChanges.length, 1)
  assert.equal(result.pendingChanges[0].status, 'provisional')
  assert.equal(result.pendingChanges[0].current.text, before)
  assert.equal(result.pendingChanges[0].alternative.value, 'cobalt@example.test')
  assert.ok(result.memories.some((entry: { text: string }) => entry.text === before))
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(recall('青城维修').pendingChanges, [])
  const background = recall('周报邮箱', { ...foreground, foregroundTurn: '' })
  assert.deepEqual(background.pendingChanges, [])
  assert.ok(background.reasons.includes('pending-change'))
  assert.doesNotMatch(JSON.stringify(background), /cobalt@example\.test/)
  assert.doesNotMatch(memory.handle({ op: 'context', session: origin.session, turn: 1, question: '周报邮箱' }, foreground), /cobalt@example\.test/)
  const { ref } = result.pendingChanges[0]
  const ask = { op: 'clarify' as const, session: origin.session, ref }
  assert.equal(JSON.parse(memory.handle(ask, { ...foreground, foregroundTurn: 'different-turn' })).status, 'rejected')
  const card = JSON.parse(memory.handle(ask, foreground))
  assert.equal(card.status, 'ready')
  assert.match(card.question.options[0].label, /已保存.*amber@example\.test/)
  assert.match(card.question.options[1].label, /未确认.*cobalt@example\.test/)
  assert.ok(memory.clarificationQuestion(origin.session, foreground.foregroundTurn, card.question.id, 'show'))
  assert.equal(JSON.parse(memory.handle(ask, foreground)).reason, 'already-asked')
  assert.equal(memory.provisionalReadsCurrent(origin.session), true)
  const deadline = memory.provisionalDeadline(origin.session, now)
  assert.equal(deadline, now + 7 * 86_400_000)
  const target = store.list().find(entry => entry.text === before)!
  store.touch(target.id, target.revision + 1)
  assert.equal(memory.provisionalReadsCurrent(origin.session), false)
  assert.equal(memory.clarificationQuestion(origin.session, foreground.foregroundTurn, card.question.id, 'check'), null)
  store.touch(target.id, target.revision)
  now = deadline!
  assert.equal(memory.provisionalReadsCurrent(origin.session), false)
  assert.equal(memory.clarificationQuestion(origin.session, foreground.foregroundTurn, card.question.id, 'check'), null)
  assert.deepEqual(recall('周报邮箱').pendingChanges, [])
})

test('review can expose a provisional alternative expressed with a different relation phrase', async t => {
  const before = '我的直属上级是李四'
  const update = '我以后直接汇报给王五'
  let at = date('2026-07-01')
  const { memory } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    const prior = related.find(item => item.text === before)
    return proposal(user, { fact: structured(user, prior ? '直接汇报给' : '直属上级', prior ? '王五' : '李四', 'reporting_line'),
      ...(prior ? { change: proposedChange(user, 'supersede', prior, '以后', '直接汇报给') } : {}) })
  }, () => at, async job => {
    const reviews = computeInput(job.input).proposals?.map(({ index, draft }) => ({ index, draftId: draft.id, verdict: 'uncertain', sameRelation: true }))
    return JSON.stringify({ reviews })
  }).start()
  for (const words of [before, update]) {
    at++
    memory.accept(words, origin)
    await memory.wake()
  }
  const recalled = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '直属上级' },
    { ...origin, foregroundTurn: 'synonym' }))
  assert.equal(recalled.pendingChanges[0]?.alternative.value, '王五')
  assert.equal(recalled.memories[0]?.text, before)
})

test('undo keeps an independent assertion of the replacement as a possible conflict', async t => {
  const before = '从2026-01-01起，我的周报邮箱是 amber@example.test'
  const update = '从2026-03-01起，我的周报邮箱从 amber@example.test 改为 cobalt@example.test'
  const independent = '从2026-04-01起，我的周报邮箱是 cobalt@example.test'
  const { memory } = fixture(t, async ({ input }) => {
    const { user, related } = computeInput(input)
    const previous = related.find(entry => entry.text === before)
    return proposal(user, {
      fact: structured(user, '周报邮箱', user === before ? 'amber@example.test' : 'cobalt@example.test', 'report_email'),
      temporal: sourceInterval(user, user.slice(0, 12), user.slice(1, 11)),
      ...(user === update && previous ? { change: proposedChange(user, 'supersede', previous, '改为', 'amber@example.test', '从2026-03-01起', '2026-03-01') } : {}),
    })
  }, () => date('2026-07-01')).start()
  for (const text of [before, update, independent]) {
    memory.accept(text, origin)
    await memory.wake()
  }
  const change = memory.listChanges()[0]
  assert.deepEqual(await memory.undoChange(change.id, change.revision, undefined, change.expectedRevisions), { status: 'applied' })
  assert.equal(memory.listMemories().total, 0)
  const conflicts = memory.listInvalid().filter(entry => entry.state === 'disputed')
  assert.deepEqual(conflicts.map(entry => entry.text).sort(), [before, independent].sort())
  assert.equal(memory.listChanges()[0].status, 'undone')
  const read = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报邮箱', asOf: '2026-03-15' }, origin))
  assert.equal(read.memories[0].text, before)
  assert.equal(read.conflicts.length, 0)
})

test('a batch review can reject a same-value wrong relationship and approve the actual transition', async t => {
  const team = '我在支付组工作'
  const receiver = '我的周报收件人是支付组'
  const update = '11 月 16 日零点起，我从支付组调到风控组'
  const seen: MemoryCompute[] = []
  const dateOfTransition = '2026-11-16'
  let now = date('2026-11-14')
  const { memory, store } = fixture(t, async job => {
    seen.push(job)
    const { user, related } = computeInput(job.input)
    if (user === team) return proposal(user, { fact: structured(user, '在', '支付组', 'team') })
    if (user === receiver) return proposal(user, { fact: structured(user, '周报收件人', '支付组', 'recipient') })
    const make = (old: Ref) => ({
      ...JSON.parse(proposal(user, { fact: structured(user, '调到', '风控组', 'team') })).proposals[0],
      change: proposedChange(user, 'supersede', old, '调到', '支付组', '11 月 16 日零点起', dateOfTransition),
    })
    return JSON.stringify({ proposals: [make(related.find(entry => entry.text === receiver)!), make(related.find(entry => entry.text === team)!)] })
  }, () => now, async job => {
    seen.push(job)
    const { proposals, related } = computeInput(job.input)
    assert.ok(proposals)
    assert.deepEqual(related.map(entry => entry.text).sort(), [receiver, team].sort())
    return JSON.stringify({ reviews: proposals.map(({ index, draft }) => ({ index, draftId: draft.id, verdict: index === 0 ? 'rejected' : 'confirmed' })) })
  }).start()
  for (const text of [team, receiver, update]) {
    now += 1_000
    memory.accept(text, origin)
    await memory.wake()
  }
  assert.deepEqual(seen.map(job => job.stage), ['extract', 'extract', 'extract', 'review'])
  assert.equal(seen[2].sourceId, seen[3].sourceId)
  assert.notEqual(seen[2].id, seen[3].id)
  assert.equal(store.list().find(entry => entry.text === receiver)?.validTo, null)
  assert.equal(store.list().find(entry => entry.text === team)?.validTo, date(dateOfTransition))
  assert.equal(memory.listChanges().length, 1)
  assert.equal(memory.listChanges()[0].before, team)
  assert.equal(store.db.prepare('SELECT reason FROM memory_candidates').get()?.reason, 'unverified-change')
  const result = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '周报收件人' },
    { ...origin, foregroundTurn: 'rejected-update-test' }))
  assert.deepEqual(result.pendingChanges, [])
})

test('a target changed during review leaves the source pending without applying the stale result', async t => {
  const before = '我的提交地址是 old@example.test'
  const update = '我的提交地址切换至 new@example.test'
  const started = deferred<MemoryCompute>()
  const delayed = deferred<string>()
  const reviews: MemoryCompute[] = []
  let at = date('2026-11-14')
  const { memory, store } = fixture(t, async job => {
    const { user, related } = computeInput(job.input)
    if (user === before) return proposal(user, { fact: structured(user, '提交地址', 'old@example.test', 'address') })
    const prior = related.find(entry => entry.text.includes('old@example.test'))
    return proposal(user, {
      fact: structured(user, '提交地址', 'new@example.test', 'address'),
      ...(prior ? { change: proposedChange(user, 'supersede', prior, '切换至', '提交地址') } : {}),
    })
  }, () => at, async job => {
    reviews.push(job)
    if (reviews.length > 1) return reviewVerdict(job, 'uncertain')
    started.resolve(job)
    return delayed.promise
  }).start()
  memory.accept(before, origin)
  await memory.wake()
  const old = memory.listMemories().items[0]
  at += 1_000
  const source = memory.accept(update, origin)
  const firstReview = await started.promise
  assert.equal(memory.computeCurrent(firstReview.id), true)
  assert.equal(await memory.forget(old.id, old.revision, 'forget'), true)
  assert.equal(memory.computeCurrent(firstReview.id), false)
  delayed.resolve(confirmedReviews(firstReview))
  await memory.wake()
  assert.equal(memory.listChanges().length, 0)
  assert.equal(store.readSource(source.sourceId)?.outcome, 'pending')
  assert.equal(store.list().some(entry => entry.fact?.object === 'new@example.test'), false)
})

test('a cross-line quote, unknown event, and full long source keep their distinct admission outcomes', async t => {
  const quote = '测试引文：“\n我的工牌是 ID009。\n”'
  const event = '发布完成后我负责排班'
  const preference = '我的终端字体是 Iosevka'
  const long = preference + '。' + '请把这部分当作普通上下文'.repeat(60)
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user } = computeInput(input)
    if (user === quote) return proposal(user, { modality: 'reported', fact: structured(user, '工牌', 'ID009', 'badge') })
    if (user === event) return proposal(user, {
      temporal: { kind: 'event', evidence: [sourceSpan(user, '发布完成后')] },
      fact: structured(user, '负责', '排班', 'role'),
    })
    return proposal(user, { spans: [sourceSpan(user, preference)], fact: structured(user, '终端字体', 'Iosevka', 'font') })
  }).start()
  let longSourceId = ''
  for (const source of [quote, event, long]) {
    const { sourceId } = memory.accept(source, origin)
    if (source === long) longSourceId = sourceId
    await memory.wake()
  }
  assert.equal(store.readSource(longSourceId)?.text, preference)
  assert.equal(memory.replaySource(longSourceId, long), true)
  assert.deepEqual(memory.listMemories().items.map(entry => entry.text), [preference])
  assert.deepEqual(store.db.prepare('SELECT reason FROM memory_candidates ORDER BY reason').all().map(row => row.reason),
    ['unverified-modality', 'unverified-time-or-polarity'])
})

test('an expiry effect removes abandoned candidate source content without another extraction', async t => {
  let at = date('2026-07-01')
  const words = '引文：“我没有一个固定的排班角色。”'
  const { memory, store } = fixture(t, async () => proposal(words, { modality: 'reported' }), () => at).start()
  const { sourceId } = memory.accept(words, origin)
  await memory.wake()
  assert.equal(store.readSource(sourceId)?.text, words)
  assert.equal(store.db.prepare("SELECT due_at FROM effects WHERE kind='memory.expire'").get()?.due_at, at + 7 * 86_400_000)
  at += 7 * 86_400_000 + 1
  await memory.wake()
  assert.equal(store.readSource(sourceId)?.text, null)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_candidates').get()?.n, 0)
})

test('scoped store reads hydrate retained entries and their applied links in list order', async t => {
  const project = { id: 'shared-id', kind: 'project' } as const
  const conversation = { kind: 'conversation', id: project.id } as const
  const { memory, store } = fixture(t, async ({ input }) => {
    const { user } = JSON.parse(input) as { user: string }
    return proposal(user, { scope: user.includes('话题') ? 'conversation' : 'project', fact: structured(user, '负责', '排班', 'duty') })
  }, () => date('2026-07-01')).start()
  const global = memory.addMemory('我的编辑器使用 Iosevka')!
  const forgotten = memory.addMemory('我用番茄钟核对工作时间')!
  memory.accept('我负责项目排班', { ...origin, scope: project })
  memory.accept('我负责话题排班', { ...origin, context: conversation })
  await memory.wake()
  const entries = store.list()
  const scoped = entries.find(entry => entry.scope.kind === 'project')!
  const elsewhere = entries.find(entry => entry.scope.kind === 'conversation')!
  assert.ok(scoped.fact && scoped.evidence.length && elsewhere.fact && elsewhere.evidence.length)
  assert.equal(await memory.forget(forgotten.id, forgotten.revision, 'forget'), true)

  const link = { revision: store.revision(), targetId: scoped.id, replacementId: global.id, sourceId: null,
    sourceVersion: null, spans: [], from: null, to: null, effectiveAt: null, intentFrom: null, intentTo: null,
    createdAt: date('2026-07-01'), automatic: false }
  const conflict = store.recordChange({ ...link, kind: 'possible_conflict' })
  const correction = store.recordChange({ ...link, kind: 'correct', replacementId: elsewhere.id })
  const undone = store.recordChange({ ...link, kind: 'supersede' })
  store.setChangeStatus(undone, 'undone', store.revision())
  const expected = store.list().filter(entry => entry.id === scoped.id || entry.id === global.id)
  assert.deepEqual(expected.map(entry => entry.id), [scoped.id, global.id])
  assert.deepEqual(expected[0].links.map(edge => edge.changeId), [conflict, correction])

  // An unrelated evidence row must never reach the scoped hydration path.
  store.db.prepare("UPDATE memory_evidence SET spans='invalid' WHERE memory=?").run(elsewhere.id)
  assert.deepEqual(store.listForScope({ kind: 'project', id: project.id }), expected)
  assert.deepEqual(store.listForScope(), [expected[1]])
  assert.deepEqual(store.listForScope({ kind: 'user' }), [expected[1]])
  assert.deepEqual(store.listForScope({ kind: 'task', id: project.id }), [expected[1]])
})

test('healthy recall and context hydrate indexed candidates before same-scope unrelated evidence', async t => {
  const { memory, store } = fixture(t, undefined, () => date('2026-07-01')).start()
  const relevant = memory.addMemory('我的交接地址记在钴蓝专线')!
  const unrelated = memory.addMemory('我的笔记使用不同的排版设置')!
  await memory.wake()
  // Make a same-scope row unreadable as evidence so either path would throw if it hydrated the whole scope.
  store.db.prepare("UPDATE memory_evidence SET spans='invalid' WHERE memory=?").run(unrelated.id)
  const query = '钴蓝专线'
  const packet = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query }, origin))
  assert.deepEqual(packet.memories.map((item: { id: number }) => item.id), [relevant.id])
  assert.equal(packet.partial, false)
  const context = memory.handle({ op: 'context', session: origin.session, turn: 1, question: query }, origin)
  assert.match(context, /我的交接地址记在钴蓝专线/u)
})

test('healthy full text without a verified whole-word hit still falls back to keyword substrings', t => {
  const { memory } = fixture(t, undefined, () => date('2026-07-01')).start()
  const record = memory.addMemory('我使用 Iosevka 字体')!
  const query = 'Iose'
  const packet = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query }, origin))
  assert.deepEqual(packet.memories.map((item: { id: number }) => item.id), [record.id])
  assert.ok(!packet.reasons.includes('full-text-unavailable'))
  const context = memory.handle({ op: 'context', session: origin.session, turn: 1, question: query }, origin)
  assert.match(context, /Iosevka/u)
})

test('unavailable full text preserves bounded keyword recall with a partial reason', async t => {
  const at = date('2026-07-01')
  const { memory, store } = fixture(t, undefined, () => at).start()
  const old = memory.addMemory('北岸避险旧仓')!
  await memory.wake()
  const source = store.readSource(old.evidence[0].sourceId)!
  const row = { kind: 'fact', modality: 'asserted', conditional: false, keywords: [],
    scope: { kind: 'user' }, source: 'user', conversationId: null } as const
  const window = { from: null, to: null }
  store.tx(() => {
    const revision = store.nextRevision()
    for (let position = 0; position < 129; position++) {
      const id = store.insert({ ...row, keywords: [], text: `未关联的演示记录 ${position}` }, revision, at, window)
      store.evidence(id, source, 0, source.text!.length, null, null, window, [{ start: 0, end: source.text!.length }])
    }
  })
  const recent = memory.addMemory('北岸避险新仓')!
  store.db.exec('DROP TABLE memory_lexical_rows')
  const packet = JSON.parse(memory.handle({ op: 'recall', session: origin.session, query: '北岸避险' }, origin))
  assert.ok(packet.memories.some((item: { id: number }) => item.id === recent.id))
  assert.ok(!packet.memories.some((item: { id: number }) => item.id === old.id))
  assert.equal(packet.partial, true)
  assert.ok(packet.reasons.includes('full-text-unavailable'))
  assert.ok(packet.reasons.includes('keyword-fallback-limit'))
})

test('irrelevant admission and modality rows cannot consume the indexed context budget', async t => {
  const at = date('2026-07-01')
  const { memory, store } = fixture(t, undefined, () => at).start()
  const fact = memory.addMemory('备份手册说明冷杉港的生产值守时间与负责人。')!
  await memory.wake()
  const source = store.readSource(fact.evidence[0].sourceId)!
  const scope = { kind: 'user' } as const
  const base = { kind: 'fact', keywords: [], scope, source: 'user', conversationId: null } as const
  const window = { from: null, to: null }
  store.tx(() => {
    const revision = store.nextRevision()
    for (let i = 0; i < 132; i++) {
      // These rows include indexed terms, but only facts with admitted evidence and asserted modality belong in context.
      const text = `冷杉港 ${i}`
      const id = store.insert({ ...base, keywords: [], text, modality: 'planned', conditional: i % 2 === 0 }, revision, at, window)
      if (i % 2 === 0) store.evidence(id, source, 0, 3, null, null, window, [{ start: 0, end: 3 }])
    }
  })
  const context = memory.handle({ op: 'context', session: origin.session, turn: 1, question: '冷杉港' }, origin)
  assert.match(context, /备份手册说明冷杉港的生产值守时间与负责人/u)
})

test('profile excerpts are scoped, versioned, and fall back to safe canonical evidence', async t => {
  const store = openMemoryStore(':memory:')
  const userScope = { kind: 'user' } as const
  const project = { kind: 'project', id: 'project-one' } as const
  const other = { kind: 'project', id: 'project-two' } as const
  const a = '北辰项目的构建编号是 ORBIT-106'
  const b = '另一项目使用 NEBULA-301'
  const u = '我用剪纸做周末手工'
  type ProfileInput = { ref: { kind: 'memory', id: number, revision: number }, text: string }
  let recorded: import('../src/backend/memory-store.ts').MemoryDependency[] = []
  let observedNow = Date.now()
  const memory = createMemoryRuntime({
    store, now: () => observedNow, profilesEnabled: true, profileDelayMs: 0,
    route: () => ({ provider: 'fixture', model: 'profile-model' }),
    async compute(job) {
      const parsed = JSON.parse(job.input) as { user: string, items?: ProfileInput[] }
      if (job.stage === 'profile') return JSON.stringify({ refs: parsed.items!.slice(0, 1).map(item => item.ref) })
      if (job.stage !== 'extract' || ![a, b, u].includes(parsed.user)) return '{"proposals":[]}'
      return proposal(parsed.user, parsed.user === u ? {} : { scope: 'project', attribution: 'context' })
    },
    quiesce: async () => {}, changed: () => {},
    dependencies: (session, items) => { recorded = items; store.dispatch.dependencies(session, items) },
  })
  t.after(() => memory.close())
  memory.accept(a, { ...origin, project })
  memory.accept(b, { ...origin, project: other })
  memory.accept(u, origin)
  memory.addMemory('我偶尔会原样输入 </about-user> 字样')
  memory.profileView(project)
  memory.profileView(other)
  await memory.wake()
  for (let attempt = 0; attempt < 20 && !memory.profileView(project).generated; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await memory.wake()
  }
  const request = { op: 'context', turn: 1, session: origin.session, question: '继续' } as const
  const context = memory.handle(request, { ...origin, project })
  assert.match(context, /【项目摘要】/)
  assert.ok(context.includes(a) && !context.includes(b) && !context.includes('</about-user> 字样'))
  assert.ok(memory.profileView(userScope).items.every(line => !line.text.includes(a)))
  const evidence = store.dispatch.snapshot(origin.session)
  const collection = evidence.dependencies.find(item => item.collectionRevision !== undefined)
  assert.ok(collection)
  assert.equal(memory.dependenciesCurrent(evidence.dependencies), true)
  assert.equal(memory.projectAllows(evidence, project), true)
  assert.equal(memory.projectAllows(evidence, other), false)
  assert.equal(JSON.parse(memory.handle({ op: 'recall', query: 'ORBIT-106', session: origin.session, scope: 'project' }, origin)).reason, 'project-unavailable')
  assert.ok(memory.handle({ op: 'recall', query: 'ORBIT-106', session: origin.session, scope: 'project' }, { ...origin, project }).includes(a))

  // Adding a fact changes the input set without changing the selected project's own record.
  const row = store.get(collection.id)!
  observedNow += 1
  memory.addMemory('另一个已核验事实')
  assert.equal(store.get(row.id)?.revision, row.revision)
  assert.equal(memory.dependenciesCurrent(evidence.dependencies), false)
  const fallback = memory.handle(request, { ...origin, project })
  assert.match(fallback, /【项目原始记忆】/)
  assert.ok(fallback.includes(a) && !fallback.includes(b))
  assert.ok(recorded.every(item => item.collectionRevision === undefined))
})

test('an empty profile is regenerated when a timed disagreement ends', async t => {
  const store = openMemoryStore(':memory:')
  let at = date('2026-07-01')
  const start = at
  const before = date('2026-07-02')
  const memory = createMemoryRuntime({
    store, now: () => at, profilesEnabled: true, profileDelayMs: 0,
    route: () => ({ provider: 'fixture', model: 'profile-model' }),
    async compute(job) {
      if (job.stage !== 'profile') return '{"proposals":[]}'
      const { items } = JSON.parse(job.input) as { items: { ref: unknown }[] }
      return JSON.stringify({ refs: items.map(item => item.ref) })
    },
    quiesce: async () => {}, changed: () => {},
  })
  t.after(() => memory.close())
  const scope = { kind: 'user' } as const
  const first = memory.addMemory('我的固定收件地点是东门')!
  const second = memory.addMemory('我的固定收件地点是南门')!
  const revision = store.nextRevision()
  store.recordChange({ revision, targetId: first.id, replacementId: second.id, sourceId: null, sourceVersion: null,
    spans: [], kind: 'possible_conflict', from: start, to: before, intentFrom: start, intentTo: before,
    effectiveAt: null, createdAt: start, automatic: false })
  memory.refreshProfiles()
  await memory.wake()
  assert.deepEqual(memory.profileView(scope), { generated: true, items: [] })
  assert.equal(store.db.prepare('SELECT valid_until AS deadline FROM memory_projections').get()?.deadline, before)
  at = before
  assert.equal(memory.profileView(scope).generated, false)
  await memory.wake()
  assert.equal(memory.profileView(scope).generated, true)
  assert.deepEqual(memory.profileView(scope).items.map(item => item.dependency.id).sort(), [first.id, second.id])
})
