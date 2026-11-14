/** Offline Viva retrieval benchmark. Usage: node scripts/memory-embedding-check.ts <model-dir> [runtime-dir] */
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { createMemoryEmbedder, MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_DIMENSIONS } from '../src/backend/memory-embedder.ts'
import type { MemoryEmbedder, MemoryEmbeddingKind } from '../src/backend/memory-embedder.ts'
import { createMemoryRuntime } from '../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'
import type { MemoryRequest, MemoryScope } from '../src/shared/memory-contract.ts'

const facts = [
  { id: 'report', text: '每周的工作汇报材料须发送给财务小组。' },
  { id: 'expense', text: '报销申请和票据要提交到行政支持邮箱。' },
  { id: 'release', text: 'Project JUNIPER-42 releases require sign-off from the infrastructure lead, Maya Chen.' },
  { id: 'juniper-folder', text: 'JUNIPER-42 的设计文件保存在团队云盘。' },
  { id: 'historical-team', text: '去年我在支付小组工作，主要负责清结算。' },
  { id: 'book-club', text: '我加入了公司的读书会，每两周线下讨论一次。' },
  { id: 'maintenance', text: '我们的每周维护窗口是周二上午九点到十一点。' },
  { id: 'review-format', text: 'When reviewing code, put the conclusion first and list the affected modules next.' },
  { id: 'review-exception', text: 'For casual conversation, avoid a rigid structure and keep the tone informal.' },
  { id: 'localization', text: '张三负责客户端的本地化和翻译。' },
  { id: 'qa', text: '张珊负责移动端质量保障。' },
  { id: 'delivery-east', text: '北区的快递只能交付给前台值班员。' },
  { id: 'delivery-west', text: '西区的快递可以放到二楼自提柜。' },
  { id: 'monitor', text: 'The staging service reports health to a status endpoint and does not page operations overnight.' },
  { id: 'report-format', text: '提交周报时请附上 PDF，不需要发送 Word 版本。' },
  { id: 'training', text: 'Saffron team meets every Monday at 10 for onboarding and training.' },
  { id: 'design-approval', text: '设计方案须由刘晨确认，之后交给产品经理归档。' },
  { id: 'support-a', text: '门禁卡丢失时联系园区物业。' },
  { id: 'support-b', text: '办公网络掉线应先联系内部 IT 服务台。' },
  { id: 'transport', text: 'The office parking permit must be renewed in December.' },
]

type Expectation = 'answer' | 'ambiguous' | 'absent'
type Query = { kind: Expectation, text: string, relevant: string[] }
const queries: Query[] = [
  { kind: 'answer', text: 'Weekly report destination', relevant: ['report'] },
  { kind: 'answer', text: 'Who should receive the recurring work summary?', relevant: ['report'] },
  { kind: 'answer', text: '平时把例行周进展发给谁？', relevant: ['report'] },
  { kind: 'answer', text: '我该把发票交给哪个部门？', relevant: ['expense'] },
  { kind: 'answer', text: '朱尼珀上线前要谁点头？', relevant: ['release'] },
  { kind: 'answer', text: 'JUNIPER-42 草稿在哪里？', relevant: ['juniper-folder'] },
  { kind: 'answer', text: 'When can we make changes during scheduled downtime?', relevant: ['maintenance'] },
  { kind: 'answer', text: '评审代码时输出从什么开始？', relevant: ['review-format'] },
  { kind: 'answer', text: '语言翻译归谁管？', relevant: ['localization'] },
  { kind: 'answer', text: '张三', relevant: ['localization'] },
  { kind: 'answer', text: 'Who should I call if my badge is missing?', relevant: ['support-a'] },
  { kind: 'answer', text: 'I cannot connect to company Wi-Fi. Who can help?', relevant: ['support-b'] },
  { kind: 'answer', text: 'When does our parking authorization expire?', relevant: ['transport'] },
  { kind: 'ambiguous', text: '快递应该送到哪？', relevant: ['delivery-east', 'delivery-west'] },
  { kind: 'ambiguous', text: 'Who handles these support requests?', relevant: ['support-a', 'support-b'] },
  { kind: 'absent', text: 'What is the capital of Sweden?', relevant: [] },
  { kind: 'absent', text: '新加坡明天会下雨吗？', relevant: [] },
  { kind: 'absent', text: 'Who approves travel reimbursements?', relevant: [] },
  { kind: 'absent', text: '周报每周几截止？', relevant: [] },
  { kind: 'absent', text: 'JUNIPER-43 发布要谁批准？', relevant: [] },
]

type Vector = ArrayLike<number>
type BenchmarkEmbedder = (texts: readonly string[], role: MemoryEmbeddingKind) => Promise<readonly Vector[]>
type RankedCase = Query & { top: { id: string, score: number }[], bestScore: number, margin: number }
const inTop = (ids: readonly string[], top: readonly string[]) => ids.some(id => top.includes(id))

