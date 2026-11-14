import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { localDay, memoryRelationLabel, nextDay } from '../src/backend/memory-facts.ts'
import { expandMemoryRelations as expand, memoryRelationQueryLabels } from '../src/backend/memory-relations.ts'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { memoryHash, openMemoryStore } from '../src/backend/memory-store.ts'
import type { MemoryEntry, MemorySource } from '../src/backend/memory-store.ts'
import type { MemoryInterval } from '../src/backend/memory-intervals.ts'
import { scratch } from './fixtures/scratch.js'

const interval = { from: 10, to: 20 }
const scope = { kind: 'project', id: 'primary' } as const
type Row = Parameters<typeof expand>[0]['seeds'][number]
type Expansion = Parameters<typeof expand<Row>>[0]
function expandMemoryRelations({ entries, query, ...options }: Omit<Expansion, 'roots' | 'neighbors'> & {
  entries: readonly Row[], query: string,
}) {
  const roots = memoryRelationQueryLabels(query).map(label => ({ scope, label }))
  return expand({
    ...options, roots, neighbors: ({ label }) => ({
      entries: entries.filter(entry => entry.fact && (memoryRelationLabel(entry.fact.subject.slice(6)) === label
        || memoryRelationLabel(entry.fact.object) === label)),
      partial: false,
    }),
  })
}
type Options = Partial<Omit<Row, 'fact' | 'evidence'>> & {
  source?: string, evidenceTime?: MemoryInterval, groundedSubject?: boolean, polarity?: NonNullable<MemoryEntry['fact']>['polarity'],
}
function row(id: number, subject: string, object: string, options: Options = {}): Row {
  const { source = `source-${id}`, evidenceTime = interval, groundedSubject = true, polarity = 'positive', ...overrides } = options
  const spans = { subject: groundedSubject && subject !== 'user' ? { start: 0, end: 1 } : undefined,
    statement: { start: 0, end: 5 }, relation: { start: 2, end: 3 }, object: { start: 4, end: 5 },
    spans: [{ start: 0, end: 5 }], qualifiers: [], conditions: [], temporal: [] }
  return {
    id, revision: id * 2, scope, updatedAt: id, state: 'active', retention: 'retained', modality: 'asserted', conditional: false,
    windows: [interval], fact: { subject: subject === 'user' ? subject : `named:${subject.toLowerCase()}`,
      relation: 'has', predicate: `relation_${id}`, object, polarity, dated: true, intendedFrom: null, intendedTo: null },
    evidence: [{ sourceId: source, sourceVersion: 1, conversationId: source, start: 0, end: 5, parts: spans, spans: spans.spans,
      changeId: null, assertedFrom: evidenceTime.from, assertedTo: evidenceTime.to, inheritsChangeTime: true }],
    ...overrides,
  }
}

test('relation expansion uses original facts in stable order and tracks the applicable path and proof versions', () => {
  const toB = row(1, '张三', 'Ｂ-West', { windows: [{ from: 10, to: 17 }] })
  const bOffice = row(2, 'B-West', '三楼', { windows: [{ from: 12, to: 19 }], evidenceTime: { from: 13, to: 19 } })
  const toC = row(3, 'B-West', 'C-17')
  const cOffice = row(4, 'C-17', '靠窗', { windows: [{ from: 14, to: 20 }] })
  const toD = row(5, 'C-17', '短名')
  const dFact = row(6, '短名', '最远')
  const entries = [toB, bOffice, toC, cOffice, toD, dFact]
  const initial = { entries, seeds: [toB], query: '张三', interval }

  const oneHop = expandMemoryRelations(initial)
  assert.deepEqual(oneHop.found.map(hit => hit.entry.id), [3, 2])
  const office = oneHop.found.find(hit => hit.entry.id === bOffice.id)!
  assert.equal(office.entry, bOffice)
  assert.deepEqual(office.path, [toB, bOffice])
  assert.ok(office.dependencies.includes(toB))
  assert.ok(office.dependencies.includes(bOffice))
  assert.deepEqual(office.windows, [{ from: 13, to: 17 }])

  const deep = expandMemoryRelations({ ...initial, deep: true })
  assert.deepEqual(deep.found.map(({ entry, hops }) => [entry.id, hops]), [[3, 1], [2, 1], [5, 2], [4, 2]])
  const desk = deep.found.find(hit => hit.entry.id === cOffice.id)!
  assert.deepEqual(desk.path, [toB, toC, cOffice])
  assert.deepEqual(desk.dependencies.map(({ id, revision }) => [id, revision]), [[1, 2], [3, 6], [5, 10], [4, 8]])
  assert.deepEqual([...desk.proofs.values()].flatMap(items => items.map(({ edge }) => edge.sourceId)), ['source-1', 'source-3', 'source-5', 'source-4'])
  assert.deepEqual(desk.windows, [{ from: 14, to: 17 }])
  assert.equal(deep.partial, false)
  assert.deepEqual(expandMemoryRelations({ ...initial, deep: true, entries: [...entries].reverse() }), deep)
})

