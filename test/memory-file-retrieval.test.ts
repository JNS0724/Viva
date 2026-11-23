import { RequestTimeout } from '../src/shared/request-budget.ts'
import assert from 'node:assert/strict'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { createMemoryFileRetrieval, memoryFileChunkKey, memoryFileLexicalQuery, fuseMemoryFileHits } from '../src/memory/core/memory-file-retrieval.ts'
import type { MemoryDocumentView } from '../src/memory/core/memory-document-read-policy.ts'
import type { MemoryEmbedder, MemoryEmbeddingInput } from '../src/memory/contracts/embedding.ts'
import type { MemoryFileHit } from '../src/memory/core/ports/file-index.ts'
import type { DiagnosticEvent, DiagnosticPort } from '../src/diagnostics/contracts.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const workspace = hash('workspace')
const allows = () => true
function view(id: string, text: string, extra: Partial<MemoryDocumentView> = {}): MemoryDocumentView {
  const markdown = `---\nname: ${id}\ndescription: ${id} description\n---\n${text}`
  return { id, workspace, path:`digest/wiki/${id}.md`,kind:'digest',revision:hash(markdown),usageVersion:1,
    policyToken:hash(markdown),updatedAt:1,markdown,sources:[],sourceTokens:[{id:`source-${id}`,token:'v1'}],
    backing:null,...extra }
}
function setup(t: test.TestContext, initial: MemoryDocumentView[], embedder?: MemoryEmbedder, diagnostics?: DiagnosticPort, { sync = true }: { sync?: boolean } = {}) {
  const db=new DatabaseSync(':memory:')
  const index=openMemoryFileIndex({db})
  const views=new Map(initial.map(item=>[item.id,item]))
  const policy={read: (scope:string,path:string)=>[...views.values()].find(item=>item.workspace===scope && item.path===path) ?? null,
    list: (scope:string)=>[...views.values()].filter(item=>item.workspace===scope)}
  const retrieval=createMemoryFileRetrieval({index,policy,workspaces:()=>[workspace],hash,embedder,diagnostics})
  if (sync) retrieval.sync()
  t.after(()=>{retrieval.close();db.close()})
  return {db,index,views,policy,retrieval}
}
function unit(first: number) {const vector=new Float32Array(384);vector[first]=1;return vector}
function encoder() {
  const calls: MemoryEmbeddingInput[][]=[]
  const embedder: MemoryEmbedder={dimensions:384,fingerprint:'test-space',close(){},async embedBatch(inputs){calls.push([...inputs]);return inputs.map(item=>unit(item.text.includes('needle')?0:1))}}
  return {embedder,calls}
}

test('automatic context returns lexical evidence before cold passage encoding and gates weak hot candidates', async t => {
  let unblock!: () => void, complete!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const published = new Promise<void>(resolve => { complete = resolve })
  const { embedder, calls } = encoder()
  const run = embedder.embedBatch
  embedder.embedBatch = async (inputs, signal) => {
    if (inputs[0]?.kind === 'passage') await gate
    if (inputs[0]?.kind === 'query' && inputs[0].text === '今天天气怎么样') return [unit(1)]
    return run(inputs, signal)
  }
  const { retrieval, index } = setup(t, [view('weekly', '今天已提交周报 needle')], embedder)
  t.after(unblock)
  const finish = index.finishVectors
  index.finishVectors = (...args) => { const result = finish(...args); complete(); return result }
  const search = (query: string) => retrieval.search({ query, limit: 1, automatic: true, allows })
  const cold = await search('周报')
  assert.equal(cold.hits.length, 1)
  assert.equal(retrieval.searchCached({ query: '帮我写周报', automatic: true, allows }).hits[0]?.id, 'weekly')
  assert.equal(calls.length, 0)
  unblock()
  // A referenced turn lets the deferred index preparation run in the test process.
  await new Promise(resolve => setTimeout(resolve, 0))
  await published
  assert.equal(index.vectorState().active, true)
  const unrelated = await search('今天天气怎么样')
  assert.equal(unrelated.status, 'empty')
  assert.deepEqual(unrelated.files, [])
  assert.deepEqual(unrelated.sourceIds, [])
  const strong = await search('needle-equivalent')
  assert.equal(strong.hits[0]?.id, 'weekly')
})

test('explicit recall returns lexical results without starting a cold embedding job', async t => {
  const { embedder, calls } = encoder()
  const { retrieval } = setup(t, [view('weekly', 'weekly report')], embedder)
  const result = await retrieval.search({ query: 'weekly report', allows })
  assert.deepEqual(result.hits.map(hit => hit.id), ['weekly'])
  assert.ok(result.partial)
  assert.ok(result.reasons.includes('semantic-index-incomplete'))
  assert.equal(calls.length, 0)
})

for (const mode of [{ automatic: true }, {}]) test(
  `slow query falls back to lexical evidence for ${Object.keys(mode)[0] ?? 'explicit'} reads`, async t => {
  const { embedder } = encoder()
  const run = embedder.embedBatch
  let finish!: () => void, querySignal: AbortSignal | undefined
  const gate = new Promise<void>(resolve => { finish = resolve })
  embedder.embedBatch = async (inputs, signal) => {
    if (inputs[0]?.kind === 'query') { querySignal = signal; await gate }
    return run(inputs, signal)
  }
  const { retrieval } = setup(t, [view('a', 'needle'), view('b', 'other')], embedder)
  assert.ok(await retrieval.prepareVectors())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = retrieval.search({ query: 'needle', ...mode, allows })
    assert.ok(querySignal)
    t.mock.timers.tick(DAILY_MEMORY_DEFAULTS.automaticQueryTimeoutMs)
    const result = await pending
    assert.deepEqual(result.hits.map(hit => hit.id), ['a'])
    assert.equal(querySignal.aborted, false)
    assert.ok(result.reasons.includes('semantic-unavailable'))
  } finally { finish() }
})