function timingsOf(timings: number[]) {
  const ordered = [...timings].sort((a, b) => a - b)
  return { p50Ms: ordered[Math.floor(ordered.length * 0.5)], p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1] }
}

async function encodeAll(embed: BenchmarkEmbedder, texts: readonly string[], role: MemoryEmbeddingKind) {
  const encoded: Vector[] = []
  for (let from = 0; from < texts.length; from += MEMORY_EMBEDDING_BATCH) {
    const batch = texts.slice(from, from + MEMORY_EMBEDDING_BATCH)
    const vectors = await embed(batch, role)
    assert.equal(vectors.length, batch.length)
    for (const values of vectors) {
      const vector = Array.from(values)
      assert.equal(vector.length, MEMORY_EMBEDDING_DIMENSIONS, 'E5 output dimension')
      assert.ok(vector.every(Number.isFinite), 'finite vector')
      const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0)
      assert.ok(Math.abs(squaredNorm - 1) < 0.002, 'normalized embedding')
    }
    encoded.push(...vectors)
  }
  return encoded
}

function similarity(left: Vector, right: Vector) {
  let score = 0
  for (let i = 0; i < left.length; i++) score += left[i] * right[i]
  return score
}

async function checkMemoryEmbeddings(embed: BenchmarkEmbedder) {
  const start = performance.now()
  const passages = await encodeAll(embed, facts.map(fact => fact.text), 'passage')
  const passagesMs = performance.now() - start
  const timings: number[] = []
  const cases: RankedCase[] = []
  for (const query of queries) {
    const started = performance.now()
    const [vector] = await encodeAll(embed, [query.text], 'query')
    timings.push(performance.now() - started)
    const ranking = passages.map((passage, index) => ({ id: facts[index].id, score: similarity(vector, passage) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    const [best, next] = ranking
    cases.push({ ...query, top: ranking.slice(0, 5), bestScore: best.score, margin: best.score - next.score })
  }
  const answer = cases.filter(query => query.kind === 'answer')
  const ambiguous = cases.filter(query => query.kind === 'ambiguous')
  const absent = cases.filter(query => query.kind === 'absent')
  const calibration = [0.72, 0.75, 0.78, 0.8, 0.82, 0.85].flatMap(threshold => [0, 0.015, 0.025, 0.04].map(gap => {
    const qualifies = (item: RankedCase) => item.bestScore >= threshold && item.margin >= gap
    return { threshold, gap,
      correctTop: answer.filter(query => qualifies(query) && query.relevant.includes(query.top[0].id)).length,
      wrongTop: answer.filter(query => qualifies(query) && !query.relevant.includes(query.top[0].id)).length,
      acceptedAmbiguous: ambiguous.filter(qualifies).length,
      acceptedAbsent: absent.filter(qualifies).length }
  }))
  return {
    count: { answers: answer.length, ambiguous: ambiguous.length, absent: absent.length },
    recall: {
      vectorTop1: answer.filter(query => inTop(query.relevant, [query.top[0].id])).length,
      vectorTop5: answer.filter(query => inTop(query.relevant, query.top.map(hit => hit.id))).length,
      ambiguousAllTop5: ambiguous.filter(query => query.relevant.every(id => query.top.some(hit => hit.id === id))).length,
    },
    timings: { passagesMs, query: timingsOf(timings) },
    calibration, cases,
  }
}

type RecallPacket = {
  status: string, partial: boolean, reasons: string[], memories: { id: number, text: string, match?: 'semantic' }[],
}
type RuntimeQuery = { hits: string[], semantic: string[], partial: boolean, reasons: string[], elapsedMs: number }
type RuntimeCase = Query & { automatic: { hits: string[], elapsedMs: number }, keyword: RuntimeQuery, semantic: RuntimeQuery }

async function checkRuntime(embedder: MemoryEmbedder) {
  const store = openMemoryStore(':memory:')
  const origin = { conversation: 'bench-conversation', session: 'bench-session' }
  const allowed: MemoryScope = { kind: 'project', id: 'bench-allowed' }
  const privateScope: MemoryScope = { kind: 'project', id: 'bench-private' }
  const projectFacts = [
    { scope: allowed, id: 'allowed-escrow', text: 'ORCHID-19 的托管密钥应提交给丽莎保管。' },
    { scope: privateScope, id: 'private-escrow', text: 'ORCHID-19 的托管密钥只交给黑桦项目的专员。' },
  ]
  const memory = createMemoryRuntime({
    store, embedder, maintainSemanticIndex: true, route: () => ({ provider: 'offline-fixture', model: 'source-echo' }),
    compute: job => {
      if (job.stage !== 'extract') return null
      const { user } = JSON.parse(job.input) as { user: string }
      return Promise.resolve(JSON.stringify({ proposals: [{
        spans: [{ start: 0, end: user.length }], kind: 'fact', scope: 'project', modality: 'asserted', attribution: 'self', keywords: [],
      }] }))
    },
    quiesce: async () => {}, changed: () => {},
  })
  const byId = new Map<number, string>()
  async function query(text: string, layer: 'keyword' | 'semantic', scope?: MemoryScope, deep = false): Promise<RuntimeQuery> {
    const request: MemoryRequest = { op: 'recall', query: text, session: origin.session, deep }
    const started = performance.now()
    const scoped = { ...origin, scope }
    const raw = layer === 'keyword' ? memory.handle(request, scoped) : await memory.handleModelRequest(request, scoped, () => true)
    const elapsedMs = performance.now() - started
    const packet = JSON.parse(raw) as RecallPacket
    assert.equal(packet.status, 'ok')
    return { hits: packet.memories.map(entry => byId.get(entry.id) ?? String(entry.id)),
      semantic: packet.memories.filter(entry => entry.match === 'semantic').map(entry => byId.get(entry.id) ?? String(entry.id)),
      partial: packet.partial, reasons: packet.reasons, elapsedMs }
  }
  try {
    for (const fact of facts) {
      const row = memory.addMemory(fact.text)
      assert.ok(row, 'benchmark fact must be accepted')
      byId.set(row.id, fact.id)
    }
    for (const fact of projectFacts) {
      memory.accept(fact.text, { ...origin, scope: fact.scope })
      await memory.wake()
      const row = store.listForScope(fact.scope).find(entry => entry.text === fact.text)
      assert.ok(row, 'project-scoped benchmark fact must be accepted')
      byId.set(row.id, fact.id)
    }
    // Warm real persisted passages through a normal rebuild before measuring hot queries.
    // The benchmark fixtures fit a handful of idle batches. A deadline prevents hidden skips.
    assert.equal(memory.rebuildIndexes().semantic, true)
    const deadline = performance.now() + 5000
    const indexed = store.db.prepare('SELECT count(*) AS count FROM memory_semantic_vectors')
    while (Number(indexed.get()?.count) < byId.size && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(indexed.get()?.count, byId.size, 'the derived index must cover the warm fixture')
    const cases: RuntimeCase[] = []
    for (const item of queries) {
      const started = performance.now()
      const context = memory.handle({ op: 'context', session: origin.session, turn: 1, question: item.text }, origin)
      const automatic = { hits: facts.filter(fact => context.includes(fact.text)).map(fact => fact.id), elapsedMs: performance.now() - started }
      cases.push({ ...item, automatic, keyword: await query(item.text, 'keyword'), semantic: await query(item.text, 'semantic') })
    }
    const scopeCases = []
    for (const [label, scope, expected] of [['global', undefined, []], ['allowed', allowed, ['allowed-escrow']],
      ['private', privateScope, ['private-escrow']]] as const) {
      const results = await query('Where do I submit ORCHID-19 escrow credentials?', 'semantic', scope, true)
      assert.deepEqual(results.hits, expected, `semantic search must respect ${label} scope`)
      scopeCases.push({ scope: label, expected, ...results })
    }
    function metrics(layer: 'automatic' | 'keyword' | 'semantic') {
      const answer = cases.filter(item => item.kind === 'answer')
      const absent = cases.filter(item => item.kind === 'absent')
      const ambiguous = cases.filter(item => item.kind === 'ambiguous')
      return {
        top1: answer.filter(item => inTop(item.relevant, item[layer].hits.slice(0, 1))).length,
        anyHit: answer.filter(item => inTop(item.relevant, item[layer].hits)).length,
        ambiguousAll: ambiguous.filter(item => item.relevant.every(id => item[layer].hits.includes(id))).length,
        absentWithCandidates: absent.filter(item => item[layer].hits.length > 0).length,
        absentWithNoCandidates: absent.filter(item => item[layer].hits.length === 0).length,
        timings: timingsOf(cases.map(item => item[layer].elapsedMs)),
      }
    }
    return { automatic: metrics('automatic'), keyword: metrics('keyword'), semantic: metrics('semantic'), scopeCases, cases }
  } finally {
    memory.close()
  }
}

const [modelRoot, runtimeRoot] = process.argv.slice(2)
if (!modelRoot) throw new Error('Usage: node scripts/memory-embedding-check.ts <model-dir> [runtime-dir]')

const embedder = createMemoryEmbedder({ modelRoot, runtimeRoot })
try {
  const started = performance.now()
  const warmup = await embedder.embedBatch([{ kind: 'query', text: 'Viva' }])
  assert.ok(warmup?.[0], 'the local E5 worker must encode successfully')
  const workerStartupMs = performance.now() - started
  const result = await checkMemoryEmbeddings(async (texts, kind) => {
    const vectors = await embedder.embedBatch(texts.map(text => ({ kind, text })))
    assert.ok(vectors, `the local E5 worker rejected the ${kind} batch`)
    return vectors.map(vector => {
      assert.ok(vector, 'the benchmark text must fit the model token budget')
      return vector
    })
  })
  const runtime = await checkRuntime(embedder)
  console.log(JSON.stringify({ model: embedder.fingerprint, workerStartupMs, rawCalibration: result, runtime }, null, 2))
} finally {
  embedder.close()
}
