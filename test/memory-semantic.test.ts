import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'
import { openMemorySemanticIndex } from '../src/backend/memory-semantic.ts'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/backend/memory-embedder.ts'
import type { MemoryEmbeddingInput, MemoryEmbeddingResult } from '../src/backend/memory-embedder.ts'
import type { MemoryScope } from '../src/shared/memory-contract.ts'
import type { MemoryInterval } from '../src/backend/memory-intervals.ts'

function fixture(t: TestContext) {
  const store = openMemoryStore(':memory:')
  t.after(() => store.close())
  const index = openMemorySemanticIndex(store.db)
  assert.ok(index)
  const create = (text: string, scope: MemoryScope = { kind: 'user' }, interval: MemoryInterval = { from: null, to: null }) => {
    const revision = store.nextRevision()
    const id = store.insert({ text, kind: 'fact', scope, modality: 'asserted', conditional: false,
      keywords: [], source: 'user', conversationId: null }, revision, Date.now(), interval)
    return { id, revision }
  }
  return { store, index, create }
}

function vector(...cells: number[]) {
  const result = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
  result.set(cells)
  return result
}

const exact = vector(1)
const close = vector(0.9, Math.sqrt(1 - 0.9 ** 2))
const unrelated = vector(0, 1)
const fingerprint = 'local-e5-small'
const allTime = { interval: { from: null, to: null } }

test('scoped semantic search checks exact scope, revision, and disjoint windows before ranking', async t => {
  const { store, index, create } = fixture(t)
  const at = { from: 15, to: 16 }
  const project: MemoryScope = { kind: 'project', id: 'ours' }
  const global = create('全局记录', undefined, { from: 0, to: 20 })
  const scoped = create('相关项目记录', { id: 'ours', kind: 'project' }, { from: 10, to: 20 })
  const peer = create('别的项目记录', { kind: 'project', id: 'theirs' }, { from: 10, to: 20 })
  const gap = create('当前处于空档', project, { from: 0, to: 20 })
  store.db.prepare('UPDATE memories SET windows=? WHERE id=?')
    .run(JSON.stringify([{ from: 0, to: 10 }, { from: 16, to: 20 }]), gap.id)
  const obsolete = create('过期向量', project)
  const missing = create('当前范围尚待索引的记录', project)
  const skipped = create('太长而未编码', project)
  assert.equal(index.configure(fingerprint), true)
  const version = index.version(fingerprint)!
  assert.equal(index.put(fingerprint, [
    { ...global, vector: close }, { ...scoped, vector: exact }, { ...peer, vector: exact }, { ...gap, vector: exact },
    { ...obsolete, vector: exact }, { ...skipped, vector: null },
  ], version), 6)
  store.touch(obsolete.id, store.nextRevision())
  const result = await index.searchScoped(fingerprint, exact, project, 5, { interval: at })
  assert.deepEqual(result, { hits: [scoped, global], partial: false, skipped: true, incomplete: true })
  const accepted = await index.searchScoped(fingerprint, exact, project, 1, {
    interval: at, accept: ({ id }) => id !== scoped.id,
  })
  assert.deepEqual(accepted, { hits: [global], partial: false, skipped: true, incomplete: true })
  const historical = await index.searchScoped(fingerprint, exact, project, 5, { interval: { from: 0, to: 9 } })
  assert.deepEqual(historical.hits, [gap, global])
  assert.deepEqual(index.missingScoped(fingerprint, project, at).map(({ id }) => id), [missing.id, obsolete.id])
  assert.deepEqual(index.missingAfter(fingerprint, obsolete.id), [missing])
  assert.deepEqual(await index.searchScoped(fingerprint, exact, undefined, 5, { interval: at }), {
    hits: [global], partial: false, skipped: false, incomplete: false,
  })
})

