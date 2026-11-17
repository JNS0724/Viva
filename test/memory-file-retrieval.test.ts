import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { createMemoryFileRetrieval, memoryFileChunkKey, memoryFileLexicalQuery, fuseMemoryFileHits } from '../src/memory/core/memory-file-retrieval.ts'
import type { MemoryDocumentView } from '../src/memory/core/memory-document-read-policy.ts'
import type { MemoryEmbedder, MemoryEmbeddingInput } from '../src/memory/contracts/embedding.ts'
import type { MemoryFileHit } from '../src/memory/core/ports/file-index.ts'
import type { DiagnosticEvent, DiagnosticPort } from '../src/diagnostics/contracts.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const workspace = hash('workspace')
const allows = () => true
function view(id: string, text: string, extra: Partial<MemoryDocumentView> = {}): MemoryDocumentView {
  const markdown = `---\nname: ${id}\ndescription: ${id} description\n---\n${text}`
  return { id, workspace, path:`digest/wiki/${id}.md`,kind:'digest',revision:hash(markdown),usageVersion:1,
    policyToken:hash(markdown),updatedAt:1,markdown,currentMarkdown:markdown,sources:[],sourceTokens:[{id:`source-${id}`,token:'v1'}],
    backing:null,supporting:[],applicability:{state:'current',supersessions:[]},...extra }
}
function setup(t: test.TestContext, initial: MemoryDocumentView[], embedder?: MemoryEmbedder, diagnostics?: DiagnosticPort) {
  const db=new DatabaseSync(':memory:')
  const index=openMemoryFileIndex({db})
  const views=new Map(initial.map(item=>[item.id,item]))
  const policy={read: (scope:string,path:string)=>[...views.values()].find(item=>item.workspace===scope && item.path===path) ?? null,
    list: (scope:string)=>[...views.values()].filter(item=>item.workspace===scope)}
  const retrieval=createMemoryFileRetrieval({index,policy,workspaces:()=>[workspace],hash,embedder,diagnostics})
  t.after(()=>{retrieval.close();db.close()})
  return {db,index,views,policy,retrieval}
}
function unit(first: number) {const vector=new Float32Array(384);vector[first]=1;return vector}
function encoder() {
  const calls: MemoryEmbeddingInput[][]=[]
  const embedder: MemoryEmbedder={dimensions:384,fingerprint:'test-space',close(){},async embedBatch(inputs){calls.push([...inputs]);return inputs.map(item=>unit(item.text.includes('needle')?0:1))}}
  return {embedder,calls}
}