test('separately sourced identity witnesses can cover different parts of one historical path', () => {
  const bridge = row(1, '张三', 'B')
  const early = row(2, 'B', '旧位置', { windows: [{ from: 10, to: 14 }], evidenceTime: { from: 10, to: 14 } })
  const later = row(3, 'B', '新位置', { windows: [{ from: 16, to: 20 }], evidenceTime: { from: 16, to: 20 } })
  const stale = row(9, 'B', '原文过期', { source: 'unrelated-stale-source', evidenceTime: { from: 1, to: 9 } })
  later.evidence.push(stale.evidence[0])
  const attached = row(4, 'B', '标识牌', { source: bridge.evidence[0].sourceId })
  const result = expandMemoryRelations({ entries: [bridge, early, later, attached], seeds: [bridge], query: '张三', interval })
  const sign = result.found.find(hit => hit.entry.id === attached.id)!
  assert.deepEqual(sign.windows, [{ from: 10, to: 14 }, { from: 16, to: 20 }])
  assert.deepEqual(sign.dependencies.map(entry => entry.id), [1, 3, 4, 2])
  assert.deepEqual([...new Set([...sign.proofs.values()].flatMap(items => items.map(({ edge }) => edge.sourceId)))], ['source-1', 'source-3', 'source-2'])
})

test('identity evidence needs a different source on the same portion of the relationship window', () => {
  const first = { from: 10, to: 14 }, later = { from: 16, to: 20 }
  const bridge = row(1, '张三', 'B', { source: 'shared', evidenceTime: first })
  const independent = row(2, '张三', 'B', { source: 'independent', evidenceTime: later })
  bridge.evidence.push(independent.evidence[0])
  const neighbor = row(3, 'B', '办公处', { source: 'shared' })
  const result = expandMemoryRelations({ entries: [bridge, neighbor], seeds: [bridge], query: '张三', interval })
  assert.deepEqual(result.found.map(({ entry, windows }) => ({ id: entry.id, windows })), [{ id: neighbor.id, windows: [later] }])
  assert.deepEqual(result.found[0].proofs.get(bridge.id)?.map(({ edge, windows }) => ({ source: edge.sourceId, windows })),
    [{ source: 'independent', windows: [later] }])
})

test('when equally short paths differ, a withheld validity window is reported as partial', () => {
  const early = row(1, '起点', 'B', { windows: [{ from: 10, to: 14 }] })
  const late = row(2, '起点', 'B', { windows: [{ from: 16, to: 20 }] })
  const related = row(3, 'B', '标识牌')
  const result = expandMemoryRelations({ entries: [early, late, related], seeds: [early, late], query: '起点', interval })
  assert.equal(result.partial, true)
  assert.deepEqual(result.found[0].path, [late, related])
  assert.deepEqual(result.found[0].windows, [{ from: 16, to: 20 }])
})

test('a spelling match must have independent current evidence in the same scope, with punctuation significant', () => {
  const toB = row(1, '张三', 'B-West')
  const sameSource = row(2, 'B-West', '同一陈述', { source: toB.evidence[0].sourceId })
  const wrongScope = row(3, 'B-West', '另一个项目', { scope: { kind: 'project', id: 'other' } })
  const punctuation = row(4, 'BWest', '另一个实体')
  const old = row(5, 'B-West', '过去不存在交集', { windows: [{ from: 1, to: 9 }] })
  const oldEvidence = row(6, 'B-West', '原文过期', { evidenceTime: { from: 1, to: 9 } })
  const unsupported = row(7, 'B-West', '没有主语依据', { groundedSubject: false })
  const held = row(8, 'B-West', '正在撤回')
  const result = expandMemoryRelations({ entries: [toB, sameSource, wrongScope, punctuation, old, oldEvidence, unsupported, held], seeds: [toB],
    query: '张三', interval, deep: true, evidenceAvailable: edge => edge.sourceId !== held.evidence[0].sourceId })
  assert.deepEqual(result, { found: [], partial: false })
})