test('daily recall ranks persisted Viva memory vectors and daily notes together without re-embedding an indexed fact', async t => {
  const store = openMemoryStore(':memory:')
  const origin = { conversation: 'topic', session: 'session' }
  const seen: MemoryEmbeddingInput[] = []
  const memory = createMemoryRuntime({
    store, dailyNotes: { noteInterval: 1 },
    route: () => ({ provider: 'test', model: 'test' }), quiesce: async () => {}, changed() {},
    embedder: {
      fingerprint,
      close() {},
      async embedBatch(inputs) {
        seen.push(...inputs)
        return inputs.map(({ kind }) => kind === 'query' ? exact : close)
      },
    },
    async compute(job) {
      return JSON.stringify({ status: 'write', title: '交接事项', markdown: JSON.parse(job.input).turns[0].user[0].text })
    },
  })
  t.after(() => memory.close())
  const fact = memory.addMemory('门禁卡遗失后可以找园区物业补办')
  assert.ok(fact)
  const index = openMemorySemanticIndex(store.db)!
  index.configure(fingerprint)
  assert.equal(index.put(fingerprint, [{ id: fact.id, revision: fact.revision, vector: exact }], index.version(fingerprint)!), 1)
  const note = '今天新开了一个补办窗口'
  const sourceId = randomUUID()
  memory.accept(note, origin, sourceId)
  memory.recordNoteTurn!(origin.session, [sourceId], '好的')
  await memory.wake()

  const request = { op: 'recall' as const, query: 'who handles missing badges', session: origin.session }
  const keyword = JSON.parse(memory.handle(request, origin))
  assert.deepEqual(keyword.memories, [])
  assert.deepEqual(keyword.notes, [])
  const semantic = JSON.parse(await memory.handleModelRequest(request, origin, () => true))
  assert.deepEqual(semantic.memories.map((item: { id: number }) => item.id), [fact.id])
  assert.equal(semantic.memories[0].match, 'semantic')
  assert.deepEqual(semantic.notes.map((item: { markdown: string }) => item.markdown), [note])
  assert(semantic.memories[0].score > semantic.notes[0].score)
  assert(!seen.some(input => input.kind === 'passage' && input.text.includes(fact.text)))
  assert(seen.some(input => input.kind === 'passage' && input.text.includes(note)))
  assert.deepEqual(index.similarities(fingerprint, exact, [{ id: fact.id, revision: fact.revision + 1 }]), [])
  assert.deepEqual(index.similarities('other model', exact, [fact]), [])
})

test('scoped vector search ranks across pages, yields to cancellation and does not use a cleared generation', async t => {
  const { index, create } = fixture(t)
  index.configure(fingerprint)
  const version = index.version(fingerprint)!
  for (let batch = 0; batch < 35; batch++) {
    assert.equal(index.put(fingerprint, Array.from({ length: 8 }, (_, offset) => ({
      ...create(`早期候选 ${batch}:${offset}`), vector: close,
    })), version), 8)
  }
  const best = create('后页上最准确的候选')
  assert.equal(index.put(fingerprint, [{ ...best, vector: exact }], version), 1)
  const interval = { from: null, to: null }
  assert.deepEqual((await index.searchScoped(fingerprint, exact, undefined, 5, { interval })).hits[0], best)
  const abort = new AbortController()
  const cancelled = index.searchScoped(fingerprint, exact, undefined, 5, { interval, signal: abort.signal })
  abort.abort()
  assert.deepEqual((await cancelled).hits, [])
  const stale = index.searchScoped(fingerprint, exact, undefined, 5, { interval })
  index.clear()
  assert.deepEqual((await stale).hits, [])
})

