/** Offline, frozen R4 retrieval evaluation. No remote model or answer-generation calls.
 * Usage: node scripts/memory-file-evaluation.ts <model-dir> <runtime-dir> [report.json] [--regression] [--data=validation] */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createMemoryEmbedder } from '../src/memory/node/memory-embedder.ts'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { createMemoryFileRetrieval, memoryFileChunkKey, memoryFileLexicalQuery } from '../src/memory/core/memory-file-retrieval.ts'
import { fuseMemoryFileHits, relevantMemoryFileLanes, selectMemoryFileHits } from '../src/memory/core/memory-file-ranking.ts'
import { createMemoryDocumentReadPolicy } from '../src/memory/core/memory-document-read-policy.ts'
import { formatMemoryDocument, memoryDocumentLines, parseMemoryDocument, readMemoryLines } from '../src/memory/core/memory-document.ts'
import type { DocumentSnapshot, DocumentSupersession } from '../src/memory/core/ports/documents.ts'
import type { MemoryFileHit } from '../src/memory/core/ports/file-index.ts'
import type { MemoryDocumentView } from '../src/memory/core/memory-document-read-policy.ts'
import type { FileSearchResult } from '../src/memory/core/memory-file-retrieval.ts'
import { evaluationDocuments, evaluationQueries, evaluationGates, evaluationFreeze } from '../test/fixtures/memory-file-evaluation.ts'
import { validationDocuments, validationQueries } from '../test/fixtures/memory-file-validation.ts'
import type { EvaluationDocument, EvaluationQuery } from '../test/fixtures/memory-file-evaluation.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const workspace = (scope: EvaluationDocument['scope']) => hash(`holdout-workspace:${scope}`)
const logicalId = (document: EvaluationDocument) => document.kind === 'daily' ? `daily:${hash(document.id)}` : document.id
const source = (document: EvaluationDocument) => ({ id: `source:${document.id}`, token: hash(document.body) })
const pathOf = (document: EvaluationDocument) => document.kind === 'daily' ? `daily/${document.day}/${document.id}.md` : `digest/wiki/${document.id}.md`
const markdownOf = (document: EvaluationDocument) => formatMemoryDocument({ metadata: { name: document.name, description: document.name }, body: document.body })
const percentile = (values: number[], fraction: number) => [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*fraction)-1)] ?? null

/** Audit the actual service payload, independent of diagnostic ranks and question labels. */
export function auditEvaluationResult(result: FileSearchResult, authorized: readonly MemoryDocumentView[]) {
  const views = new Map(authorized.map(view => [JSON.stringify([view.workspace, view.id]), view]))
  const sources = new Set(authorized.flatMap(view => view.sourceTokens.map(source => source.id)))
  const unauthorized: string[] = [], invalidSlices: string[] = []
  const find = (workspace: string, id: string) => views.get(JSON.stringify([workspace, id]))
  const requireDependency = (view: MemoryDocumentView, includeSources: boolean) => {
    if (!result.files.some(ref => ref.workspace === view.workspace && ref.id === view.id && ref.path === view.path
      && ref.revision === view.revision && ref.usageVersion === view.usageVersion && ref.policyToken === view.policyToken)) unauthorized.push(`missing-dependency:${view.id}`)
    if (includeSources) for (const source of view.sourceTokens) {
      if (!result.sourceIds.includes(source.id)) unauthorized.push(`missing-source:${source.id}`)
    }
  }
  for (const hit of result.hits) {
    const view = find(hit.workspace, hit.id)
    if (!view || view.path !== hit.path || view.revision !== hit.revision) unauthorized.push(`hit:${hit.id}`)
    if (!view?.currentMarkdown || !hit.text || hit.readRequired
      || !readMemoryLines(view.currentMarkdown, hit.startLine, hit.endLine).includes(hit.text.replace(/(?:\r\n|\r|\n)$/u, ''))) invalidSlices.push(hit.id)
    if (view) {
      requireDependency(view, true)
      const expected = { state: view.applicability.state, supersessions: view.applicability.supersessions.map(item => {
        const support = view.supporting.find(candidate => candidate.id === item.documentId)
        const replacement = support && find(view.workspace, support.id)
        const base = { startLine: item.startLine, endLine: item.endLine }
        if (replacement && replacement.path === support.path) requireDependency(replacement, false)
        return replacement && replacement.path === support.path
          ? { ...base, condition: item.condition, time: item.time, replacement: { id: replacement.id, path: replacement.path, revision: replacement.revision, state: replacement.applicability.state } }
          : { ...base, replacementUnavailable: true }
      }) }
      if (!isDeepStrictEqual(hit.applicability, expected)) unauthorized.push(`applicability:${hit.id}`)
    }
    for (const neighbor of [...hit.inlinks.neighbors, ...hit.outlinks.neighbors]) {
      const adjacent = find(neighbor.workspace, neighbor.id)
      if (adjacent) requireDependency(adjacent, true)
      const metadata = adjacent?.applicability.state === 'current' && adjacent.currentMarkdown
        ? parseMemoryDocument(adjacent.currentMarkdown).metadata : {}
      const expected = adjacent && { id: adjacent.id, workspace: adjacent.workspace, path: adjacent.path,
        name: typeof metadata.name === 'string' ? metadata.name : '', description: typeof metadata.description === 'string' ? metadata.description : '' }
      if (!isDeepStrictEqual(neighbor, expected)) unauthorized.push(`neighbor:${neighbor.id}`)
    }
  }
  for (const dependency of result.files) {
    const view = find(dependency.workspace, dependency.id)
    if (!view || view.path !== dependency.path || view.revision !== dependency.revision
      || view.usageVersion !== dependency.usageVersion || view.policyToken !== dependency.policyToken) unauthorized.push(`dependency:${dependency.id}`)
  }
  for (const source of result.sourceIds) if (!sources.has(source)) unauthorized.push(`source:${source}`)
  return { unauthorized, invalidSlices }
}