test('a new file in a hot index is embedded after the timed-out query releases the single worker', async t => {
  const { embedder } = encoder()
  const run = embedder.embedBatch
  let release!: () => void, busy = false, collisions = 0
  const query = new Promise<void>(resolve => { release = resolve })
  embedder.embedBatch = async (inputs, signal) => {
    if (busy) { collisions++; return null }
    busy = true
    try {
      if (inputs[0]?.kind === 'query') await query
      return await run(inputs, signal)
    } finally { busy = false }
  }
  const { retrieval, views, index } = setup(t, [view('old', 'old note')], embedder)
  assert.ok(await retrieval.prepareVectors())
  views.set('new', view('new', 'needle'))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    retrieval.sync()
    const pending = retrieval.search({ automatic: true, query: 'needle', allows })
    t.mock.timers.tick(DAILY_MEMORY_DEFAULTS.automaticQueryTimeoutMs)
    assert.equal((await pending).hits[0]?.id, 'new')
    assert.equal(collisions, 0)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    t.mock.timers.tick(1)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(index.missingVectors(index.vectorState().generation), [])
  } finally { release() }
})

test('retrieval diagnostics identify lexical, vector and fusion without copying query or evidence', async t => {
  const events: DiagnosticEvent[] = []
  const model = encoder()
  const f = setup(t, [view('private-document', 'needle PRIVATE_BODY_CANARY')], model.embedder,
    recordingDiagnosticPort(event => { events.push(event); return undefined }))
  assert.ok(await f.retrieval.prepareVectors())
  const result = await f.retrieval.search({ query: 'needle PRIVATE_QUERY_CANARY', allows })
  assert.ok(result.hits.length)
  assert.deepEqual(events.filter(event => event.event === 'operation.progress' && event.operation === 'memory.recall').map(event => event.stage), ['lexical', 'vector', 'fusion'])
  assert.ok(events.some(event => event.operation === 'memory.index' && event.stage === 'checkpoint' && event.metrics?.ok === true))
  assert.equal(events.at(-1)?.outcome, 'completed')
  assert.equal(events.at(-1)?.metrics?.count, result.hits.length)
  assert.equal(JSON.stringify(events).includes('PRIVATE_'), false)
  f.retrieval.read({ id: 'private-document', allows })
  f.retrieval.nodeSearch({ query: 'PRIVATE_NODE_QUERY', allows })
  f.retrieval.reindex()
  assert.ok(events.some(event => event.operation === 'memory.index' && event.stage === 'rebuild'))
  assert.equal(JSON.stringify(events).includes('PRIVATE_'), false)
  const error = new Error('PRIVATE_ERROR_CANARY')
  await assert.rejects(f.retrieval.search({ query: 'needle', allows() { throw error } }), value => value === error)
  assert.equal(events.at(-1)?.outcome, 'failed')
  assert.equal(JSON.stringify(events).includes('PRIVATE_'), false)
})

test('a failed retrieval observer preserves synchronous cached and asynchronous search behavior', async t => {
  const f = setup(t, [view('document', 'needle')], undefined, { emit() { throw new Error('observer failed') } })
  assert.equal(f.retrieval.searchCached({ query: 'needle', allows }).hits.length, 1)
  assert.equal((await f.retrieval.search({ query: 'needle', allows })).hits.length, 1)
  assert.equal(f.retrieval.read({ id: 'document', allows })?.id, 'document')
  assert.equal(f.retrieval.nodeSearch({ query: 'document', allows }).nodes.length, 1)
  f.retrieval.reindex()
  const controller = new AbortController(); controller.abort()
  assert.equal((await f.retrieval.search({ query: 'needle', allows, signal: controller.signal })).status, 'unavailable')
})

test('file search covers daily and digest with complete source lines and filters scope before quota', async t=>{
  const initial=Array.from({length:30},(_,i)=>view(`hidden-${i}`,'needle needle needle'))
  const daily=view('daily','needle in a daily note',{kind:'daily',day:'2026-11-10',path:'daily/2026-11-10/a.md'})
  const digest=view('digest','needle in an undated digest')
  const {retrieval}=setup(t,[...initial,daily,digest])
  const result=await retrieval.search({query:'needle',limit:1,allows:item=>!item.id.startsWith('hidden')})
  assert.equal(result.status,'ok');assert.equal(result.hits.length,1)
  assert.ok(['daily','digest'].includes(result.hits[0]!.id))
  assert.equal(result.hits[0]!.startLine,5)
  const dated=await retrieval.search({query:'needle',from:'2026-11-11',through:'2026-11-12',allows:item=>!item.id.startsWith('hidden')})
  assert.deepEqual(dated.hits.map(hit=>hit.id),['digest'])
  assert.deepEqual(dated.sourceIds,['source-digest'])
  assert.equal(dated.files[0]!.policyToken,digest.policyToken)
})