test('dense semantic retrieval ranks authorized ID revisions and records unembeddable rows', async t => {
  const { store, index, create } = fixture(t)
  const first = create('例行汇报发给财务')
  const second = create('查看每周例行报告模板')
  const privatePeer = create('私有项目的同主题记录', { kind: 'project', id: 'private' })
  const other = create('周末安排')
  const empty = create('不能完整放入编码窗口')
  const authorized = [second, first, other, empty]
  const projections = [
    { ...first, vector: exact }, { ...second, vector: close },
    { ...privatePeer, vector: exact }, { ...other, vector: unrelated }, { ...empty, vector: null },
  ]
  assert.equal(index.configure(fingerprint), true)
  assert.equal(index.configure(fingerprint), false)
  const version = index.version(fingerprint)!
  assert.deepEqual(index.missing(fingerprint, authorized, 2), [second, first])
  assert.equal(index.put(fingerprint, projections, version), 5)
  assert.deepEqual(index.missing(fingerprint, authorized), [])
  assert.deepEqual(await index.searchScoped(fingerprint, exact, undefined, 10, allTime), {
    hits: [first, second], partial: false, skipped: true, incomplete: false,
  })
  assert.deepEqual(await index.searchScoped(fingerprint, exact, undefined, 1, allTime), {
    hits: [first], partial: true, skipped: true, incomplete: false,
  })
  assert.deepEqual(await index.searchScoped('a different model', exact, undefined, 10, allTime), {
    hits: [], partial: false, skipped: false, incomplete: false,
  })
  const row = store.db.prepare('SELECT vector FROM memory_semantic_vectors WHERE memory=?').get(first.id)
  assert.ok(row?.vector instanceof Uint8Array)
  assert.equal(row.vector.byteLength, MEMORY_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT)
  assert.notEqual(store.db.prepare('SELECT fingerprint FROM memory_semantic_config').get()?.fingerprint, fingerprint)
})

test('malformed vectors cannot partially write a batch or become results from a damaged row', async t => {
  const { store, index, create } = fixture(t)
  const first = create('归档 E5 依据')
  const second = create('不完整向量不应参与排序')
  index.configure(fingerprint)
  const version = index.version(fingerprint)!
  for (const malformed of [new Float32Array([1]), vector(0), vector(2), vector(NaN), vector(Infinity)]) {
    assert.equal(index.put(fingerprint, [{ ...first, vector: exact }, { ...second, vector: malformed }], version), 0)
    assert.deepEqual(index.missing(fingerprint, [first, second]), [first, second])
    assert.deepEqual((await index.searchScoped(fingerprint, malformed, undefined, 10, allTime)).hits, [])
  }
  assert.equal(index.put(fingerprint, [{ ...first, vector: exact }, { ...second, vector: exact }], version), 2)
  const damage = store.db.prepare('UPDATE memory_semantic_vectors SET vector=? WHERE memory=?')
  damage.run(Buffer.alloc(5), second.id)
  assert.deepEqual(await index.searchScoped(fingerprint, exact, undefined, 10, allTime), {
    hits: [first], partial: false, skipped: true, incomplete: true,
  })
  assert.deepEqual(index.missing(fingerprint, [first, second]), [second])
  damage.run(Buffer.alloc(MEMORY_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT), second.id)
  assert.deepEqual((await index.searchScoped(fingerprint, exact, undefined, 10, allTime)).hits, [first])
})

test('semantic vectors are cleared on canonical updates and stale writes cannot resurrect them', t => {
  const { store, index, create } = fixture(t)
  const edit = create('编辑前')
  const forgotten = create('已停止使用')
  const removed = create('即将删除')
  const moved = create('范围将变更')
  const rows = [edit, forgotten, removed, moved].map(row => ({ ...row, vector: exact }))
  index.configure(fingerprint)
  const version = index.version(fingerprint)!
  assert.equal(index.put(fingerprint, rows, version), 4)
  const revision = store.nextRevision()
  store.db.prepare('UPDATE memories SET text=?,revision=? WHERE id=?').run('编辑后', revision, edit.id)
  store.forgetEntry(forgotten.id, revision)
  store.remove(removed.id)
  store.db.prepare('UPDATE memories SET scope=? WHERE id=?').run('{"kind":"project","id":"new"}', moved.id)
  assert.deepEqual(store.db.prepare('SELECT * FROM memory_semantic_vectors').all(), [])
  assert.equal(index.put(fingerprint, rows.filter(row => row.id !== moved.id), version), 0)
  assert.deepEqual(index.missing(fingerprint, [{ id: edit.id, revision }, moved]), [{ id: edit.id, revision }, moved])
})