/** Frozen data identity is checked before creating a worker or reading scores. */
export function checkEvaluationFreeze() {
  const actual = hash(JSON.stringify({ documents: evaluationDocuments, queries: evaluationQueries, gates: evaluationGates }))
  assert.equal(actual, evaluationFreeze.sha256, 'holdout changed after freezing; do not silently tune the evaluation set')
  assert.equal(evaluationDocuments.length, 120)
  assert.equal(evaluationQueries.length, 60)
  for (const query of evaluationQueries) for (const label of [...query.evidence, ...query.forbidden ?? []]) {
    const document = evaluationDocuments.find(item => item.id === label.id)
    assert.ok(document && document.body.includes(label.quote), `invalid evidence label ${query.id}/${label.id}`)
  }
  return actual
}


const validationFile = new URL('../test/fixtures/memory-file-validation.ts', import.meta.url)
const validationFileSha256 = '591d746bf0c575d5562f8fb022b84168f07888a09c69d5ccf9ec236f5c0584eb'
/** The second set was frozen as source-file bytes; report the expanded data hash separately. */
export function checkValidationFreeze() {
  const fileHash = createHash('sha256').update(readFileSync(validationFile)).digest('hex')
  assert.equal(fileHash, validationFileSha256, 'independent validation file changed after freezing')
  assert.equal(validationDocuments.length, 120)
  assert.equal(validationQueries.length, 60)
  assert.equal(new Set(validationDocuments.map(item => item.id)).size, 120)
  assert.equal(new Set(validationQueries.map(item => item.id)).size, 60)
  assert.deepEqual(['answer', 'absent', 'ambiguous', 'safety'].map(kind => validationQueries.filter(query => query.kind === kind).length), [36, 12, 6, 6])
  for (const group of ['chinese-paraphrase', 'cross-language', 'tail-structure', 'condition-time']) {
    assert.equal(validationQueries.filter(query => query.kind === 'answer' && query.group === group).length, 9)
  }
  for (const query of validationQueries) for (const label of [...query.evidence, ...query.forbidden ?? []]) {
    assert.ok(validationDocuments.find(item => item.id === label.id)?.body.includes(label.quote), `invalid validation evidence ${query.id}/${label.id}`)
  }
  // These gates were recorded before the first validation run. They are not selected by scores.
  assert.deepEqual([evaluationGates.fixedLimit, evaluationGates.candidatesPerLane, evaluationGates.minScore,
    evaluationGates.answerEvidenceHit5, evaluationGates.minimumGroupHit5, evaluationGates.sourceSliceErrors, evaluationGates.safetyLeaks], [5, 25, 0, 0.9, 0.8, 0, 0])
  const dataHash = hash(JSON.stringify({ documents: validationDocuments, queries: validationQueries, gates: evaluationGates }))
  return { fileHash, dataHash, dataEncoding: 'JSON.stringify({ documents, queries, gates })' as const }
}