test('context dedup distinguishes empty and exhausted and invalidates on query, turn and revision', async t=>{
  const a=view('a','needle'), b=view('b','needle')
  const {retrieval,views}=setup(t,[a,b])
  const request={query:'needle',allows,contextKey:'session-turn'}
  assert.equal((await retrieval.search(request)).hits.length,2)
  assert.equal((await retrieval.search(request)).status,'exhausted')
  assert.equal((await retrieval.search({...request,query:'missing'})).status,'empty')
  views.set('a',{...a,policyToken:'new-state',usageVersion:2})
  retrieval.sync()
  assert.deepEqual((await retrieval.search(request)).hits.map(hit=>hit.id),['a'])
  assert.equal((await retrieval.search({...request,contextKey:'next-turn'})).hits.length,2)
  assert.equal((await retrieval.search({query:'needle',allows})).hits.length,2)
})

test('reindex uses accepted snapshots without rereading newly edited domain documents', t=>{
  const a=view('a','accepted needle')
  const {retrieval,index,views}=setup(t,[a])
  views.set('a',view('a','unaccepted external edit'))
  const result=retrieval.reindex();assert.equal(result.lexical,true)
  assert.ok(index.chunks(index.files([workspace]))[0]!.text.includes('accepted needle'))
  assert.equal(index.lexicalCandidates('needle',{workspaces:[workspace]},5).rows.length,1)
  retrieval.sync();assert.ok(index.chunks(index.files([workspace]))[0]!.text.includes('external edit'))
  views.delete('a');retrieval.sync();assert.equal(index.files([workspace]).length,0)
})

test('local multi-passage vectors persist and hot search only embeds its query', async t=>{
  const {embedder,calls}=encoder()
  const {retrieval,index}=setup(t,[view('long','needle '+('word '.repeat(1000)))],embedder)
  assert.equal(await retrieval.prepareVectors(),true)
  const first=await retrieval.search({query:'needle',allows})
  assert.equal(first.status,'ok');assert.equal(index.vectorState().active,true)
  assert.ok(calls.flat().filter(input=>input.kind==='passage').length>1)
  const count=calls.flat().filter(input=>input.kind==='passage').length
  await retrieval.search({query:'needle',allows})
  assert.equal(calls.flat().filter(input=>input.kind==='passage').length,count)
  assert.equal(calls.flat().filter(input=>input.kind==='query').length,2)
})

test('vector space changes disable the old space until all new passages finish', async t=>{
  const {embedder}=encoder();const {retrieval,index}=setup(t,[view('a','needle')],embedder)
  assert.equal(await retrieval.prepareVectors(),true)
  assert.equal(index.vectorState().active,true)
  let observedDisabled=false
  const second:MemoryEmbedder={dimensions:384,fingerprint:'changed-space',close(){},async embedBatch(inputs){observedDisabled ||= !index.vectorState().active;return inputs.map(()=>unit(0))}}
  const other=createMemoryFileRetrieval({index,policy:{read:()=>view('a','needle'),list:()=>[view('a','needle')]},workspaces:()=>[workspace],hash,embedder:second})
  t.after(()=>other.close())
  assert.equal(await other.prepareVectors(),true)
  await other.search({query:'needle',allows})
  assert.equal(observedDisabled,true);assert.match(index.vectorState().space!.fingerprint,/changed-space/u)
})

test('source changes while encoding reject late vectors and return no stale result', async t=>{
  let entered:()=>void=()=>{},finish:()=>void=()=>{}
  const ready=new Promise<void>(resolve=>{entered=resolve})
  const gate=new Promise<void>(resolve=>{finish=resolve})
  let calls = 0
  const embedder:MemoryEmbedder={dimensions:384,fingerprint:'slow',close(){},async embedBatch(inputs){calls++;entered();await gate;return inputs.map(()=>unit(0))}}
  const a=view('a','needle '+ 'x'.repeat(9950)),{retrieval,views,index}=setup(t,[a],embedder)
  const pending=retrieval.prepareVectors();await ready
  views.delete('a');retrieval.sync();finish()
  assert.equal(await pending,false)
  assert.equal((await retrieval.search({query:'needle',allows})).status,'empty')
  assert.equal(index.vectorState().active,false)
  assert.equal(index.missingVectors(index.vectorState().generation).length,0)
  assert.equal(calls,1, 'a revoked source must not enter another passage batch')
})

test('broken or unavailable embeddings degrade to full text without claiming a semantic hit', async t=>{
  const embedder:MemoryEmbedder={dimensions:384,fingerprint:'broken',close(){},async embedBatch(){return null}}
  const {retrieval}=setup(t,[view('a','needle')],embedder)
  assert.equal(await retrieval.prepareVectors(),false)
  const result=await retrieval.search({query:'needle',allows})
  assert.equal(result.status,'ok');assert.deepEqual(result.hits.map(hit=>hit.id),['a'])
  assert.ok(result.reasons.includes('semantic-index-incomplete'))
})