test('rebuilding or changing the local model fingerprint invalidates computations already in flight', t => {
  const { index, create } = fixture(t)
  const row = create('保留中的依据')
  const projection = { ...row, vector: exact }
  index.configure(fingerprint)
  const first = index.version(fingerprint)
  assert.ok(first !== null)
  assert.equal(index.put(fingerprint, [projection], first), 1)
  index.clear()
  const rebuilt = index.version(fingerprint)
  assert.ok(rebuilt !== null && rebuilt > first)
  assert.equal(index.put(fingerprint, [projection], first), 0)
  assert.equal(index.put(fingerprint, [projection], rebuilt), 1)
  index.configure('other model')
  index.configure(fingerprint)
  assert.deepEqual(index.missing(fingerprint, [row]), [row])
  assert.equal(index.put(fingerprint, [projection], rebuilt), 0)
  assert.equal(index.put(fingerprint, [projection], index.version(fingerprint)!), 1)
})

test('the index replaces malformed derived objects and migrates legacy hooks to the current connection', t => {
  const { store, index, create } = fixture(t)
  const row = create('保留中的依据')
  const projection = { ...row, vector: exact }
  index.configure(fingerprint)
  assert.equal(index.put(fingerprint, [projection], index.version(fingerprint)!), 1)
  store.db.exec(`
    DROP TABLE memory_semantic_vectors;
    CREATE VIEW memory_semantic_vectors AS SELECT id FROM memories;
    CREATE TRIGGER main.memory_semantic_invalidate_update AFTER UPDATE ON memories
    BEGIN DELETE FROM missing_legacy_index WHERE id=OLD.id; END;
    DROP TABLE memory_semantic_config;
    CREATE TABLE memory_semantic_config (singleton INTEGER, unrelated TEXT);
  `)
  const repaired = openMemorySemanticIndex(store.db)
  assert.ok(repaired)
  assert.ok(repaired.configure(fingerprint))
  assert.deepEqual(repaired.missing(fingerprint, [row]), [row])
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM main.sqlite_schema WHERE name LIKE 'memory_semantic_invalidate_%'").get()?.count, 0)
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM temp.sqlite_schema WHERE name LIKE 'memory_semantic_invalidate_%'").get()?.count, 2)
  assert.equal(repaired.put(fingerprint, [projection], repaired.version(fingerprint)!), 1)
  store.forgetEntry(row.id, store.nextRevision())
  assert.equal(store.db.prepare('SELECT * FROM memory_semantic_vectors').all().length, 0)
})

test('a read-only semantic database never attaches persistent hooks on fallback', () => {
  const store = openMemoryStore(':memory:')
  try {
    store.db.exec('PRAGMA query_only=ON;')
    assert.equal(openMemorySemanticIndex(store.db), null)
    store.db.exec('PRAGMA query_only=OFF;')
    const id = store.insert({ text: '仍能保存', kind: 'fact', scope: { kind: 'user' }, modality: 'asserted', conditional: false,
      keywords: [], source: 'user', conversationId: null }, store.nextRevision(), Date.now(), { from: null, to: null })
    assert.equal(store.get(id)?.text, '仍能保存')
  } finally { store.close() }
})