test('a relation does not traverse disputed, conditional, uncertain or anonymous records', () => {
  const toB = row(1, '张三', 'B')
  const b = row(2, 'B', '3F')
  const forbidden = [
    row(3, 'B', '只在周一', { conditional: true }), row(4, 'B', '未来计划', { modality: 'planned' }),
    row(5, 'B', '不在这里', { polarity: 'negative' }), row(6, 'B', '可能在这里', { polarity: 'uncertain' }),
    row(7, 'B', '已遗忘', { retention: 'forgotten' }), row(8, 'B', '有争议'), row(9, 'B', '已撤回', { state: 'retracted' }),
  ]
  const userRelatesToB = row(10, 'user', 'B')
  const userRelatesToC = row(11, 'user', 'C')
  const c = row(12, 'C', '另一关系')
  const entries = [toB, b, ...forbidden, userRelatesToB, userRelatesToC, c]
  const result = expandMemoryRelations({ entries, seeds: [toB], query: '张三', interval, disputed: new Set([8]), deep: true })
  assert.deepEqual(result.found.map(hit => hit.entry.id), [10, 2])
  assert.deepEqual(expandMemoryRelations({ entries, seeds: [toB], query: '陈张三丰', interval, deep: true }), { found: [], partial: false })
  assert.deepEqual(expandMemoryRelations({ entries, seeds: [toB], query: '用户', interval, deep: true }), { found: [], partial: false })
})

test('large relation walks report partial results with stable candidate and entity caps', () => {
  const root = '起点'
  const edges = Array.from({ length: 60 }, (_, i) => row(i + 1, root, `node${i}`))
  const proofs = edges.map((edge, i) => row(i + 61, edge.fact!.object, `level${i}`))
  const args = { entries: [...edges, ...proofs], seeds: [], query: root, interval, deep: true }
  const nodes = expandMemoryRelations({ ...args, limit: 200 })
  assert.equal(nodes.partial, true)
  assert.equal(nodes.found.filter(hit => hit.entry.id > 60).length, 49)
  const candidates = expandMemoryRelations({ ...args, limit: 3 })
  assert.equal(candidates.partial, true)
  assert.equal(candidates.found.length, 3)
  assert.deepEqual(expandMemoryRelations({ ...args, shouldStop: () => true }), { found: [], partial: true })
})

test('direct facts at the depth limit keep their valid windows without requiring a witness for their object', () => {
  const bridge = row(1, '张三', 'B')
  const bToC = row(2, 'B', 'C')
  const c = row(3, 'C', '三楼', { windows: [{ from: 14, to: 16 }], evidenceTime: { from: 14, to: 16 } })
  const result = expandMemoryRelations({ entries: [bridge, bToC, c], seeds: [bridge], query: '张三', interval })
  assert.deepEqual(result.found.map(hit => [hit.entry.id, hit.hops, hit.windows]), [[bToC.id, 1, [interval]]])
  assert.equal(result.partial, false)
})

test('queries find exact standalone Latin identifiers and explicit Han names without unsegmented Han substring matches', () => {
  const west = row(1, 'B-West', '三楼')
  const han = row(2, '张三', '二楼')
  const options = { entries: [west, han], seeds: [], interval }
  assert.deepEqual(expandMemoryRelations({ ...options, query: 'Where is B-West?' }).found.map(hit => hit.entry.id), [west.id])
  assert.deepEqual(expandMemoryRelations({ ...options, query: "Where is 'B-West'?" }).found.map(hit => hit.entry.id), [west.id])
  assert.deepEqual(expandMemoryRelations({ ...options, query: '看看B-West的位置' }).found.map(hit => hit.entry.id), [west.id])
  assert.deepEqual(memoryRelationQueryLabels('请问「张 三」?'), ['请问「张 三」?', '张 三', '请问'])
  assert.deepEqual(expandMemoryRelations({ ...options, query: '请问「张三」在哪儿？' }).found.map(hit => hit.entry.id), [han.id])
  assert.deepEqual(expandMemoryRelations({ ...options, query: '请问陈张三丰在哪儿？' }).found, [])
})

test('current recall preserves the full applicable relation window', () => {
  const bridge = row(1, '张三', '北区', { windows: [{ from: 10, to: 17 }] })
  const office = row(2, '北区', '三楼', { windows: [{ from: 12, to: 19 }], evidenceTime: { from: 13, to: 19 } })
  const result = expandMemoryRelations({ entries: [bridge, office], seeds: [bridge], query: '张三',
    interval: { from: 15, to: 16 }, retainWindows: true })
  assert.deepEqual(result.found.map(hit => hit.windows), [[{ from: 13, to: 17 }]])
})

