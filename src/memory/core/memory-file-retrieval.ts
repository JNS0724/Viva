import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { MEMORY_EMBEDDING_BATCH } from '../contracts/embedding.ts'
import type { MemoryEmbedder, MemoryEmbeddingInput } from '../contracts/embedding.ts'
import type { MemoryFileDependency } from '../contracts/records.ts'
import type { MemoryDocumentView } from './memory-document-read-policy.ts'
import type { MemoryFileIndex, MemoryFileIdentity, MemoryFileSnapshot, MemoryFileHit, MemoryFileChunkRef } from './ports/file-index.ts'
import { dailySearchLimit, rankDailyMemory } from './memory-daily-search.ts'
import { memoryFileLexicalQuery } from './search-tokens.ts'
import { memoryFileEmbeddingPassages, splitMemoryFileEmbeddingPassage } from './memory-file-passages.ts'
import type { MemoryFileEmbeddingPassage } from './memory-file-passages.ts'
import { parseMemoryMarkdown } from './memory-markdown.ts'
import { memoryDocumentLines, readMemoryLines } from './memory-document.ts'
import { memoryFileChunkKey, fuseMemoryFileHits, selectMemoryFileHits } from './memory-file-ranking.ts'
export { memoryFileChunkKey, fuseMemoryFileHits, selectMemoryFileHits } from './memory-file-ranking.ts'

export interface FileReadPolicy {
  read(workspace: string, path: string): MemoryDocumentView | null
  list(workspace: string): MemoryDocumentView[]
}
type Allows = (view: MemoryDocumentView) => boolean
export interface FileReadSet { files: MemoryFileDependency[], sourceIds: string[] }
export interface FileNeighbor { id: string, workspace: string, path: string, name: string, description: string }
export interface FileNeighbors { neighbors: FileNeighbor[], visibleCount: number, partial: boolean }
export interface FileApplicability {
  state: MemoryDocumentView['applicability']['state']
  supersessions: Array<{ startLine: number, endLine: number, condition?: string, time?: string,
    replacement?: { id: string, path: string, revision: string, state: MemoryDocumentView['applicability']['state'] }, replacementUnavailable?: true }>
}
export interface FileSearchHit {
  id: string, workspace: string, path: string, revision: string
  startLine: number, endLine: number, text: string
  /** Fixed weighted RRF, not confidence. Coverage/diversity order need not descend by score. */
  score: number
  applicability: FileApplicability
  inlinks: FileNeighbors, outlinks: FileNeighbors
  /** Only a locator fits the response; read the cited lines before using their content. */
  readRequired?: true
}
export interface FileSearchResult extends FileReadSet {
  status: 'ok' | 'empty' | 'exhausted' | 'unavailable'
  hits: FileSearchHit[]
  reasons: string[]
  partial: boolean
}
export interface FileSearchRequest {
  query: string, limit?: number, minScore?: number, from?: string, through?: string, asOf?: number
  contextKey?: string, maxChars?: number, allows: Allows, signal?: AbortSignal
}
const identityKey = (file: {workspace: string, id: string}) => JSON.stringify([file.workspace, file.id])
const sameVersion = (a: MemoryFileIdentity, b: MemoryDocumentView) => a.id === b.id && a.path === b.path
  && a.revision === b.revision && a.usageVersion === b.usageVersion && a.policyToken === b.policyToken
const dependency = ({workspace,id,path,revision,usageVersion,policyToken}: MemoryDocumentView): MemoryFileDependency =>
  ({workspace,id,path,revision,usageVersion,policyToken})

export { memoryFileLexicalQuery } from './search-tokens.ts'