test('an unusable optional vector table never blocks a canonical change and its generation is retired', async t => {
  const { store, index, create } = fixture(t)
  const row = create('待忘记的原始记忆')
  const removed = create('待删除的原始记忆')
  index.configure(fingerprint)
  assert.equal(index.put(fingerprint, [row, removed].map(ref => ({ ...ref, vector: exact })), index.version(fingerprint)!), 2)
  store.db.exec(`CREATE TRIGGER damaged_vector_delete BEFORE DELETE ON memory_semantic_vectors
    BEGIN SELECT RAISE(ABORT,'damaged derived table'); END`)

  store.forgetEntry(row.id, store.nextRevision())
  assert.equal(store.get(row.id)?.retention, 'forgotten')
  assert.equal(index.version(fingerprint), null)
  assert.equal(index.configure(fingerprint), false)
  assert.deepEqual((await index.searchScoped(fingerprint, exact, undefined, 5, allTime)).hits, [])
  store.remove(removed.id)
  assert.equal(store.get(removed.id), null)

  const repaired = openMemorySemanticIndex(store.db)
  assert.ok(repaired)
  assert.ok(repaired.configure(fingerprint))
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM memory_semantic_vectors').get()?.count, 0)
})

const origin = { conversation: 'source-conversation', session: 'session', foregroundTurn: 'turn' }
const words = '例行汇报材料每周发给财务小组'
const query = 'Weekly report destination'

function runtimeFixture(t: TestContext) {
  const store = openMemoryStore(':memory:')
  let pending: { inputs: readonly MemoryEmbeddingInput[], signal: AbortSignal, resolve: (value: MemoryEmbeddingResult | null) => void } | null = null
  let providerComputations = 0
  const memory = createMemoryRuntime({
    store, route: () => ({ provider: 'fixture', model: 'model' }),
    quiesce: async () => {}, changed: () => {},
    compute: job => {
      providerComputations++
      if (job.stage !== 'extract') return null
      const { user } = JSON.parse(job.input) as { user: string }
      return Promise.resolve(JSON.stringify({ proposals: [{
        spans: [{ start: 0, end: user.length }], kind: 'fact', scope: 'user',
        modality: 'asserted', attribution: 'self', keywords: [],
      }] }))
    },
    embedder: { fingerprint, close: () => {}, embedBatch: (inputs, signal) => {
      assert.ok(signal)
      return new Promise(resolve => { pending = { inputs, signal, resolve } })
    } },
  })
  t.after(() => memory.close())
  function lookup(search = query, deep = false) {
    pending = null
    const response = memory.handleModelRequest({ op: 'recall', query: search, deep, session: origin.session }, origin, () => true)
    return Promise.resolve(response).then(value => JSON.parse(value) as { memories: { id: number, revision: number, text: string }[], reasons: string[] })
  }
  function encoding() {
    const current = pending
    assert.ok(current)
    return { ...current, complete: () => current.resolve(current.inputs.map(() => exact)) }
  }
  const countVectors = () => store.db.prepare('SELECT COUNT(*) AS count FROM memory_semantic_vectors').get()?.count
  return { memory, store, lookup, encoding, countVectors, computeCalls: () => providerComputations }
}

test('local dense vectors bind to the corresponding record revisions in a mixed input batch', async t => {
  const { memory, store, lookup, encoding, computeCalls } = runtimeFixture(t)
  const missing = memory.addMemory('这条文本超出测试的编码限制')!
  const relevant = memory.addMemory(words)!
  const irrelevant = memory.addMemory('周末常去公园慢跑')!
  await memory.wake()
  const before = computeCalls()
  const read = lookup()
  const encoded = encoding()
  assert.deepEqual(encoded.inputs.map(({ kind }) => kind), ['query', 'passage', 'passage', 'passage'])
  assert.deepEqual(new Set(encoded.inputs.slice(1).map(({ text }) => text)), new Set([missing.text, relevant.text, irrelevant.text]))
  encoded.resolve(encoded.inputs.map(({ kind, text }) => kind === 'query' || text === relevant.text ? exact : text === missing.text ? null : unrelated))
  assert.deepEqual((await read).memories.map(({ id, revision }) => ({ id, revision })), [{ id: relevant.id, revision: relevant.revision }])
  assert.deepEqual(store.db.prepare('SELECT memory,revision,length(vector) AS bytes FROM memory_semantic_vectors ORDER BY memory')
    .all().map(({ memory, revision, bytes }) => [memory, revision, bytes]), [
    [missing.id, missing.revision, 0], [relevant.id, relevant.revision, 1536], [irrelevant.id, irrelevant.revision, 1536],
  ])
  const reused = lookup()
  assert.deepEqual(encoding().inputs, [{ kind: 'query', text: query }])
  encoding().complete()
  const second = await reused
  assert.deepEqual(second.memories.map(({ id }) => id), [relevant.id])
  assert.ok(second.reasons.includes('semantic-unindexed-input'))
  assert.equal(computeCalls(), before)
})