function relationRuntime(file: string, at: number) {
  const store = openMemoryStore(file, () => at)
  const memory = createMemoryRuntime({ store, route: () => null, compute: () => null, quiesce: async () => {},
    changed: () => {}, now: () => at, dependencies: store.dispatch.dependencies })
  return { store, memory }
}

function storedRelation(store: ReturnType<typeof openMemoryStore>, subject: string, relation: string, object: string,
  interval: MemoryInterval, support: { grounded: boolean; interval: MemoryInterval }[] = [{ grounded: true, interval }]) {
  const text = `${subject}${relation}${object}`
  const scope = { kind: 'user' } as const
  const conversationId = 'topic'
  const at = interval.from ?? 0
  const id = store.insert({ text, scope, kind: 'fact', source: 'agent', modality: 'asserted', conditional: false,
    keywords: [], conversationId }, store.nextRevision(), at, interval)
  const span = (word: string) => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length })
  const evidence = { subject: span(subject), relation: span(relation), object: span(object), statement: span(text),
    spans: [span(text)], qualifiers: [], conditions: [], temporal: [] }
  store.recordFact(id, { subject: `named:${subject}`, predicate: relation, relation, object, polarity: 'positive',
    ...interval, dated: true, uncertain: false, evidence })
  const sources = support.map(({ grounded, interval }) => {
    const sourceId = randomUUID()
    const source: MemorySource = { id: sourceId, operation: sourceId, version: 1, conversation: conversationId, session: 'main', scope, context: null,
      author: 'user', text, hash: memoryHash(text), length: text.length, question: null, requestId: null, questionId: null,
      at, timezone: 'UTC', outcome: 'accepted', withdrawn: false }
    store.insertSource(source)
    store.evidence(id, source, 0, text.length, grounded ? evidence : null, null, interval, evidence.spans)
    return source
  })
  return { id, sources, evidence }
}

test('a delivered relation expires across retries and restart even if its facts still have open support', t => {
  const { dir, defer } = scratch(t, 'viva-memory-relations-')
  const file = join(dir, 'memory.db')
  const at = Date.parse('2026-11-14T12:00:00Z'), until = at + 1000, started = at - 1000
  const open = { from: started, to: null }
  const proof = { from: started, to: until }
  const session = 'main', conversation = 'topic'
  const { store, memory } = relationRuntime(file, at)
  let priorClosed = false
  defer(() => { if (!priorClosed) memory.close() })
  const support = [{ grounded: false, interval: open }, { grounded: true, interval: proof }]
  const bridge = storedRelation(store, '张三', '负责', '北区', open, support)
  const office = storedRelation(store, '北区', '位于', '三楼', open, support)
  const request = { op: 'recall', session, query: '张三' } as const
  const origin = { session, conversation, foregroundTurn: 'turn' }
  const reply = JSON.parse(memory.handle(request, origin)) as { relations: { match: number; windows: MemoryInterval[] }[] }
  const hit = reply.relations[0]
  assert.equal(hit.match, office.id)
  assert.deepEqual(hit.windows, [proof])
  const delivered = JSON.stringify(hit)
  assert.ok(delivered.includes(bridge.sources[1].id) && delivered.includes(office.sources[1].id), 'deliver the source excerpts that ground the two steps')
  assert.ok(!delivered.includes(bridge.sources[0].id) && !delivered.includes(office.sources[0].id), 'exclude receipts that do not ground the path')
  const firstReads = store.dispatch.snapshot(session).dependencies
  assert.deepEqual(firstReads.filter(read => read.expiresAt === until).map(read => read.id).sort(), [bridge.id, office.id])
  assert.equal(memory.dependenciesCurrent(firstReads, until - 1), true)
  assert.equal(memory.dependenciesCurrent(firstReads, until), false)
  assert.equal(memory.dispatchDeadline(firstReads, [], at), until)
  const officeRevision = store.get(office.id)!.revision
  memory.close()
  priorClosed = true

  const reopened = relationRuntime(file, until)
  defer(() => reopened.memory.close())
  const lastingReads = reopened.store.dispatch.snapshot(session).dependencies
  assert.deepEqual(lastingReads, firstReads)
  assert.equal(reopened.memory.dependenciesCurrent(lastingReads), false)
  assert.equal(reopened.memory.dependenciesCurrent([{ id: office.id, revision: officeRevision }]), true)
  assert.deepEqual((JSON.parse(reopened.memory.handle(request, origin)) as typeof reply).relations, [])
})