export function dataPolicy(documents: readonly EvaluationDocument[]) {
  const byId = new Map(documents.map(document => [document.id, document]))
  const byLogicalId = new Map(documents.map(document => [logicalId(document), document]))
  const bodies = new Map(documents.map(document => [document.id, markdownOf(document)]))
  const relations: DocumentSupersession[] = documents.flatMap(document => {
    if (!document.supersedes) return []
    const old = byId.get(document.supersedes.id)!, markdown = bodies.get(old.id)!, quote = document.supersedes.quote
    const start = markdown.indexOf(quote)
    assert.ok(start >= 0 && markdown.indexOf(quote, start + 1) < 0)
    const lines = memoryDocumentLines(markdown)
    const startLine = lines.findIndex(line => line.startOffset <= start && start < line.endOffset) + 1
    const last = start + quote.length - 1
    const endLine = lines.findIndex(line => line.startOffset <= last && last < line.endOffset) + 1
    assert.equal(readMemoryLines(markdown,startLine,endLine),quote)
    return [{ path:pathOf(old), revision:hash(markdown),startLine,endLine,text:quote,condition:'',time:'',
      sourceDocumentId:logicalId(old),documentId:logicalId(document),replacementRevision:hash(bodies.get(document.id)!),operationId:`correction:${document.id}` }]
  })
  const snapshots = new Map(documents.filter(document => document.kind === 'digest').map(document => {
    const markdown = bodies.get(document.id)!
    const snapshot: DocumentSnapshot = {id:document.id,workspace:workspace(document.scope),path:pathOf(document),revision:hash(markdown),usageVersion:1,
      markdown,sources:[source(document)],enabled:document.state==='active',corrections:relations.filter(item=>item.documentId===document.id)}
    return [document.id,snapshot]
  }))
  type PolicyArguments = Parameters<typeof createMemoryDocumentReadPolicy>[0]
  const notes = new Map(documents.filter(document=>document.kind==='daily').map(document=>{
    const markdown=bodies.get(document.id)!, revision=hash(markdown), row={key:document.id,workspace:workspace(document.scope),path:pathOf(document),day:document.day!,
      revision:1,processed:0,updatedAt:Date.parse(`${document.day}T12:00:00Z`),file_revision:revision}
    return [document.id,{...row,title:document.name,markdown:parseMemoryDocument(markdown).body,document:markdown,fileRevision:revision}]
  }))
  const notePort: PolicyArguments['notes'] = {
    registered:()=>[...notes.values()].map(note=>({...note,sources:[source(byId.get(note.key)!)],state:'active' as const})),
    read:key=>notes.get(key),references:key=>byId.has(key)?[source(byId.get(key)!)]:[],
    sources:key=>byId.has(key)?[source(byId.get(key)!).id]:[],
    snapshot:ids=>documents.map(source).filter(ref=>ids.includes(ref.id)),
  }
  const documentPort: PolicyArguments['documents'] = {
    registered:scope=>[...snapshots.values()].filter(item=>item.workspace===scope).map(item=>({...item,state:byId.get(item.id)!.state})),
    read:(scope,path)=>[...snapshots.values()].find(item=>item.workspace===scope && item.path===path && byId.get(item.id)!.state==='active') ?? null,
    sourceRestrictions:scope=>documents.filter(document=>workspace(document.scope)===scope && document.state==='disabled').map(source),
    supersessions:(scope,path)=>relations.filter(item=>item.path===path && workspace(byLogicalId.get(item.sourceDocumentId)!.scope)===scope),
  }
  const policy=createMemoryDocumentReadPolicy({notes:notePort,documents:documentPort,hash,
    refsCurrent:refs=>refs.every(ref=>documents.some(document=>source(document).id===ref.id && source(document).token===ref.token && document.state!=='forgotten')),
    materialAllowed:()=>true, // This synthetic corpus is explicitly trusted input, not model-adjudicated prose.
    reference:id=>documents.some(document=>source(document).id===id)?{namespace:'holdout',sourceId:id,revision:1}:null,
  })
  const ids = new Map(documents.map(document=>[logicalId(document),document.id]))
  return {policy,ids,bodies}
}