test('rebuilding cancels pending local requests and only the fresh result populates the index', async t => {
  const { memory, lookup, encoding, countVectors } = runtimeFixture(t)
  assert.ok(memory.addMemory(words))
  await memory.wake()
  const during = lookup()
  const stale = encoding()
  assert.deepEqual(stale.inputs, [{ kind: 'query', text: query }, { kind: 'passage', text: words }])
  assert.equal(memory.rebuildIndexes().semantic, true)
  assert.ok(stale.signal.aborted)
  const after = lookup()
  const fresh = encoding()
  assert.deepEqual(fresh.inputs, stale.inputs)
  stale.complete()
  assert.deepEqual((await during).memories, [])
  assert.equal(countVectors(), 0)
  fresh.complete()
  assert.deepEqual((await after).memories.map(item => item.text), [words])
  assert.equal(countVectors(), 1)
})

test('holding a source rejects local inference results even when separate evidence retains the record', async t => {
  const { memory, store, lookup, encoding, countVectors } = runtimeFixture(t)
  const first = memory.accept(words, origin)
  await memory.wake()
  const second = memory.accept(words, { conversation: 'other-conversation', session: 'other' })
  await memory.wake()
  const saved = store.list().find(row => row.text === words)
  assert.ok(saved)
  assert.deepEqual(new Set(saved.evidence.map(edge => edge.sourceId)), new Set([first.sourceId, second.sourceId]))

  const before = lookup()
  const old = encoding()
  assert.deepEqual(old.inputs, [{ kind: 'query', text: query }, { kind: 'passage', text: words }])
  memory.holdWithdrawal(origin.conversation, [first.sourceId])
  old.complete()
  assert.deepEqual((await before).memories, [])
  assert.equal(countVectors(), 0)
  const whileHeld = lookup()
  assert.deepEqual((await whileHeld).memories, [])

  memory.withdraw({ conversation: origin.conversation, ids: [first.sourceId], onlySources: true })
  memory.releaseWithdrawal(origin.conversation, [first.sourceId])
  const after = lookup()
  encoding().complete()
  const refreshed = (await after).memories
  assert.deepEqual(refreshed.map(item => item.text), [words])
  assert.notEqual(refreshed[0].revision, saved.revision)
  assert.equal(countVectors(), 1)
})

test('explicit identifiers match the saved token even in deep semantic recall', async t => {
  const { memory, lookup, encoding } = runtimeFixture(t)
  const wanted = memory.addMemory('JUNIPER-42 的负责人是卢宁')!
  memory.addMemory('JUNIPER-43 的负责人是叶明')
  await memory.wake()

  const missing = await lookup('Who is responsible for JUNIPER-44?', true)
  assert.deepEqual(missing.memories, [])
  const recall = lookup('Who is responsible for JUNIPER-42?', true)
  const batch = encoding()
  assert.deepEqual(batch.inputs.slice(1), [{ kind: 'passage', text: wanted.text }])
  batch.complete()
  assert.deepEqual((await recall).memories.map(({ text }) => text), [wanted.text])
})