test('historical relations retain uncontested portions and remember the original day across restart', t => {
  const { dir, defer } = scratch(t, 'viva-historical-relations-')
  const file = join(dir, 'memory.db')
  const oldZone = process.env.TZ
  defer(() => { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone })
  process.env.TZ = 'UTC'
  const day = '2026-11-14'
  const open = { from: localDay(day, 'UTC')!, to: localDay(nextDay(day), 'UTC')! }
  const afternoon = { from: open.from + 12 * 3_600_000, to: open.to }
  const at = open.to + 3_600_000
  const { store, memory } = relationRuntime(file, at)
  let closed = false
  defer(() => { if (!closed) memory.close() })
  storedRelation(store, '张三', '负责', '北区', open)
  const office = storedRelation(store, '北区', '位于', '三楼', open).id
  const disputed = storedRelation(store, '北区', '位于', '四楼', open).id
  store.recordChange({ revision: store.nextRevision(), targetId: office, replacementId: disputed, kind: 'possible_conflict',
    sourceId: null, sourceVersion: null, spans: [], ...afternoon, effectiveAt: afternoon.from, intentFrom: afternoon.from,
    intentTo: afternoon.to, createdAt: open.from, automatic: false })
  const request = { op: 'recall', session: 'main', query: '张三', asOf: day } as const
  const reply = JSON.parse(memory.handle(request, { session: 'main', conversation: 'topic' })) as {
    relations: Array<{ match: number; windows: MemoryInterval[] }>,
  }
  const morning = { from: open.from, to: afternoon.from }
  assert.deepEqual(reply.relations.map(({ match, windows }) => ({ match, windows })).sort((a, b) => a.match - b.match),
    [{ match: office, windows: [morning] }, { match: disputed, windows: [morning] }])
  const dependencies = store.dispatch.snapshot('main').dependencies
  assert.ok(dependencies.length >= 3)
  assert.ok(dependencies.every(item => item.asOf === day && item.asOfZone === 'UTC'))
  assert.equal(memory.dependenciesCurrent(dependencies, at), true)
  memory.close()
  closed = true
  process.env.TZ = 'America/Los_Angeles'
  const reopened = relationRuntime(file, at)
  defer(() => reopened.memory.close())
  assert.deepEqual(reopened.store.dispatch.snapshot('main').dependencies, dependencies)
  assert.equal(reopened.memory.dependenciesCurrent(dependencies, at), false)
  const fresh = JSON.parse(reopened.memory.handle(request, { session: 'main', conversation: 'topic' })) as typeof reply
  assert.deepEqual(fresh.relations.map(item => item.windows), [[{ from: open.from + 8 * 3_600_000, to: afternoon.from }],
    [{ from: open.from + 8 * 3_600_000, to: afternoon.from }]])
})

test('a relation cannot use a change receipt with a missing grounded part as its identity proof', t => {
  const at = Date.parse('2026-11-14T12:00:00Z')
  const open = { from: at - 50, to: null }
  const { store, memory } = relationRuntime(':memory:', at)
  t.after(() => memory.close())
  storedRelation(store, '张三', '负责', '北区', open)
  const old = storedRelation(store, '北区', '旧址', '一楼', { from: at - 100, to: at - 50 })
  const office = storedRelation(store, '北区', '位于', '三楼', open)
  const [source] = office.sources
  const change = store.recordChange({ revision: store.nextRevision(), targetId: old.id, replacementId: office.id, kind: 'supersede',
    sourceId: source.id, sourceVersion: source.version, ...open, effectiveAt: open.from, intentFrom: open.from, intentTo: null,
    spans: [{ start: 0, end: 0 }, office.evidence.subject], createdAt: open.from, automatic: true })
  store.bindEvidenceChange(office.id, source.id, 0, source.length, change, office.evidence)
  const request = { op: 'recall', session: 'main', query: '张三' } as const
  const reply = JSON.parse(memory.handle(request, { session: 'main', conversation: 'topic' })) as {
    relations: { match: number }[]; partial: boolean; reasons: string[],
  }
  assert.ok(!reply.relations.some(item => item.match === office.id))
  assert.ok(reply.partial)
  assert.ok(reply.reasons.includes('relation-evidence-unavailable'))
})