test('RRF uses fixed single-lane rank scores and removes generic function words only from lexical queries', ()=>{
  const fake=(id:string,score:number)=>({ref:{workspace,fileId:id,ordinal:0,revision:'v',usageVersion:1,policyToken:'p'},score} as MemoryFileHit)
  const lexical=[fake('a',4)], vector=[fake('b',0.9),fake('a',0.8)]
  assert.ok(Math.abs(fuseMemoryFileHits(lexical,[])[0]!.score-0.3/61)<1e-15)
  assert.equal(fuseMemoryFileHits([],vector)[0]!.score,0.7/61)
  assert.equal(fuseMemoryFileHits(lexical,vector)[0]!.ref.fileId,'a')
  assert.equal(memoryFileLexicalQuery('Who receives the weekly summary?').includes('the'),false)
  assert.equal(memoryFileLexicalQuery('TEAM-42 团队 每周'),'TEAM-42 团队 每周')
  assert.equal(memoryFileLexicalQuery('A-42 plug-in a.b user@a 中文and词'),'A-42 plug-in a.b user@a 中文and词')
})

test('file service applies shared diverse selection after context dedup and uses rank-score thresholds on fallback', t => {
  const long = view('long', '# First\nneedle one\n# Second\nneedle two\n# Third\nneedle three\n')
  const { retrieval, index } = setup(t, [long, view('other', 'needle other'), view('third', 'needle third')])
  const chunks = index.chunks(index.files([workspace]))
  const longChunks = chunks.filter(chunk => chunk.file.id === 'long')
  assert.equal(longChunks.length, 3)
  const others = chunks.filter(chunk => chunk.file.id !== 'long').sort((a,b)=>a.file.id.localeCompare(b.file.id))
  index.lexicalCandidates = () => ({ rows: [...longChunks, ...others].map((chunk,index)=>({ ...chunk, score: 100-index })), incomplete: false, mode: 'fts' })
  const first = retrieval.searchCached({ query: 'needle', limit: 2, contextKey: 'same-question', allows })
  assert.deepEqual(first.hits.map(item=>item.id), ['long', 'other'])
  assert.ok(Math.abs(first.hits[0]!.score-0.3/61)<1e-15)
  const next = retrieval.searchCached({ query: 'needle', limit: 2, contextKey: 'same-question', allows })
  assert.deepEqual(next.hits.map(item=>item.id), ['long', 'third'])
  assert.notEqual(next.hits[0]!.startLine, first.hits[0]!.startLine)
  assert.equal(retrieval.searchCached({ query: 'needle', limit: 2, minScore: 0.01, allows }).status, 'empty')
})


test('cancelled worker waits terminate even if an encoder ignores its abort signal', async t => {
  let entered: () => void = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  const embedder: MemoryEmbedder = { dimensions: 384, fingerprint: 'ignores-cancel', close() {}, embedBatch() { entered(); return new Promise(() => {}) } }
  const { retrieval, index } = setup(t, [view('a', 'needle')], embedder)
  const controller = new AbortController()
  const pending = retrieval.prepareVectors(controller.signal)
  await started
  controller.abort()
  assert.equal(await pending, false)
  assert.equal(index.vectorState().active, false)
})

test('corrupt cached vectors trigger rebuild and failed repair falls back with an explicit reason', async t => {
  const original = encoder()
  let unavailable = false
  const embedder: MemoryEmbedder = { dimensions: 384, fingerprint: original.embedder.fingerprint, close() {},
    embedBatch: (inputs, signal) => unavailable ? Promise.resolve(null) : original.embedder.embedBatch(inputs, signal) }
  const { retrieval, db } = setup(t, [view('a', 'needle')], embedder)
  assert.equal(await retrieval.prepareVectors(), true)
  db.exec("UPDATE memory_file_index_vectors SET vector = x'01'")
  unavailable = true
  assert.equal(await retrieval.prepareVectors(), false)
  const result = await retrieval.search({ query: 'needle', allows })
  assert.equal(result.status, 'ok')
  assert.ok(result.reasons.includes('semantic-index-incomplete'))
})

test('read range validation and request date bounds are explicit', async t => {
  const { retrieval } = setup(t, [view('a', 'line one\nline two')])
  assert.equal(retrieval.read({ id: 'a', startLine: 5, endLine: 5, allows })!.text, 'line one')
  assert.equal(retrieval.read({ id: 'a', startLine: 99, allows }), null)
  assert.throws(() => retrieval.read({ id: 'a', startLine: 2, endLine: 1, allows }), /invalid-memory-line-range/u)
  await assert.rejects(retrieval.search({ query: 'needle', from: '2026-02-30', allows }), /invalid-memory-file-date/u)
  await assert.rejects(retrieval.search({ query: 'needle', limit: NaN, allows }), /invalid-memory-file-limit/u)
  assert.throws(() => retrieval.nodeSearch({ query: 'x', limit: 0, allows }), /invalid-memory-file-limit/u)
})


test('synchronous recall shares filtering and readsets and declares that semantic encoding was not run', async t => {
  const { embedder, calls } = encoder()
  const a = view('a', 'needle'), hidden = view('hidden', 'needle needle needle')
  const { retrieval } = setup(t, [a, hidden], embedder)
  const request = { query: 'needle', allows: (item: MemoryDocumentView) => item.id === 'a' }
  const cached = retrieval.searchCached(request)
  assert.deepEqual(cached.hits.map(hit => hit.id), ['a'])
  assert.ok(cached.reasons.includes('semantic-not-run'))
  assert.equal(calls.length, 0)
  const full = await retrieval.search(request)
  assert.deepEqual(cached.files, full.files)
  assert.deepEqual(cached.sourceIds, full.sourceIds)
})