export async function runMemoryFileEvaluation(modelRoot: string, runtimeRoot: string, evaluationKind: 'holdout' | 'regression' = 'holdout', dataset: 'evaluation' | 'validation' = 'evaluation') {
  const verification = dataset === 'validation' ? checkValidationFreeze() : null
  const dataHash = verification?.dataHash ?? checkEvaluationFreeze()
  const documents = dataset === 'validation' ? validationDocuments : evaluationDocuments
  const queries = dataset === 'validation' ? validationQueries : evaluationQueries
  const db=new DatabaseSync(':memory:')
  const index=openMemoryFileIndex({db})
  const embedder=createMemoryEmbedder({modelRoot,runtimeRoot})
  const {policy,ids,bodies}=dataPolicy(documents)
  const scopes=[workspace('public'),workspace('restricted')]
  const allows=(view:MemoryDocumentView)=>view.workspace===workspace('public')
  const retrieval=createMemoryFileRetrieval({index,policy,workspaces:()=>scopes,hash,embedder})
  try {
    const coldStart=performance.now()
    const warm=await embedder.embedBatch([{kind:'query',text:'离线检索评估初始化'}])
    assert.ok(embedder.dimensions > 0 && warm?.[0]?.length===embedder.dimensions,'the real offline q8 worker must initialize')
    const coldMs=performance.now()-coldStart
    const indexingStart=performance.now()
    retrieval.sync()
    let ready=false, attempts=0
    // Preparation has a bounded per-batch deadline; resume the same generation instead of widening candidate pools.
    while(!ready && attempts<8) {attempts++;ready=await retrieval.prepareVectors()}
    assert.ok(ready,'all accepted passages must be indexed before quality measurement')
    const indexMs=performance.now()-indexingStart
    let sourceSliceErrors=0
    const sliceFailures: Array<{query:string,lane:string,id:string}> = []
    const queryTimes:number[]=[]
    type HitSummary={id:string,path:string,startLine:number,endLine:number,text:string,score:number}
    const cases=[]
    const summarize=(hit:MemoryFileHit):HitSummary=>({id:ids.get(hit.file.id)!,path:hit.file.path,startLine:hit.startLine,endLine:hit.endLine,text:hit.text,score:hit.score})
    const covered=(hits:HitSummary[],label:{id:string,quote:string})=>hits.some(hit=>hit.id===label.id && hit.text.includes(label.quote))
    for(const query of queries) {
      const allowed=index.files(scopes).filter(file=>{
        const view=policy.read(file.workspace,file.path)
        return view && allows(view) && (!file.day || (!query.from || file.day>=query.from) && (!query.through || file.day<=query.through))
          && (query.asOf===undefined || !file.updatedAt || file.updatedAt<=query.asOf)
      })
      const lexical=index.lexical(memoryFileLexicalQuery(query.text),allowed,evaluationGates.candidatesPerLane).hits
      const queryEmbedding=await embedder.embedBatch([{kind:'query',text:query.text}])
      assert.ok(queryEmbedding?.[0],`embedding failed for frozen query ${query.id}`)
      const scores=retrieval.indexedScores(queryEmbedding[0],allowed)
      const vector=index.chunks(allowed).flatMap(chunk=>{
        const score=scores.get(memoryFileChunkKey(chunk.ref));return score===undefined?[]:[{...chunk,score}]
      }).sort((a,b)=>b.score-a.score || memoryFileChunkKey(a.ref).localeCompare(memoryFileChunkKey(b.ref))).slice(0,evaluationGates.candidatesPerLane)
      const relevant = relevantMemoryFileLanes(query.text, lexical, vector)
      const fused=fuseMemoryFileHits(relevant.lexical,relevant.vector).filter(hit=>hit.score>=evaluationGates.minScore)
      const started=performance.now()
      const actual=await retrieval.search({query:query.text,limit:evaluationGates.fixedLimit,minScore:evaluationGates.minScore,from:query.from,through:query.through,asOf:query.asOf,allows})
      queryTimes.push(performance.now()-started)
      const actualHits=actual.hits.map(hit=>({...hit,id:ids.get(hit.id)!}))
      assert.deepEqual(actualHits.map(hit=>[hit.id,hit.path,hit.revision,hit.startLine,hit.endLine,hit.text,hit.score]),
        selectMemoryFileHits(fused,{limit:evaluationGates.fixedLimit,minScore:evaluationGates.minScore}).map(hit=>[ids.get(hit.file.id),hit.file.path,hit.ref.revision,hit.startLine,hit.endLine,hit.text,hit.score]),
        'diagnostic candidates must agree with the complete production service payload')
      const audited = auditEvaluationResult(actual, scopes.flatMap(scope => policy.list(scope)).filter(allows))
      sourceSliceErrors += audited.invalidSlices.length
      sliceFailures.push(...audited.invalidSlices.map(id => ({ query: query.id, lane: 'service', id: ids.get(id)! })))
      const lanes={lexical:fuseMemoryFileHits(lexical,[]),vector:fuseMemoryFileHits([],vector),fused}
      const measures=Object.fromEntries(Object.entries(lanes).map(([lane,hits])=>{
        const eligible=hits.filter(hit=>hit.score>=evaluationGates.minScore)
        const presented=selectMemoryFileHits(hits,{limit:5,minScore:evaluationGates.minScore})
        for(const hit of presented) {
          const view=policy.read(hit.file.workspace,hit.file.path)
          if(!view?.currentMarkdown || view.currentMarkdown.slice(hit.startOffset,hit.endOffset)!==hit.text
            || !readMemoryLines(view.currentMarkdown,hit.startLine,hit.endLine).includes(hit.text.replace(/(?:\r\n|\r|\n)$/u,''))) {
            sourceSliceErrors++;sliceFailures.push({query:query.id,lane,id:ids.get(hit.file.id)!})
          }
        }
        const summaries=presented.map(summarize),candidates=eligible.map(summarize)
        return [lane,{hit1:query.evidence.some(label=>covered(summaries.slice(0,1),label)),hit5:query.evidence.some(label=>covered(summaries,label)),
          candidateRecall:query.evidence.some(label=>covered(candidates,label)),allEvidenceHit5:query.evidence.length>0 && query.evidence.every(label=>covered(summaries,label)),
          top:summaries,candidateIds:candidates.map(hit=>hit.id)}]
      })) as Record<'lexical'|'vector'|'fused',{hit1:boolean,hit5:boolean,candidateRecall:boolean,allEvidenceHit5:boolean,top:HitSummary[],candidateIds:string[]}>
      const leaks=(query.forbidden ?? []).filter(label=>actualHits.some(hit=>hit.id===label.id || hit.text.includes(label.quote)
        || [...hit.inlinks.neighbors,...hit.outlinks.neighbors].some(neighbor=>ids.get(neighbor.id)===label.id)))
      cases.push({id:query.id,kind:query.kind,group:query.group,text:query.text,evidence:query.evidence,forbidden:query.forbidden,
        from:query.from,through:query.through,asOf:query.asOf,lanes:measures,serviceStatus:actual.status,reasons:actual.reasons,
        elapsedMs:queryTimes.at(-1)!,safetyLeaks:leaks,unauthorizedExposures:audited.unauthorized})
    }
    const answers=cases.filter(item=>item.kind==='answer'),absent=cases.filter(item=>item.kind==='absent'),ambiguous=cases.filter(item=>item.kind==='ambiguous')
    const metrics=Object.fromEntries((['lexical','vector','fused'] as const).map(lane=>[lane,{
      hit1:answers.filter(item=>item.lanes[lane].hit1).length,hit5:answers.filter(item=>item.lanes[lane].hit5).length,
      candidateRecall:answers.filter(item=>item.lanes[lane].candidateRecall).length,answerCount:answers.length,
      ambiguousAllHit5:ambiguous.filter(item=>item.lanes[lane].allEvidenceHit5).length,ambiguousCount:ambiguous.length,
      absentWithCandidates:absent.filter(item=>item.lanes[lane].top.length>0).length,absentCount:absent.length,
    }]))
    const groups=[...new Set(answers.map(item=>item.group!))].map(group=>{
      const items=answers.filter(item=>item.group===group),hits=items.filter(item=>item.lanes.fused.hit5).length
      return {group,hits,total:items.length,rate:hits/items.length,passed:hits/items.length>=evaluationGates.minimumGroupHit5}
    })
    const safetyLeaks=cases.reduce((sum,item)=>sum+item.safetyLeaks.length+item.unauthorizedExposures.length,0)
    const hit5=answers.filter(item=>item.lanes.fused.hit5).length
    // These probes are outside both frozen corpora. The absent cases above can still share a topic.
    const unrelatedProbes = ['解释一下引力波是怎么产生的', '怎样证明根号二是无理数？', '白棋如何应对西西里防御？',
      'How do I tune a violin?', 'What causes lunar eclipses?', 'How do coral polyps reproduce?']
    const unrelatedWithHits: string[] = []
    for (const query of unrelatedProbes) {
      const result = await retrieval.search({ query, allows })
      assert.ok(!result.reasons.some(reason => reason.startsWith('semantic-')), 'the Granite lane must run for unrelated probes')
      if (result.status !== 'empty' || result.hits.length) unrelatedWithHits.push(query)
    }
    const gate={unrelatedEmpty:unrelatedWithHits.length === 0,answerEvidenceHit5:hit5/answers.length>=evaluationGates.answerEvidenceHit5,groups:groups.every(item=>item.passed),sourceSlices:sourceSliceErrors===0,safety:safetyLeaks===0}
    return {evaluationKind:dataset === 'validation' ? 'validation' : evaluationKind,fixture:verification
      ? { version: 1, frozenAt: '2026-11-16', sha256: verification.fileHash, hashKind: 'source-file-bytes', dataSha256: verification.dataHash, dataEncoding: verification.dataEncoding }
      : evaluationFreeze,dataHash,model:{fingerprint:embedder.fingerprint,dimensions:embedder.dimensions,offline:true,fileVectorSpace:index.vectorState().space},
      runtime:{node:process.version,platform:process.platform,arch:process.arch},configuration:evaluationGates,
      corpus:{documents:documents.length,accepted:index.files(scopes).length,chunks:index.chunks(index.files(scopes)).length,
        tailDocuments:documents.filter(document=>Buffer.byteLength(document.body)>10_000).length},
      metrics,groups,unrelated:{total:unrelatedProbes.length,withHits:unrelatedWithHits},gate,passed:Object.values(gate).every(Boolean),sourceSliceErrors,sliceFailures,safetyLeaks,
      timings:{coldMs,indexMs,indexAttempts:attempts,queryP50Ms:percentile(queryTimes,0.5),queryP95Ms:percentile(queryTimes,0.95)},
      limitations:['This is real q8 retrieval, not real answer-generation evaluation.','No-answer candidate rate is not answerability or refusal accuracy.',
        'Trusted synthetic source-port fixtures feed the production read policy; storage/lifecycle correctness remains covered by integration tests.',
        'Old 20-document/13-answer diagnostics are excluded from every holdout metric.','Fused candidate recall uses the union of two fixed 25-hit lanes; final recall remains Top5.'],
      evidenceLabels:queries.map(query=>({id:query.id,evidence:query.evidence.map(label=>{
        const markdown=bodies.get(label.id)!,offset=markdown.indexOf(label.quote),lines=memoryDocumentLines(markdown)
        return {...label,startOffset:offset,endOffset:offset+label.quote.length,startLine:lines.findIndex(line=>line.startOffset<=offset && offset<line.endOffset)+1,
          endLine:lines.findIndex(line=>line.startOffset<=offset+label.quote.length-1 && offset+label.quote.length-1<line.endOffset)+1}
      })})),cases}
  } finally {retrieval.close();embedder.close();db.close()}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [modelRoot,runtimeRoot,output,...flags]=process.argv.slice(2)
  if(!modelRoot || !runtimeRoot) throw new Error('Usage: node scripts/memory-file-evaluation.ts <model-dir> <runtime-dir> [report.json]')
  if (flags.some(flag => flag !== '--regression' && flag !== '--data=validation')) throw new Error('Supported options: --regression --data=validation')
  const report=await runMemoryFileEvaluation(modelRoot,runtimeRoot,flags.includes('--regression') ? 'regression' : 'holdout',flags.includes('--data=validation') ? 'validation' : 'evaluation')
  const json=JSON.stringify(report,null,2)+'\n'
  if(output) writeFileSync(output,json)
  else console.log(json)
  console.error(JSON.stringify({dataHash:report.dataHash,metrics:report.metrics,groups:report.groups,gate:report.gate,passed:report.passed,timings:report.timings,output}))
  if(!report.passed) process.exitCode=1
}