/** Shared file retrieval. No filesystem, database, transport or host state crosses this layer. */
export function createMemoryFileRetrieval({ index, policy, workspaces, hash, embedder, resolveAlias }: {
  index: MemoryFileIndex, policy: FileReadPolicy, workspaces(): string[], hash(text: string): string,
  embedder?: MemoryEmbedder | null, now?: () => number, resolveAlias?(workspace: string, path: string): string | null,
}) {
  let closed = false
  let preparing = false
  const controllers = new Set<AbortController>()
  const returned = new Map<string, Set<string>>()
  const space = () => ({ fingerprint: `${embedder!.fingerprint}:file-passages-context-v2`, dimensions: embedder!.dimensions })
  const current = (file: MemoryFileIdentity, allows?: Allows) => {
    const view = policy.read(file.workspace, file.path)
    return view && sameVersion(file, view) && (!allows || allows(view)) ? view : null
  }
  function sync() {
    let accepted = 0, removed = 0
    if (closed) return { accepted, removed }
    const scopes = [...new Set(workspaces())]
    const visible = new Set<string>()
    for (const workspace of scopes) for (const view of policy.list(workspace)) {
      if (view.currentMarkdown === null) continue
      try {
        const old = index.snapshot(workspace, view.id)
        if (old && sameVersion(old, view) && old.updatedAt === view.updatedAt && old.day === view.day) {
          visible.add(identityKey(old))
          continue
        }
        const parsed = parseMemoryMarkdown(view.currentMarkdown)
        const usableMetadata = view.applicability.state === 'current'
        const snapshot: MemoryFileSnapshot = {
          workspace, id: view.id, path: view.path, revision: view.revision, usageVersion: view.usageVersion,
          policyToken: view.policyToken, kind: view.kind, ...(view.day ? { day: view.day } : {}), updatedAt: view.updatedAt,
          sources: view.sourceTokens, name: usableMetadata && typeof parsed.metadata.name === 'string' ? parsed.metadata.name : '',
          description: usableMetadata && typeof parsed.metadata.description === 'string' ? parsed.metadata.description : '',
          chunks: parsed.chunks.filter(chunk => Boolean(chunk.text.trim())), links: parsed.links,
        }
        if (!old || JSON.stringify(old) !== JSON.stringify(snapshot)) {
          if (!index.accept(snapshot, old)) continue
          accepted++
        }
        visible.add(identityKey(snapshot))
      } catch { /* Malformed/external material remains quarantined; prior projections are removed below. */ }
    }
    for (const file of index.files(scopes)) if (!visible.has(identityKey(file)) && index.remove(file)) removed++
    return { accepted, removed }
  }
  function authorized(allows: Allows, request?: Pick<FileSearchRequest, 'from' | 'through' | 'asOf'>) {
    return index.files(workspaces()).filter(file => {
      if (!current(file, allows)) return false
      if (file.kind === 'daily' && file.day && (request?.from && file.day < request.from || request?.through && file.day > request.through)) return false
      return request?.asOf === undefined || !file.updatedAt || file.updatedAt <= request.asOf
    })
  }
  function readSet(views: readonly MemoryDocumentView[]): FileReadSet {
    const files = new Map<string, MemoryFileDependency>(), sourceIds = new Set<string>()
    for (const view of views) {
      files.set(identityKey(view), dependency(view))
      view.sourceTokens.forEach(source => sourceIds.add(source.id))
      // Replacement state is a dynamic dependency even when its body was not expanded.
      for (const support of view.supporting) {
        const replacement = policy.read(view.workspace, support.path)
        if (replacement) files.set(identityKey(replacement), dependency(replacement))
      }
    }
    return { files: [...files.values()], sourceIds: [...sourceIds] }
  }
  function applicability(view: MemoryDocumentView, allows: Allows): FileApplicability {
    return { state: view.applicability.state, supersessions: view.applicability.supersessions.map(item => {
      const support = view.supporting.find(candidate => candidate.id === item.documentId)
      const replacement = support && policy.read(view.workspace, support.path)
      const base = { startLine: item.startLine, endLine: item.endLine }
      return replacement && allows(replacement)
        ? { ...base, condition: item.condition, time: item.time, replacement: { id: replacement.id, path: replacement.path, revision: replacement.revision, state: replacement.applicability.state } }
        : { ...base, replacementUnavailable: true as const }
    }) }
  }
  function expand(file: MemoryFileIdentity, allowed: readonly MemoryFileIdentity[]) {
    const snapshots = allowed.flatMap(item => index.snapshot(item.workspace, item.id) ?? [])
    const root = snapshots.find(item => identityKey(item) === identityKey(file))
    const canonicalPath = (workspace: string, path: string) => resolveAlias?.(workspace, path) ?? path
    const target = (workspace: string, path: string) => snapshots.find(item => item.workspace === workspace && item.path === canonicalPath(workspace, path))
    const outgoing = [...new Map((root?.links ?? []).flatMap(link => {
      const to = target(file.workspace, link.path)
      return to ? [[identityKey(to), to] as const] : []
    })).values()]
    const incoming = snapshots.filter(candidate => candidate.workspace === file.workspace && candidate.links.some(link => canonicalPath(candidate.workspace, link.path) === file.path))
    const view = (rows: MemoryFileSnapshot[]): FileNeighbors => ({ visibleCount: rows.length, partial: rows.length > 10,
      neighbors: rows.slice(0, 10).map(({id,workspace,path,name,description}) => ({id,workspace,path,name,description})) })
    return { inlinks: view(incoming), outlinks: view(outgoing), dependencies: [...incoming, ...outgoing] }
  }
  function scopedController(signal?: AbortSignal) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, defaults.requestTimeoutMs)
    controllers.add(controller)
    return { controller, done() { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(controller) } }
  }
  async function encode(inputs: readonly MemoryEmbeddingInput[], signal: AbortSignal) {
    if (!embedder || closed || signal.aborted) return null
    let onAbort: () => void = () => {}
    const stopped = new Promise<null>(resolve => { onAbort = () => resolve(null); signal.addEventListener('abort', onAbort, { once: true }) })
    try { return await Promise.race([embedder.embedBatch(inputs, signal), stopped]) } catch { return null }
    finally { signal.removeEventListener('abort', onAbort) }
  }
  async function prepareVectors(signal?: AbortSignal) {
    if (!embedder || closed || preparing || signal?.aborted) return false
    preparing = true
    const run = scopedController(signal)
    try {
      const generation = index.beginVectors(space())
      const files = index.files(workspaces())
      if (files.some(file => !current(file))) return false
      const expected = index.chunks(files).map(chunk => chunk.ref)
      for (const chunk of index.missingVectors(generation)) {
        if (closed || run.controller.signal.aborted || !current(chunk.file)) return false
        const vectors: Float32Array[] = []
        const snapshot = index.snapshot(chunk.file.workspace, chunk.file.id)
        if (!snapshot) return false
        const passages = memoryFileEmbeddingPassages(chunk, snapshot.name)
        if (!passages) return false
        const retrySplit = async (input: MemoryFileEmbeddingPassage): Promise<Float32Array[] | null> => {
          const parts = splitMemoryFileEmbeddingPassage(input)
          if (!parts) return null
          const recovered: Float32Array[] = []
          for (const part of parts) {
            if (closed || run.controller.signal.aborted || !current(chunk.file)) return null
            const retry = await encode([{kind: 'passage', text: part.text}], run.controller.signal)
            if (!retry || retry.length !== 1 || closed || run.controller.signal.aborted || !current(chunk.file)) return null
            if (retry[0]) recovered.push(retry[0])
            else {
              const smaller = await retrySplit(part)
              if (!smaller) return null
              recovered.push(...smaller)
            }
          }
          return recovered
        }
        for (let offset = 0; offset < passages.length; offset += MEMORY_EMBEDDING_BATCH) {
          if (closed || run.controller.signal.aborted || !current(chunk.file)) return false
          const batch = passages.slice(offset, offset + MEMORY_EMBEDDING_BATCH)
          const result = await encode(batch.map(part => ({ kind: 'passage', text: part.text })), run.controller.signal)
          if (!result || result.length !== batch.length || closed || run.controller.signal.aborted || !current(chunk.file)) return false
          for (const [position, vector] of result.entries()) {
            if (vector) vectors.push(vector)
            else {
              const retry = await retrySplit(batch[position]!)
              if (!retry) return false
              vectors.push(...retry)
            }
          }
        }
        if (!vectors.length || closed || run.controller.signal.aborted || !current(chunk.file) || index.stageVectors(generation, [{ref:chunk.ref,vectors}]) !== 1) return false
      }
      if (closed || run.controller.signal.aborted || files.some(file => !current(file))) return false
      return index.finishVectors(generation, expected)
    } catch { return false }
    finally { run.done(); preparing = false }
  }
  function unavailable(reason: string): FileSearchResult { return { status:'unavailable', hits:[], files:[], sourceIds:[], reasons:[reason], partial:true } }
  function checkedLimit(limit?: number) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('invalid-memory-file-limit')
    return dailySearchLimit(limit)
  }
  function checkedDate(value: string | undefined) {
    if (value === undefined) return
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('invalid-memory-file-date')
  }
  function beginSearch(request: FileSearchRequest) {
    if (!request.query.trim() || (request.minScore ?? 0) < 0 || !Number.isFinite(request.minScore ?? 0) || request.asOf !== undefined && !Number.isFinite(request.asOf)) throw new Error('invalid-memory-file-search')
    checkedDate(request.from); checkedDate(request.through)
    if (request.from && request.through && request.from > request.through) throw new Error('invalid-memory-file-date')
    const limit = checkedLimit(request.limit)
    const minimumBudget = JSON.stringify({ status: 'unavailable', hits: [], reasons: ['semantic-index-incomplete', 'full-text-fallback', 'candidate-limit', 'output-budget'], partial: true }).length
    if (request.maxChars !== undefined && (!Number.isSafeInteger(request.maxChars) || request.maxChars < minimumBudget)) throw new Error('invalid-memory-file-output-budget')
    sync()
    const allowed = authorized(request.allows, request)
    const candidates = Math.min(defaults.searchMaxCandidates, limit * defaults.searchCandidateMultiplier)
    const lexical = index.lexical(memoryFileLexicalQuery(request.query), allowed, candidates)
    const reasons = lexical.mode === 'fallback' ? ['full-text-fallback'] : []
    return { allowed, limit, candidates, lexical, reasons }
  }
  function finishSearch(request: FileSearchRequest, plan: ReturnType<typeof beginSearch>, vector: MemoryFileHit[]): FileSearchResult {
    const { allowed, limit, candidates, lexical, reasons } = plan
    if (closed || request.signal?.aborted) return unavailable('cancelled')
    if (allowed.some(file => !current(file, request.allows))) return unavailable('file-changed')
    const ranked = fuseMemoryFileHits(lexical.hits, vector).filter(hit => hit.score >= (request.minScore ?? defaults.searchMinScore))
    if (lexical.hits.length === candidates || vector.length === candidates) reasons.push('candidate-limit')
    const context = request.contextKey ? hash(JSON.stringify([request.contextKey, request.query, request.from, request.through, request.asOf,
      request.minScore, allowed.map(file => [file.workspace,file.id,file.revision,file.usageVersion,file.policyToken])])) : null
    const seen = context ? returned.get(context) ?? new Set<string>() : new Set<string>()
    const remaining = ranked.filter(hit => !seen.has(memoryFileChunkKey(hit.ref)))
    const selected = selectMemoryFileHits(ranked, { limit, seen })
    const views: MemoryDocumentView[] = []
    const hits: FileSearchHit[] = []
    const delivered: MemoryFileChunkRef[] = []
    let budgetLimited = false
    // Reserve the reason/partial envelope before admitting a hit. Public JSON excludes
    // the private dispatch readset; the caller must not truncate an already-admitted hit.
    const fits = (proposed: FileSearchHit[]) => request.maxChars === undefined || JSON.stringify({
      status: 'ok', hits: proposed, reasons: [...reasons, 'output-budget'], partial: true,
    }).length <= request.maxChars
    for (const hit of selected) {
      const view = current(hit.file, request.allows)
      if (!view) continue
      const related = expand(hit.file, allowed)
      const candidate: FileSearchHit = {id:view.id,workspace:view.workspace,path:view.path,revision:view.revision,startLine:hit.startLine,endLine:hit.endLine,
        text:hit.text,score:hit.score,applicability:applicability(view, request.allows),inlinks:related.inlinks,outlinks:related.outlinks}
      if (fits([...hits, candidate])) {
        hits.push(candidate)
        delivered.push(hit.ref)
        views.push(view, ...related.dependencies.flatMap(file => current(file, request.allows) ?? []))
        continue
      }
      budgetLimited = true
      if (!hits.length) {
        const countsOnly = (neighbors: FileNeighbors): FileNeighbors => ({ neighbors: [], visibleCount: neighbors.visibleCount, partial: neighbors.visibleCount > 0 })
        const locator: FileSearchHit = { ...candidate, text: '', readRequired: true,
          inlinks: countsOnly(candidate.inlinks), outlinks: countsOnly(candidate.outlinks) }
        if (fits([locator])) {
          hits.push(locator)
          views.push(view, ...related.dependencies.flatMap(file => current(file, request.allows) ?? []))
        }
      }
      break
    }
    if (budgetLimited) reasons.push('output-budget')
    if (context) {
      delivered.forEach(ref => seen.add(memoryFileChunkKey(ref)))
      returned.set(context, seen)
      if (returned.size > 128) returned.delete(returned.keys().next().value!)
    }
    return {status:hits.length || budgetLimited ? 'ok' : ranked.length && context ? 'exhausted' : 'empty',hits,...readSet(views),
      reasons,partial:remaining.length > limit || lexical.hits.length === candidates || vector.length === candidates || reasons.length > 0}
  }
  function searchCached(request: FileSearchRequest): FileSearchResult {
    if (closed || request.signal?.aborted) return unavailable('cancelled')
    const plan = beginSearch(request)
    if (embedder) plan.reasons.push('semantic-not-run')
    return finishSearch(request, plan, [])
  }
  async function search(request: FileSearchRequest): Promise<FileSearchResult> {
    if (closed || request.signal?.aborted) return unavailable('cancelled')
    const plan = beginSearch(request)
    const { allowed, candidates, reasons } = plan
    let vector: MemoryFileHit[] = []
    if (embedder && allowed.length) {
      const run = scopedController(request.signal)
      try {
        const generation = index.beginVectors(space())
        const needsPreparation = !index.vectorState().active || index.missingVectors(generation).length > 0
        const ready = !needsPreparation || await prepareVectors(run.controller.signal)
        if (ready && !run.controller.signal.aborted && index.vectorState().active) {
          const output = await encode([{kind:'query',text:request.query}], run.controller.signal)
          if (output?.[0] && !run.controller.signal.aborted) {
            const hits = index.vector(output[0], space(), allowed, candidates)
            if (hits) vector = hits
            else reasons.push('semantic-unavailable')
          } else reasons.push('semantic-unavailable')
        } else reasons.push('semantic-index-incomplete')
      } catch { reasons.push('semantic-unavailable') }
      finally { run.done() }
    }
    return finishSearch(request, plan, vector)
  }
  /** Existing passage vectors only: this path never embeds or enables a different space.
   * The caller applies its mixed-corpus candidate budget after receiving these scores. */
  function indexedScores(query: Float32Array, authorized: readonly MemoryFileIdentity[]): ReadonlyMap<string, number> {
    if (closed || !embedder) return new Map()
    try {
      const allowed = authorized.filter(file => workspaces().includes(file.workspace) && current(file))
      const count = index.chunks(allowed).length
      if (!count) return new Map()
      const hits = index.vector(query, space(), allowed, count)
      return new Map((hits ?? []).filter(hit => current(hit.file)).map(hit => [memoryFileChunkKey(hit.ref), hit.score]))
    } catch { return new Map() }
  }
  function resolve(input: {id?:string,workspace?:string,path?:string,allows:Allows}) {
    if (input.workspace && !workspaces().includes(input.workspace)) return null
    if (input.workspace && input.path) { const view=policy.read(input.workspace,resolveAlias?.(input.workspace,input.path) ?? input.path); return view && (!input.id || view.id===input.id) && input.allows(view) ? view : null }
    if (!input.id) throw new Error('invalid-memory-file-read')
    const found=(input.workspace ? [input.workspace] : workspaces()).flatMap(workspace=>policy.list(workspace)).filter(view=>view.id===input.id && input.allows(view))
    return found.length===1 ? found[0]! : null
  }
  function read(input: {id?:string,workspace?:string,path?:string,startLine?:number,endLine?:number,evidence?:boolean,allows:Allows}) {
    if (closed) return null
    const view=resolve(input)
    if (!view) return null
    const markdown=input.evidence ? view.markdown : view.currentMarkdown
    if (markdown===null) return null
    const lineCount = memoryDocumentLines(markdown).length
    const startLine=input.startLine ?? 1, endLine=Math.min(input.endLine ?? lineCount,lineCount)
    const text=readMemoryLines(markdown,startLine,input.endLine)
    if (startLine > lineCount) return null
    return {id:view.id,workspace:view.workspace,path:view.path,revision:view.revision,startLine,endLine,text,
      applicability:applicability(view,input.allows),...readSet([view])}
  }
  function nodeSearch(input: {query:string,limit?:number,allows:Allows}) {
    if (closed) return {nodes:[],files:[],sourceIds:[],partial:false}
    if (!input.query.trim()) throw new Error('invalid-memory-file-search')
    const limit = checkedLimit(input.limit)
    sync()
    const rows=authorized(input.allows).flatMap(file=>{
      const view=current(file,input.allows), snapshot=index.snapshot(file.workspace,file.id)
      return view?.kind==='digest' && view.applicability.state==='current' && snapshot
        ? [{key:identityKey(file),text:`${snapshot.name}\n${snapshot.description}`,file,snapshot,view}] : []
    })
    const ranked=rankDailyMemory(rows,memoryFileLexicalQuery(input.query),limit,0)
    return {nodes:ranked.hits.map(({document,score})=>({id:document.file.id,workspace:document.file.workspace,path:document.file.path,
      name:document.snapshot.name,description:document.snapshot.description,score})),...readSet(ranked.hits.map(hit=>hit.document.view)),partial:ranked.partial}
  }
  function relations(input:{workspace:string,path:string,allows:Allows}) {
    if (closed) return null
    sync()
    const allowed=authorized(input.allows), file=allowed.find(file=>file.workspace===input.workspace && file.path===(resolveAlias?.(input.workspace,input.path) ?? input.path))
    if (!file) return null
    const result=expand(file,allowed)
    return {inlinks:result.inlinks,outlinks:result.outlinks,...readSet([file,...result.dependencies].flatMap(item=>current(item,input.allows) ?? []))}
  }
  return {sync,search,searchCached,read,nodeSearch,relations,prepareVectors,indexedScores,
    reindex:()=>{ if (closed) throw new Error('memory-file-retrieval-closed'); return index.reindex() },
    close(){closed=true;controllers.forEach(controller=>controller.abort());returned.clear()},
  }
}