test('search line ranges round-trip through read for LF, CRLF and lone CR', async t => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const markdown = ['---', 'name: title', 'description: desc', '---', 'first', 'needle'].join(newline)
    const document = view(`line-${newline.length}-${newline.charCodeAt(0)}`, '', { markdown, revision: hash(markdown), policyToken: hash(markdown) })
    const { retrieval } = setup(t, [document])
    const result = await retrieval.search({ query: 'needle', allows })
    const hit = result.hits[0]!
    assert.equal(hit.startLine, 5)
    assert.equal(hit.endLine, 6)
    assert.equal(retrieval.read({ id: hit.id, startLine: hit.startLine, endLine: hit.endLine, allows })!.text, hit.text)
    assert.equal(retrieval.read({ id: hit.id, startLine: 6, endLine: 6, allows })!.text, 'needle')
  }
})


test('indexedScores returns every authorized persisted chunk without encoding or a hardcoded candidate cap', async t => {
  const { embedder, calls } = encoder()
  const documents = Array.from({ length: 30 }, (_, i) => view(`file-${i}`, 'needle'))
  const { retrieval, index, views } = setup(t, documents, embedder)
  retrieval.sync()
  assert.equal(await retrieval.prepareVectors(), true)
  const allowed = index.files([workspace])
  const expected = index.chunks(allowed)
  const callCount = calls.length
  const scores = retrieval.indexedScores(unit(0), allowed)
  assert.equal(scores.size, 30)
  for (const chunk of expected) assert.equal(scores.get(memoryFileChunkKey(chunk.ref)), 1)
  assert.equal(calls.length, callCount)
  assert.equal(retrieval.indexedScores(unit(0), allowed.slice(0, 1)).size, 1)
  const changed = allowed[0]!
  const before = views.get(changed.id)!
  views.set(changed.id, { ...before, policyToken: 'revoked-state' })
  assert.equal(retrieval.indexedScores(unit(0), [changed]).size, 0)
})

test('indexedScores never enables missing, rebuilt or foreign vector spaces', async t => {
  const { embedder } = encoder()
  const { retrieval, index } = setup(t, [view('a', 'needle')], embedder)
  retrieval.sync()
  const allowed = index.files([workspace])
  assert.equal(retrieval.indexedScores(unit(0), allowed).size, 0)
  assert.equal(await retrieval.prepareVectors(), true)
  assert.equal(retrieval.indexedScores(unit(0), allowed).size, 1)
  retrieval.reindex()
  assert.equal(retrieval.indexedScores(unit(0), allowed).size, 0)
  assert.equal(await retrieval.prepareVectors(), true)
  index.beginVectors({ fingerprint: 'foreign-space', dimensions: 384 })
  const foreign = index.vectorState()
  assert.equal(retrieval.indexedScores(unit(0), allowed).size, 0)
  assert.deepEqual(index.vectorState(), foreign)
})


test('output budget omits an oversized hit without consuming its context result', t => {
  const { retrieval } = setup(t, [view('a', 'needle '.repeat(1100))])
  const request = { query: 'needle', allows, contextKey: 'budget-context', maxChars: 800 }
  const small = retrieval.searchCached(request)
  const publicJson = ({ files: _files, sourceIds: _sources, ...result }: typeof small) => JSON.stringify(result)
  assert.ok(publicJson(small).length <= request.maxChars)
  assert.equal(small.status, 'ok')
  assert.equal(small.hits.length, 0)
  assert.equal(small.partial, true)
  assert.ok(small.reasons.includes('output-budget'))
  const full = retrieval.searchCached({ ...request, maxChars: 12_000 })
  assert.ok(full.hits[0]!.text.includes('needle'))
  assert.equal(retrieval.searchCached({ ...request, maxChars: 12_000 }).status, 'exhausted')
})

test('output budget skips an oversized leading hit to deliver shorter matches and preserves retry behavior', t => {
  const oversized = view('oversized', 'needle '.repeat(1100))
  const concise = view('concise', 'needle on one line')
  const { retrieval } = setup(t, [oversized, concise])
  assert.deepEqual(retrieval.searchCached({ query: 'needle', allows }).hits.map(hit => hit.id), ['oversized', 'concise'])
  const request = { query: 'needle', allows, contextKey: 'mixed-budget-context', maxChars: 5872 }
  const first = retrieval.searchCached(request)
  const publicJson = ({ files: _files, sourceIds: _sources, ...result }: typeof first) => JSON.stringify(result)
  assert.ok(publicJson(first).length <= request.maxChars)
  assert.equal(first.status, 'ok')
  assert.deepEqual(first.hits.map(hit => hit.id), ['concise'])
  assert.equal(first.partial, true)
  assert.ok(first.reasons.includes('output-budget'))

  const retrySameBudget = retrieval.searchCached(request)
  assert.equal(retrySameBudget.status, 'ok')
  assert.deepEqual(retrySameBudget.hits, [])
  assert.equal(retrySameBudget.partial, true)
  assert.ok(retrySameBudget.reasons.includes('output-budget'))

  const retryLargerBudget = retrieval.searchCached({ ...request, maxChars: 12_000 })
  assert.equal(retryLargerBudget.status, 'ok')
  assert.deepEqual(retryLargerBudget.hits.map(hit => hit.id), ['oversized'])
  assert.equal(retrieval.searchCached({ ...request, maxChars: 12_000 }).status, 'exhausted')
})