test('retrieval diagnostics identify lexical, vector, fusion and relations without copying query or evidence', async t => {
  const events: DiagnosticEvent[] = []
  const model = encoder()
  const f = setup(t, [view('private-document', 'needle PRIVATE_BODY_CANARY')], model.embedder, {
    emit(event) { events.push(event); return undefined },
  })
  const result = await f.retrieval.search({ query: 'needle PRIVATE_QUERY_CANARY', allows })
  assert.ok(result.hits.length)
  assert.deepEqual(events.filter(event => event.event === 'operation.progress' && event.operation === 'memory.recall').map(event => event.stage), ['lexical', 'vector', 'fusion', 'relations'])
  assert.ok(events.some(event => event.operation === 'memory.index' && event.stage === 'checkpoint' && event.metrics?.ok === true))
  assert.equal(events.at(-1)?.outcome, 'completed')
  assert.equal(events.at(-1)?.metrics?.count, result.hits.length)
  assert.equal(JSON.stringify(events).includes('PRIVATE_'), false)
  f.retrieval.read({ id: 'private-document', allows })
  f.retrieval.nodeSearch({ query: 'PRIVATE_NODE_QUERY', allows })
  f.retrieval.relations({ workspace, path: 'digest/wiki/private-document.md', allows })
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
  assert.ok(f.retrieval.relations({ workspace, path: 'digest/wiki/document.md', allows }))
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

test('superseded prose and stale metadata are never current search or node matches', async t=>{
  const old=view('old','Retired city Shanghai.\nUnrelated needle remains.')
  old.currentMarkdown=old.markdown.replace('Retired city Shanghai.',' '.repeat('Retired city Shanghai.'.length))
  old.applicability={state:'superseded',supersessions:[]}
  const {retrieval}=setup(t,[old])
  assert.equal((await retrieval.search({query:'Shanghai',allows})).status,'empty')
  const result=await retrieval.search({query:'needle',allows})
  assert.equal(result.hits.length,1);assert.ok(!result.hits[0]!.text.includes('Shanghai'))
  assert.equal(retrieval.nodeSearch({query:'old',allows}).nodes.length,0)
  assert.ok(!retrieval.read({id:'old',allows})!.text.includes('Shanghai'))
  assert.ok(retrieval.read({id:'old',allows,evidence:true})!.text.includes('Shanghai'))
})

test('relations return at most ten permitted neighbors and no hidden counts or summaries', async t=>{
  const peers=Array.from({length:13},(_,i)=>view(`peer-${i}`,'[[digest/wiki/root.md]]'))
  const root=view('root',peers.map(item=>`[[${item.path}]]`).join('\n'))
  const {retrieval}=setup(t,[root,...peers])
  const result=retrieval.relations({workspace,path:root.path,allows:item=>item.id!=='peer-12'})!
  assert.equal(result.outlinks.visibleCount,12);assert.equal(result.inlinks.visibleCount,12)
  assert.equal(result.outlinks.neighbors.length,10);assert.equal(result.inlinks.partial,true)
  assert.ok(!JSON.stringify(result).includes('peer-12'))
  assert.equal(result.files.length,13)
})

test('context dedup distinguishes empty and exhausted and invalidates on query, authorization and revision', async t=>{
  const a=view('a','needle'), b=view('b','needle')
  const {retrieval,views}=setup(t,[a,b])
  const request={query:'needle',allows,contextKey:'session-turn'}
  assert.equal((await retrieval.search(request)).hits.length,2)
  assert.equal((await retrieval.search(request)).status,'exhausted')
  assert.equal((await retrieval.search({...request,query:'missing'})).status,'empty')
  assert.equal((await retrieval.search({...request,allows:item=>item.id==='a'})).hits.length,1)
  views.set('a',{...a,policyToken:'new-state',usageVersion:2})
  assert.equal((await retrieval.search(request)).hits.length,2)
  assert.equal((await retrieval.search({query:'needle',allows})).hits.length,2)
})

test('reindex uses accepted snapshots without rereading newly edited domain documents', t=>{
  const a=view('a','accepted needle')
  const {retrieval,index,views}=setup(t,[a]);retrieval.sync()
  views.set('a',view('a','unaccepted external edit'))
  const result=retrieval.reindex();assert.equal(result.lexical,true)
  assert.ok(index.snapshot(workspace,'a')!.chunks[0]!.text.includes('accepted needle'))
  assert.equal(index.lexical('needle',index.files([workspace]),5).hits.length,1)
  retrieval.sync();assert.ok(index.snapshot(workspace,'a')!.chunks[0]!.text.includes('external edit'))
  views.delete('a');retrieval.sync();assert.equal(index.files([workspace]).length,0)
})

test('local multi-passage vectors persist and hot search only embeds its query', async t=>{
  const {embedder,calls}=encoder()
  const {retrieval,index}=setup(t,[view('long','needle '+('word '.repeat(1000)))],embedder)
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
  await retrieval.search({query:'needle',allows})
  assert.equal(index.vectorState().active,true)
  let observedDisabled=false
  const second:MemoryEmbedder={dimensions:384,fingerprint:'changed-space',close(){},async embedBatch(inputs){observedDisabled ||= !index.vectorState().active;return inputs.map(()=>unit(0))}}
  const other=createMemoryFileRetrieval({index,policy:{read:()=>view('a','needle'),list:()=>[view('a','needle')]},workspaces:()=>[workspace],hash,embedder:second})
  t.after(()=>other.close())
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
  const pending=retrieval.search({query:'needle',allows});await ready
  views.delete('a');finish()
  const result=await pending
  assert.equal(result.status,'unavailable');assert.deepEqual(result.hits,[])
  assert.equal(index.vectorState().active,false)
  assert.equal(index.missingVectors(index.vectorState().generation).length,1)
  assert.equal(calls,1, 'a revoked source must not enter another passage batch')
})

test('broken or unavailable embeddings degrade to full text without claiming a semantic hit', async t=>{
  const embedder:MemoryEmbedder={dimensions:384,fingerprint:'broken',close(){},async embedBatch(){return null}}
  const {retrieval}=setup(t,[view('a','needle')],embedder)
  const result=await retrieval.search({query:'needle',allows})
  assert.equal(result.status,'ok');assert.deepEqual(result.hits.map(hit=>hit.id),['a'])
  assert.ok(result.reasons.includes('semantic-index-incomplete'))
})

test('evidence output hides inaccessible replacement identity and contents', t=>{
  const old=view('old','old fact'), replacement=view('private','new secret fact')
  old.supporting=[{id:replacement.id,workspace,path:replacement.path,revision:replacement.revision,usageVersion:1,markdown:replacement.markdown,sources:[],enabled:true,corrections:[]}]
  old.applicability={state:'superseded',supersessions:[{path:old.path,revision:old.revision,startLine:5,endLine:5,text:'old fact',condition:'secret condition',time:'secret time',sourceDocumentId:old.id,documentId:replacement.id,replacementRevision:replacement.revision,operationId:'correction'}]}
  const {retrieval}=setup(t,[old,replacement])
  const result=retrieval.read({id:'old',evidence:true,allows:item=>item.id!=='private'})!
  assert.deepEqual(result.applicability.supersessions,[{startLine:5,endLine:5,replacementUnavailable:true}])
  assert.ok(!result.text.includes('secret'))
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
  retrieval.sync()
  const chunks = index.chunks(index.files([workspace]))
  const longChunks = chunks.filter(chunk => chunk.file.id === 'long')
  assert.equal(longChunks.length, 3)
  const others = chunks.filter(chunk => chunk.file.id !== 'long').sort((a,b)=>a.file.id.localeCompare(b.file.id))
  index.lexical = () => ({ hits: [...longChunks, ...others].map((chunk,index)=>({ ...chunk, score: 100-index })), mode: 'fts' })
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
  const pending = retrieval.search({ query: 'needle', allows, signal: controller.signal })
  await started
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'unavailable')
  assert.equal(index.vectorState().active, false)
})

test('corrupt cached vectors trigger rebuild and failed repair falls back with an explicit reason', async t => {
  const original = encoder()
  let unavailable = false
  const embedder: MemoryEmbedder = { dimensions: 384, fingerprint: original.embedder.fingerprint, close() {},
    embedBatch: (inputs, signal) => unavailable ? Promise.resolve(null) : original.embedder.embedBatch(inputs, signal) }
  const { retrieval, db } = setup(t, [view('a', 'needle')], embedder)
  await retrieval.search({ query: 'needle', allows })
  db.exec("UPDATE memory_file_index_vectors SET vector = x'01'")
  unavailable = true
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

test('link neighbors and path reads resolve trusted rename aliases without changing logical identity', t => {
  const oldPath = 'digest/wiki/old.md'
  const renamed = view('stable-id', 'needle', { path: 'digest/wiki/new.md' })
  const root = view('root', `[[${oldPath}]]`)
  const { index, policy } = setup(t, [root, renamed])
  const retrieval = createMemoryFileRetrieval({ index, policy, workspaces: () => [workspace], hash,
    resolveAlias: (scope, path) => scope === workspace && path === oldPath ? renamed.path : null })
  t.after(() => retrieval.close())
  const outgoing = retrieval.relations({ workspace, path: root.path, allows })!
  assert.equal(outgoing.outlinks.visibleCount, 1)
  assert.equal(outgoing.outlinks.neighbors[0]!.id, 'stable-id')
  const incoming = retrieval.relations({ workspace, path: oldPath, allows })!
  assert.equal(incoming.inlinks.neighbors[0]!.id, 'root')
  assert.equal(retrieval.read({ workspace, path: oldPath, allows })!.path, renamed.path)
})


test('search line ranges round-trip through read for LF, CRLF and lone CR', async t => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const markdown = ['---', 'name: title', 'description: desc', '---', 'first', 'needle'].join(newline)
    const document = view(`line-${newline.length}-${newline.charCodeAt(0)}`, '', { markdown, currentMarkdown: markdown, revision: hash(markdown), policyToken: hash(markdown) })
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


test('output budget keeps an oversized locator readable without consuming its context result', t => {
  const { retrieval } = setup(t, [view('a', 'needle '.repeat(1100))])
  const request = { query: 'needle', allows, contextKey: 'budget-context', maxChars: 800 }
  const small = retrieval.searchCached(request)
  const publicJson = ({ files: _files, sourceIds: _sources, ...result }: typeof small) => JSON.stringify(result)
  assert.ok(publicJson(small).length <= request.maxChars)
  assert.equal(small.status, 'ok')
  assert.equal(small.hits[0]!.text, '')
  assert.equal(small.hits[0]!.readRequired, true)
  assert.ok(small.reasons.includes('output-budget'))
  const locator = small.hits[0]!
  assert.ok(retrieval.read({ id: locator.id, startLine: locator.startLine, endLine: locator.endLine, allows })!.text.includes('needle'))
  const full = retrieval.searchCached({ ...request, maxChars: 12_000 })
  assert.ok(full.hits[0]!.text.includes('needle'))
  assert.equal(full.hits[0]!.readRequired, undefined)
  assert.equal(retrieval.searchCached({ ...request, maxChars: 12_000 }).status, 'exhausted')
})

test('budget includes escaped JSON, applicability and neighbor summaries and marks only complete hits seen', t => {
  const root = view('a', 'needle '.repeat(25) + '\n[[digest/wiki/b.md]]')
  const peer = view('b', 'companion details')
  const hugeDescription = 'details "with escapes" '.repeat(200)
  peer.markdown = peer.currentMarkdown = peer.markdown.replace('b description', hugeDescription)
  peer.revision = peer.policyToken = hash(peer.markdown)
  const { retrieval } = setup(t, [root, peer])
  const result = retrieval.searchCached({ query: 'needle', allows, maxChars: 850, contextKey: 'neighbors-budget' })
  const { files: _files, sourceIds: _sources, ...publicResult } = result
  assert.ok(JSON.stringify(publicResult).length <= 850)
  assert.ok(result.reasons.includes('output-budget'))
  assert.ok(result.hits[0]!.readRequired)
  assert.ok(retrieval.searchCached({ query: 'needle', allows, maxChars: 20_000, contextKey: 'neighbors-budget' }).hits.every(hit => !hit.readRequired))
  assert.throws(() => retrieval.searchCached({ query: 'needle', allows, maxChars: 10 }), /invalid-memory-file-output-budget/u)
})


test('output locator retains supersession applicability and never hides a replacement warning', t => {
  const old = view('old', 'needle '.repeat(1100))
  old.applicability = { state: 'unavailable', supersessions: [{ path: old.path, revision: old.revision, startLine: 5, endLine: 5,
    text: 'retired fragment', condition: 'only before transfer', time: 'past', sourceDocumentId: old.id,
    documentId: 'missing-replacement', replacementRevision: 'gone', operationId: 'corrected' }] }
  const { retrieval } = setup(t, [old])
  const result = retrieval.searchCached({ query: 'needle', allows, maxChars: 1000, contextKey: 'warning-budget' })
  assert.equal(result.hits[0]!.readRequired, true)
  assert.deepEqual(result.hits[0]!.applicability, { state: 'unavailable', supersessions: [{ startLine: 5, endLine: 5, replacementUnavailable: true }] })
  assert.ok(result.reasons.includes('output-budget'))
})

test('file vector space follows adapter-declared dimensions and invalidates a changed width even with the same model fingerprint', async t => {
  const model = (dimensions: number): MemoryEmbedder => ({ fingerprint: 'alternate-model', dimensions, close() {},
    async embedBatch(inputs) { return inputs.map(() => { const vector = new Float32Array(dimensions); vector[0] = 1; return vector }) } })
  const { retrieval, index, policy } = setup(t, [view('small', 'needle')], model(2))
  const first = await retrieval.search({ query: 'needle', allows })
  assert.equal(first.status, 'ok')
  assert.equal(index.vectorState().space?.dimensions, 2)
  assert.equal(index.vectorState().active, true)
  const oldGeneration = index.vectorState().generation
  const next = createMemoryFileRetrieval({ index, policy, workspaces: () => [workspace], hash, embedder: model(3) })
  t.after(() => next.close())
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
  const result = await retrieval.search({ query: 'needle', allows })
  assert.equal(result.status, 'ok')
  assert.ok(result.reasons.includes('semantic-index-incomplete'))
  assert.equal(index.vectorState().active, false)
  assert.ok(inputs.every(text => text.startsWith(name.trim() + '\n\n')))
  assert.ok(inputs.length < 20)
})