test('budget includes escaped JSON and marks only complete hits seen', t => {
  const root = view('a', 'needle "with escapes" '.repeat(25))
  const { retrieval } = setup(t, [root])
  const result = retrieval.searchCached({ query: 'needle', allows, maxChars: 400, contextKey: 'escaped-budget' })
  const { files: _files, sourceIds: _sources, ...publicResult } = result
  assert.ok(JSON.stringify(publicResult).length <= 400)
  assert.ok(result.reasons.includes('output-budget'))
  assert.equal(result.hits.length, 0)
  assert.equal(retrieval.searchCached({ query: 'needle', allows, maxChars: 20_000, contextKey: 'escaped-budget' }).hits.length, 1)
  assert.throws(() => retrieval.searchCached({ query: 'needle', allows, maxChars: 10 }), /invalid-memory-file-output-budget/u)
})

test('file vector space follows adapter-declared dimensions and invalidates a changed width even with the same model fingerprint', async t => {
  const model = (dimensions: number): MemoryEmbedder => ({ fingerprint: 'alternate-model', dimensions, close() {},
    async embedBatch(inputs) { return inputs.map(() => { const vector = new Float32Array(dimensions); vector[0] = 1; return vector }) } })
  const { retrieval, index, policy } = setup(t, [view('small', 'needle')], model(2))
  assert.equal(await retrieval.prepareVectors(), true)
  const first = await retrieval.search({ query: 'needle', allows })
  assert.equal(first.status, 'ok')
  assert.equal(index.vectorState().space?.dimensions, 2)
  assert.equal(index.vectorState().active, true)
  const oldGeneration = index.vectorState().generation
  const next = createMemoryFileRetrieval({ index, policy, workspaces: () => [workspace], hash, embedder: model(3) })
  t.after(() => next.close())
  next.sync()
  assert.equal(await next.prepareVectors(), true)
  await next.search({ query: 'needle', allows })
  assert.equal(index.vectorState().space?.dimensions, 3)
  assert.ok(index.vectorState().generation > oldGeneration)
  assert.equal(index.vectorState().active, true)
  assert.equal(index.stageVectors(oldGeneration, []), 0)
})

for (const invalidKind of ['passage', 'query'] as const) test(`an adapter returning the wrong ${invalidKind} width degrades explicitly without accepting incompatible vectors`, async t => {
  const embedder: MemoryEmbedder = { fingerprint: `invalid-${invalidKind}`, dimensions: 2, close() {},
    async embedBatch(inputs) { return inputs.map(input => Float32Array.from(input.kind === invalidKind ? [1, 0, 0] : [1, 0])) } }
  const { retrieval, index } = setup(t, [view('safe', 'needle')], embedder)
  assert.equal(await retrieval.prepareVectors(), invalidKind !== 'passage')
  const result = await retrieval.search({ query: 'needle', allows })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.hits.map(hit => hit.id), ['safe'])
  assert.ok(result.reasons.includes(invalidKind === 'passage' ? 'semantic-index-incomplete' : 'semantic-unavailable'))
  assert.equal(index.vectorState().space?.dimensions, 2)
  if (invalidKind === 'passage') assert.equal(index.vectorState().active, false)
})


test('persistent passage preparation retains safe titles and headings through tokenizer overflow retries', async t => {
  const inputs: string[] = []
  const embedder: MemoryEmbedder = { fingerprint: 'token-budget', dimensions: 384, close() {}, async embedBatch(batch) {
    return batch.map(input => {
      if (input.kind === 'query') return unit(0)
      inputs.push(input.text)
      return input.text.length > 180 ? null : unit(0)
    })
  } }
  const document = view('Context title', '# Only in staging\n\n' + 'Background recording. '.repeat(80) + 'needle at the tail')
  const { retrieval, index } = setup(t, [document], embedder)
  assert.equal(await retrieval.prepareVectors(), true)
  const result = await retrieval.search({ query: 'needle', allows })
  assert.equal(result.status, 'ok')
  assert.equal(index.vectorState().active, true)
  assert.ok(inputs.some(text => text.length > 180))
  assert.ok(inputs.every(text => text.startsWith('Context title\nOnly in staging\n\n')))
  assert.ok(inputs.some(text => text.length <= 180 && text.includes('needle at the tail')))
})

test('a tokenizer that cannot fit the contextual prefix degrades without encoding an unqualified body', async t => {
  const inputs: string[] = []
  const name = 'Required context '.repeat(20)
  const embedder: MemoryEmbedder = { fingerprint: 'context-too-long', dimensions: 384, close() {}, async embedBatch(batch) {
    return batch.map(input => { if (input.kind === 'passage') inputs.push(input.text); return input.text.length > 150 ? null : unit(0) })
  } }
  const { retrieval, index } = setup(t, [view(name, 'needle')], embedder)
  assert.equal(await retrieval.prepareVectors(), false)
  const result = await retrieval.search({ query: 'needle', allows })
  assert.equal(result.status, 'ok')
  assert.ok(result.reasons.includes('semantic-index-incomplete'))
  assert.equal(index.vectorState().active, false)
  assert.ok(inputs.every(text => text.startsWith(name.trim() + '\n\n')))
  assert.ok(inputs.length < 20)
})

test('published search skips failed and stale candidates beside an independent matching file', async t => {
  const stale = view('stale', 'needle needle needle')
  const stopped = view('stopped', 'needle needle needle')
  const target = view('target', 'needle in a current file')
  const unrelated = Array.from({ length: 120 }, (_, i) => view(`unrelated-${i}`, 'different material'))
  const f = setup(t, [stale, stopped, target, ...unrelated], undefined, undefined, { sync: false })
  const checks: string[] = []
  const invalidations: string[] = []
  let enabled = true
  const retrieval = createMemoryFileRetrieval({ index: f.index, workspaces: () => [workspace], hash,
    onStale: file => { invalidations.push(file.id) },
    policy: {
      read(scope, path) {
        checks.push(path)
        if (!enabled && path === stopped.path) throw new Error('File unavailable')
        return f.policy.read(scope, path)
      },
      list() { assert.fail('published reads must not walk authoritative files') },
    },
  })
  t.after(() => retrieval.close())
  assert.equal(retrieval.publishFiles([stale, stopped, target, ...unrelated]).accepted, 123)
  f.views.set(stale.id, view(stale.id, 'external modification'))
  enabled = false
  checks.length = 0
  const result = await retrieval.search({ query: 'needle', allows, limit: 1 })
  assert.deepEqual(result.hits.map(hit => hit.id), [target.id])
  assert.deepEqual(result.sourceIds, ['source-target'])
  assert.ok(result.reasons.includes('file-changed'))
  assert.equal(result.partial, true)
  assert.deepEqual(new Set(invalidations), new Set([stale.id, stopped.id]))
  assert.deepEqual(new Set(checks), new Set([stale.path, stopped.path, target.path]))
  checks.length = 0
  assert.deepEqual(retrieval.nodeSearch({ query: 'target', allows, limit: 1 }).nodes.map(hit => hit.id), [target.id])
  assert.deepEqual(checks, [target.path])
})

test('published lexical refill stops once the verified candidate cap is full and clears an exhausted page', async t => {
  const documents = Array.from({ length: 40 }, (_, n) => view(`document-${String(n).padStart(2, '0')}`, 'needle'))
  const f = setup(t, documents, undefined, undefined, { sync: false })
  const offsets: number[] = []
  const retrieval = createMemoryFileRetrieval({ index: { ...f.index, lexicalCandidates(query, scope, limit, offset) {
    offsets.push(offset ?? 0)
    return f.index.lexicalCandidates(query, scope, limit, offset)
  } }, policy: f.policy, workspaces: () => [workspace], hash })
  t.after(() => retrieval.close())
  retrieval.publishFiles(documents)
  const batch = { load: async () => {}, read: f.policy.read, readObservation: f.policy.read,
    physical: () => null, managementObservation: () => null, managementRead: () => null, observedRevision: () => undefined, incomplete: () => false }
  const highScore = await retrieval.search({ query: 'needle', allows, limit: 1, minScore: 1 }, batch)
  assert.deepEqual(offsets, [0])
  assert.equal(highScore.hits.length, 0)
  assert.ok(highScore.reasons.includes('candidate-limit'))

  offsets.length = 0
  const lastId = f.index.lexicalCandidates('needle', { workspaces: [workspace] }, 40).rows.at(-1)!.file.id
  const complete = await retrieval.search({ query: 'needle', allows: view => view.id === lastId, limit: 1 }, batch)
  assert.deepEqual(offsets, [0, 32])
  assert.deepEqual(complete.hits.map(hit => hit.id), [lastId])
  assert.ok(!complete.reasons.includes('candidate-limit'))
})

test('the automatic context deadline leaves a cold query worker warming until its own inference deadline', async t => {
  const { embedder } = encoder()
  const { retrieval } = setup(t, [view('a', 'needle')], embedder)
  assert.ok(await retrieval.prepareVectors())
  const caller = new AbortController()
  let signal: AbortSignal | undefined, release!: () => void
  embedder.embedBatch = async (_inputs, infer) => { signal = infer; await new Promise<void>(resolve => { release = resolve }); return [unit(0)] }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = retrieval.search({ query: 'needle', automatic: true, allows, signal: caller.signal })
  try {
    assert.ok(signal)
    caller.abort(new RequestTimeout())
    t.mock.timers.tick(DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs)
    await pending
    assert.equal(signal.aborted, false)
    retrieval.close()
    assert.equal(signal.aborted, true)
  } finally { release() }
})

test('vector preparation allows a corpus to exceed one inference deadline across completed batches', async t => {
  const { embedder } = encoder()
  const { retrieval, index } = setup(t, [view('a', 'first'), view('b', 'second'), view('c', 'third')], embedder)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  embedder.embedBatch = async (inputs, signal) => {
    t.mock.timers.tick(4_000)
    assert.equal(signal?.aborted, false)
    return inputs.map(() => unit(0))
  }
  assert.equal(await retrieval.prepareVectors(), true)
  assert.equal(index.vectorState().active, true)
})

test('manual reindex during an in-flight query resumes vector preparation when the query finishes', async t => {
  const { embedder } = encoder()
  const run = embedder.embedBatch
  let enteredQuery!: () => void, releaseQuery!: () => void, rebuiltDone!: () => void
  const queryStarted = new Promise<void>(resolve => { enteredQuery = resolve })
  const queryGate = new Promise<void>(resolve => { releaseQuery = resolve })
  const rebuiltReady = new Promise<void>(resolve => { rebuiltDone = resolve })
  embedder.embedBatch = async (inputs, signal) => {
    if (inputs[0]?.kind === 'query') { enteredQuery(); await queryGate }
    return run(inputs, signal)
  }
  const doc = view('a', 'needle')
  const { retrieval, index } = setup(t, [doc], embedder)
  t.after(releaseQuery)
  assert.equal(await retrieval.prepareVectors(), true)
  assert.equal(index.vectorState().active, true)
  const finish = index.finishVectors
  let targetGeneration = -1
  index.finishVectors = (generation, expected) => {
    const ok = finish(generation, expected)
    if (ok && generation === targetGeneration) rebuiltDone()
    return ok
  }
  const pendingSearch = retrieval.search({ query: 'needle', allows })
  await queryStarted
  const rebuilt = retrieval.reindex()
  targetGeneration = rebuilt.vectorGeneration
  assert.equal(retrieval.publishFiles([{ workspace, path: doc.path }]).accepted, 0)
  assert.equal(await retrieval.prepareVectors(), false)
  assert.equal(index.vectorState().generation, rebuilt.vectorGeneration)
  assert.equal(index.vectorState().active, false)
  releaseQuery()
  await pendingSearch
  await rebuiltReady
  assert.equal(index.vectorState().generation, rebuilt.vectorGeneration)
  assert.equal(index.vectorState().active, true)
  assert.deepEqual(index.missingVectors(rebuilt.vectorGeneration), [])
})

test('republishing an unchanged digest returns zero accepted and skips redundant vector checks', async t => {
  const { embedder } = encoder()
  const existing = view('existing-address', 'Current contact note.')
  const { retrieval, index } = setup(t, [existing], embedder, undefined, { sync: false })
  let vectorChecks = 0
  const begin = index.beginVectors
  index.beginVectors = space => { vectorChecks++; return begin(space) }
  assert.deepEqual(retrieval.publishFiles([{ workspace, path: existing.path }]), { accepted: 1, removed: 0 })
  assert.equal(await retrieval.prepareVectors(), true)
  const checksAfterFirst = vectorChecks
  assert.ok(checksAfterFirst >= 1)
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(retrieval.publishFiles([{ workspace, path: existing.path }]), { accepted: 0, removed: 0 })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(vectorChecks, checksAfterFirst)
  }
})

test('nodeSearch and nodeSearchAsync match digest body chunks and semantic vectors while returning metadata only', async t => {
  const { embedder } = encoder()
  const hidden = view('secret-digest', 'needle body-only-secret-token')
  const matched = view('opaque-topic', 'contains needle and deep-body-fact-42')
  const daily = view('daily-only', 'contains needle and deep-body-fact-42', { kind: 'daily', day: '2026-11-16', path: 'daily/2026-11-16/a.md' })
  const unrelated = view('other-topic', 'completely unrelated note')
  const { retrieval } = setup(t, [hidden, matched, daily, unrelated], embedder)

  // Sync nodeSearch should match digest body chunks lexically, skip daily files, enforce allows, and omit body text.
  const lexical = retrieval.nodeSearch({ query: 'deep-body-fact-42', allows: item => item.id !== 'secret-digest' })
  assert.deepEqual(lexical.nodes.map(node => node.id), ['opaque-topic'])
  assert.equal('text' in lexical.nodes[0]!, false)
  assert.equal(JSON.stringify(lexical.nodes).includes('deep-body-fact-42'), false)

  // Async nodeSearchAsync should match digest semantically via vectors even with zero lexical overlap in title/description/body.
  assert.equal(await retrieval.prepareVectors(), true)
  const semantic = await retrieval.nodeSearchAsync({ query: 'needle-equivalent', allows: item => item.id !== 'secret-digest' })
  assert.equal(semantic.nodes[0]?.id, 'opaque-topic')
  assert.equal(semantic.nodes.some(node => node.id === 'secret-digest' || node.id === 'daily-only'), false)
  assert.equal(JSON.stringify(semantic.nodes).includes('deep-body-fact-42'), false)
})

test('nodeSearchAsync paginates chunk lexical candidates past disallowed/daily hits and supports offset paging', async t => {
  const fillers = Array.from({ length: 40 }, (_, i) =>
    view(`daily-filler-${String(i).padStart(2, '0')}`, 'deep-paginated-token body', {
      kind: 'daily', day: '2026-11-16', path: `daily/2026-11-16/f-${String(i).padStart(2, '0')}.md`,
    }))
  const targetA = view('opaque-digest-a', 'deep-paginated-token body')
  const targetB = view('opaque-digest-b', 'deep-paginated-token body')
  const { retrieval } = setup(t, [...fillers, targetA, targetB])

  const page1 = await retrieval.nodeSearchAsync({ query: 'deep-paginated-token', limit: 1, allows })
  assert.equal(page1.nodes.length, 1)
  assert.equal(page1.partial, true)
  const page2 = await retrieval.nodeSearchAsync({ query: 'deep-paginated-token', limit: 1, offset: 1, allows })
  assert.equal(page2.nodes.length, 1)
  assert.notEqual(page2.nodes[0]!.id, page1.nodes[0]!.id)
  assert.deepEqual([page1.nodes[0]!.id, page2.nodes[0]!.id].sort(), ['opaque-digest-a', 'opaque-digest-b'])
  // Final page after all verified candidates are exhausted must report partial: false even when disallowed candidates were filtered out.
  assert.equal(page2.partial, false, 'filtered/disallowed candidates must not keep nodeSearch partial: true once exhausted')
})
