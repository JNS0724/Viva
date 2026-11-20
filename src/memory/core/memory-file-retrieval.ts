import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { beginDiagnosticOperation, observeDiagnosticSync } from '../../diagnostics/operation.ts'
import type { DiagnosticPort } from '../../diagnostics/contracts.ts'
import { MEMORY_EMBEDDING_BATCH } from '../contracts/embedding.ts'
import type { MemoryEmbedder, MemoryEmbeddingInput } from '../contracts/embedding.ts'
import type { MemoryFileDependency } from '../contracts/records.ts'
import { fileDependency, type MemoryDocumentReadBatch, type MemoryDocumentView } from './memory-document-read-policy.ts'
import { createRequestBudget, RequestTimeout } from '../../shared/request-budget.ts'
import type { MemoryFileIndex, MemoryFileIdentity, MemoryFileSnapshot, MemoryFileHit, MemoryFileChunkRef, MemoryFileQueryScope, MemoryFileNode } from './ports/file-index.ts'
import { dailySearchLimit, rankDailyMemory } from './memory-daily-search.ts'
import { memoryFileLexicalQuery, memoryIdentifierTokens, memorySearchTokens } from './search-tokens.ts'
import { memoryFileEmbeddingPassages, splitMemoryFileEmbeddingPassage } from './memory-file-passages.ts'
import type { MemoryFileEmbeddingPassage } from './memory-file-passages.ts'
import { parseMemoryMarkdown } from './memory-markdown.ts'
import { memoryDocumentLines, readMemoryLines } from './memory-document.ts'
import { memoryFileChunkKey, fuseMemoryFileHits, selectMemoryFileHits } from './memory-file-ranking.ts'
export { memoryFileChunkKey, fuseMemoryFileHits, selectMemoryFileHits } from './memory-file-ranking.ts'

export interface FileReadPolicy {
  read(workspace: string, path: string): MemoryDocumentView | null
  list(workspace: string): MemoryDocumentView[]
  readBatch?(signal?: AbortSignal): MemoryDocumentReadBatch | undefined
}
type Allows = (view: MemoryDocumentView) => boolean
type FileLookup = {id?:string,workspace?:string,workspaces?: string[],path?:string,allows:Allows}
type FileReadInput = FileLookup & {startLine?:number,endLine?:number,evidence?:boolean,signal?:AbortSignal}
type NodeSearchInput = {workspaces?: readonly string[],query:string,limit?:number,allows:Allows,signal?:AbortSignal}
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
  workspaces?: readonly string[]
  query: string, limit?: number, minScore?: number, from?: string, through?: string, asOf?: number
  contextKey?: string, maxChars?: number, allows: Allows, signal?: AbortSignal
  /** Automatic context must yield quickly and may omit weak evidence. */
  automatic?: boolean
  /** During Dream an explicit recall can use published vectors without waiting for a rebuild. */
  publishedVectorsOnly?: boolean
}
const identityKey = (file: {workspace: string, id: string}) => JSON.stringify([file.workspace, file.id])
type IndexedVersion = Pick<MemoryFileIdentity, 'workspace' | 'id' | 'path' | 'revision' | 'usageVersion' | 'policyToken'>
const sameVersion = (a: IndexedVersion, b: IndexedVersion) => a.workspace === b.workspace && a.id === b.id && a.path === b.path
  && a.revision === b.revision && a.usageVersion === b.usageVersion && a.policyToken === b.policyToken
export { memoryFileLexicalQuery } from './search-tokens.ts'

/** Shared file retrieval. No filesystem, database, transport or host state crosses this layer. */
export function createMemoryFileRetrieval({ index, policy, workspaces, hash, embedder, resolveAlias, aliasesFor, resolveId, usePublishedIndex = false, onStale, diagnostics }: {
  index: MemoryFileIndex, policy: FileReadPolicy, workspaces(): string[], hash(text: string): string,
  embedder?: MemoryEmbedder | null, now?: () => number, resolveAlias?(workspace: string, path: string): string | null,
  aliasesFor?(workspace: string, canonicalPath: string): readonly string[],
  resolveId?(workspace: string, id: string): string | null,
  usePublishedIndex?: boolean,
  onStale?(file: MemoryFileIdentity): void,
  diagnostics?: DiagnosticPort,
}) {
  let closed = false
  let preparing = false
  let vectorCheckPending = true
  let publicationRevision = 0
  let scheduledPreparation: ReturnType<typeof setTimeout> | undefined
  const controllers = new Set<AbortController>()
  const returned = new Map<string, Set<string>>()
  const space = () => ({ fingerprint: `${embedder!.fingerprint}:file-passages-context-v2`, dimensions: embedder!.dimensions })
  function readable(workspace: string, path: string) {
    try { return policy.read(workspace, path) } catch { return null }
  }
  const current = (file: MemoryFileIdentity, allows?: Allows) => {
    const view = readable(file.workspace, file.path)
    return view && sameVersion(file, view) && (!allows || allows(view)) ? view : null
  }
  function project(view: MemoryDocumentView): MemoryFileSnapshot | null {
    if (view.currentMarkdown === null) return null
    const parsed = parseMemoryMarkdown(view.currentMarkdown)
    const usableMetadata = view.applicability.state === 'current'
    return {
      workspace: view.workspace, id: view.id, path: view.path, revision: view.revision, usageVersion: view.usageVersion,
      policyToken: view.policyToken, kind: view.kind, ...(view.day ? { day: view.day } : {}), updatedAt: view.updatedAt,
      sources: view.sourceTokens, name: usableMetadata && typeof parsed.metadata.name === 'string' ? parsed.metadata.name : '',
      description: usableMetadata && typeof parsed.metadata.description === 'string' ? parsed.metadata.description : '',
      ...(view.kind === 'digest' && usableMetadata && { tags: Array.isArray(parsed.metadata.memory_tags) ? parsed.metadata.memory_tags.filter((tag): tag is string => typeof tag === 'string') : [] }),
      chunks: parsed.chunks.filter(chunk => Boolean(chunk.text.trim())), links: parsed.links,
    }
  }
  function publishSnapshot(snapshot: MemoryFileSnapshot) {
    const old = index.snapshot(snapshot.workspace, snapshot.id)
    if (old && sameVersion(old, snapshot) && old.updatedAt === snapshot.updatedAt && old.day === snapshot.day && (!snapshot.tags || old.tags)) return false
    return index.accept(snapshot, old) ? true : null
  }
  function published(accepted: number, removed: number) {
    if (accepted || removed) {
      vectorCheckPending = true
      publicationRevision++
      if (usePublishedIndex) prepareAfterSearch()
    }
    return { accepted, removed }
  }
  /** Read and parse before the caller starts the short transaction that clears its pending rows. */
  function preparePublication(files: readonly { workspace: string, path: string, view: MemoryDocumentView | null }[]) {
    const publications = files.map(({ workspace, path, view }) => ({ workspace, path, snapshot: view && project(view) }))
    return () => {
      let accepted = 0, removed = 0
      if (closed) return { accepted, removed }
      for (const { workspace, path, snapshot } of publications) {
        const old = index.nodeAt(workspace, path)
        if (old && snapshot?.id !== old.id && index.remove(old)) removed++
        if (snapshot && publishSnapshot(snapshot)) accepted++
      }
      return published(accepted, removed)
    }
  }
  // A dependent write can publish this path under another effect key while a
  // lazy repair is reading the file. Only repair the projection we observed.
  function watchProjection(workspace: string, path: string) {
    const before = index.nodeAt(workspace, path)
    return () => {
      const current = index.nodeAt(workspace, path)
      return before && current ? sameVersion(before, current) : before === current
    }
  }
  function publishFiles(files: readonly { workspace: string, path: string }[]) {
    if (closed) return { accepted: 0, removed: 0 }
    const publications = files.map(file => ({ ...file, view: policy.read(file.workspace, file.path) }))
    return preparePublication(publications)()
  }
  function sync() {
    let accepted = 0, removed = 0
    if (closed) return { accepted, removed }
    const scopes = [...new Set(workspaces())]
    const visible = new Set<string>()
    for (const workspace of scopes) for (const view of policy.list(workspace)) {
      try {
        const old = index.nodeAt(view.workspace, view.path)
        if (view.currentMarkdown === null) continue
        if (old && sameVersion(old, view) && old.updatedAt === view.updatedAt && old.day === view.day
          && (view.kind !== 'digest' || view.applicability.state !== 'current' || old.tags)) {
          visible.add(identityKey(view))
          continue
        }
        const snapshot = project(view)
        if (!snapshot) continue
        const result = publishSnapshot(snapshot)
        if (result === null) continue
        if (result) accepted++
        visible.add(identityKey(view))
      } catch { /* Malformed/external material remains quarantined; prior projections are removed below. */ }
    }
    for (const file of index.files(scopes)) if (!visible.has(identityKey(file)) && index.remove(file)) removed++
    return published(accepted, removed)
  }
  function inDateRange(file: MemoryFileIdentity, request: Pick<FileSearchRequest, 'from' | 'through' | 'asOf'>) {
    if (file.kind === 'daily' && file.day && (request.from && file.day < request.from || request.through && file.day > request.through)) return false
    return request.asOf === undefined || !file.updatedAt || file.updatedAt <= request.asOf
  }
  function searchScope(request: Pick<FileSearchRequest, 'from' | 'through' | 'asOf' | 'workspaces'> = {}): MemoryFileQueryScope {
    const { from, through, asOf } = request
    return { workspaces: request.workspaces ?? [...new Set(workspaces())], from, through, asOf }
  }
  function authorized(allows: Allows, scope: MemoryFileQueryScope) {
    return index.files(scope.workspaces).filter(file => inDateRange(file, scope) && current(file, allows))
  }
  function candidateProbe(limit: number) {
    return Math.max(32, limit * 2)
  }
  function verifier(allows: Allows, timedOut: () => boolean = () => false, batch?: MemoryDocumentReadBatch, reportStale = true) {
    const checked = new Map<string, MemoryDocumentView | null>()
    let stale = false
    function verify(file: MemoryFileIdentity) {
      if (timedOut()) { stale = true; return null }
      const key = JSON.stringify([file.workspace, file.id, file.path, file.revision, file.usageVersion, file.policyToken])
      if (!checked.has(key)) {
        const view = batch ? batch.readObservation(file.workspace, file.path) : readable(file.workspace, file.path)
        if (!view || view.currentMarkdown === null || !sameVersion(file, view)) {
          stale = true
          checked.set(key, null)
          if (usePublishedIndex && reportStale && view !== undefined) {
            try { onStale?.(file) } catch { /* Publishing recovery is separate from the verified read. */ }
          }
        } else checked.set(key, allows(view) ? view : null)
      }
      return checked.get(key) ?? null
    }
    return { verify, incomplete: () => stale }
  }
  function readSet(views: readonly MemoryDocumentView[], read = readable): FileReadSet {
    const files = new Map<string, MemoryFileDependency>(), sourceIds = new Set<string>()
    for (const view of views) {
      files.set(identityKey(view), fileDependency(view))
      view.sourceTokens.forEach(source => sourceIds.add(source.id))
      // Replacement state is a dynamic dependency even when its body was not expanded.
      for (const support of view.supporting) {
        const replacement = read(view.workspace, support.path)
        if (replacement) files.set(identityKey(replacement), fileDependency(replacement))
      }
    }
    return { files: [...files.values()], sourceIds: [...sourceIds] }
  }
  function applicability(view: MemoryDocumentView, allows: Allows, read = readable): FileApplicability {
    return { state: view.applicability.state, supersessions: view.applicability.supersessions.map(item => {
      const support = view.supporting.find(candidate => candidate.id === item.documentId)
      const replacement = support && read(view.workspace, support.path)
      const base = { startLine: item.startLine, endLine: item.endLine }
      return replacement && allows(replacement)
        ? { ...base, condition: item.condition, time: item.time, replacement: { id: replacement.id, path: replacement.path, revision: replacement.revision, state: replacement.applicability.state } }
        : { ...base, replacementUnavailable: true as const }
    }) }
  }
  function expand(file: MemoryFileIdentity, allowed: readonly MemoryFileIdentity[],
    verify: (file: MemoryFileIdentity) => MemoryDocumentView | null) {
    const snapshots = allowed.flatMap(item => index.snapshot(item.workspace, item.id) ?? [])
    const root = snapshots.find(item => identityKey(item) === identityKey(file))
    const canonicalPath = (workspace: string, path: string) => resolveAlias?.(workspace, path) ?? path
    const target = (workspace: string, path: string) => snapshots.find(item => item.workspace === workspace && item.path === canonicalPath(workspace, path))
    const outgoing = [...new Map((root?.links ?? []).flatMap(link => {
      const to = target(file.workspace, link.path)
      return to ? [[identityKey(to), to] as const] : []
    })).values()]
    const incoming = snapshots.filter(candidate => candidate.workspace === file.workspace && candidate.links.some(link => canonicalPath(candidate.workspace, link.path) === file.path))
    const dependencies: MemoryDocumentView[] = []
    const view = (rows: MemoryFileSnapshot[]): FileNeighbors => {
      const visible = rows.filter(node => {
        const checked = verify(node)
        if (checked) dependencies.push(checked)
        return checked !== null
      })
      return { visibleCount: visible.length, partial: visible.length > 10,
        neighbors: visible.slice(0, 10).map(({id,workspace,path,name,description}) => ({id,workspace,path,name,description})) }
    }
    return { inlinks: view(incoming), outlinks: view(outgoing), dependencies }
  }
  function publishedLinks(file: MemoryFileIdentity, scope: MemoryFileQueryScope) {
    const cap = 40
    const aliases = (aliasesFor?.(file.workspace, file.path) ?? []).filter(path => resolveAlias?.(file.workspace, path) === file.path)
    const incoming = index.linkingNodes(file.workspace, [file.path, ...aliases], cap)
    const targets = index.linkTargets(file, cap)
    const outgoing = new Map<string, MemoryFileNode>()
    for (const path of targets.rows) {
      const direct = index.nodeAt(file.workspace, path)
      const alias = !direct && resolveAlias?.(file.workspace, path)
      const target = direct ?? (alias ? index.nodeAt(file.workspace, alias) : null)
      if (target) outgoing.set(identityKey(target), target)
    }
    return {
      incoming: { rows: incoming.rows.filter(node => inDateRange(node, scope)), incomplete: incoming.incomplete },
      outgoing: { rows: [...outgoing.values()].filter(node => inDateRange(node, scope)), incomplete: targets.incomplete },
    }
  }
  function expandPublished(file: MemoryFileIdentity, scope: MemoryFileQueryScope,
    verify: (file: MemoryFileIdentity) => MemoryDocumentView | null) {
    const { incoming, outgoing } = publishedLinks(file, scope)
    const dependencies: MemoryDocumentView[] = []
    function accepted(nodes: readonly MemoryFileNode[], incomplete: boolean): FileNeighbors {
      const visible = nodes.flatMap(node => {
        const view = verify(node)
        if (!view) return []
        dependencies.push(view)
        const { id, workspace, path, name, description } = node
        return [{ id, workspace, path, name, description }]
      })
      return { neighbors: visible.slice(0, 10), visibleCount: visible.length, partial: incomplete || visible.length > 10 }
    }
    return { inlinks: accepted(incoming.rows, incoming.incomplete), outlinks: accepted(outgoing.rows, outgoing.incomplete), dependencies }
  }
  async function loadFiles(batch: MemoryDocumentReadBatch, files: readonly Pick<MemoryFileIdentity, 'workspace' | 'path'>[], milliseconds: number, signal?: AbortSignal) {
    if (!files.length || milliseconds <= 0 || signal?.aborted) return
    const budget = createRequestBudget(milliseconds, signal)
    try { await budget.run(() => batch.load(files, budget.signal)) }
    catch (error) { if (!(error instanceof RequestTimeout) && !signal?.aborted) throw error }
    finally { budget.close() }
  }
  function scopedController(signal?: AbortSignal, { keepWarm = false, deadline = true } = {}) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const parentAborted = () => {
      if (!(keepWarm && signal?.reason instanceof RequestTimeout)) abort()
    }
    signal?.addEventListener('abort', parentAborted, { once: true })
    if (signal?.aborted) parentAborted()
    const timer = deadline ? setTimeout(abort, defaults.requestTimeoutMs) : undefined
    controllers.add(controller)
    return { controller, done() { clearTimeout(timer); signal?.removeEventListener('abort', parentAborted); controllers.delete(controller) } }
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
    const observation = beginDiagnosticOperation(diagnostics, 'memory.index', { stage: 'rebuild' })
    let complete = false, staged = 0
    const revision = publicationRevision
    preparing = true
    const run = scopedController(signal, { deadline: false })
    // A large rebuild may take many batches. Each inference has its own deadline.
    const encodeBatch = async (inputs: readonly MemoryEmbeddingInput[]) => {
      const batch = scopedController(run.controller.signal)
      try { return await encode(inputs, batch.controller.signal) } finally { batch.done() }
    }
    const valid = (file: MemoryFileIdentity) => {
      const authoritative = usePublishedIndex ? index.nodeAt(file.workspace, file.path) : current(file)
      return authoritative !== null && sameVersion(file, authoritative)
    }
    try {
      const generation = index.beginVectors(space())
      const files = index.files(workspaces())
      if (!usePublishedIndex && files.some(file => !valid(file))) return false
      const expected = index.chunks(files).map(chunk => chunk.ref)
      observation.progress({ stage: 'vector', identities: { generation }, metrics: { count: expected.length } })
      for (const chunk of index.missingVectors(generation)) {
        if (closed || run.controller.signal.aborted || !valid(chunk.file)) return false
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
            if (closed || run.controller.signal.aborted || !valid(chunk.file)) return null
            const retry = await encodeBatch([{kind: 'passage', text: part.text}])
            if (!retry || retry.length !== 1 || closed || run.controller.signal.aborted || !valid(chunk.file)) return null
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
          if (closed || run.controller.signal.aborted || !valid(chunk.file)) return false
          const batch = passages.slice(offset, offset + MEMORY_EMBEDDING_BATCH)
          const result = await encodeBatch(batch.map(part => ({ kind: 'passage', text: part.text })))
          if (!result || result.length !== batch.length || closed || run.controller.signal.aborted || !valid(chunk.file)) return false
          for (const [position, vector] of result.entries()) {
            if (vector) vectors.push(vector)
            else {
              const retry = await retrySplit(batch[position]!)
              if (!retry) return false
              vectors.push(...retry)
            }
          }
        }
        if (!vectors.length || closed || run.controller.signal.aborted || !valid(chunk.file) || index.stageVectors(generation, [{ref:chunk.ref,vectors}]) !== 1) return false
        staged++
      }
      if (closed || run.controller.signal.aborted || !usePublishedIndex && files.some(file => !valid(file))) return false
      complete = index.finishVectors(generation, expected)
      vectorCheckPending = !complete
      return complete
    } catch (error) { observation.fail(error); return false }
    finally {
      observation.end(complete ? 'completed' : run.controller.signal.aborted ? 'cancelled' : 'failed', {
        stage: complete ? 'checkpoint' : 'unavailable', reason: complete ? 'normal' : run.controller.signal.aborted ? 'aborted' : 'unavailable',
        metrics: { completedCount: staged, ok: complete } })
      run.done(); preparing = false
      if (usePublishedIndex && publicationRevision !== revision) prepareAfterSearch()
    }
  }
  async function boundedQuery(query: string, timeoutMs: number, signal?: AbortSignal, keepWarm = false) {
    const run = scopedController(signal, { keepWarm })
    // Let an already-started worker finish warming up after the foreground budget
    // expires. Cancellation, shutdown and the normal inference deadline still apply.
    const encoded = encode([{ kind: 'query', text: query }], run.controller.signal).finally(() => {
      run.done()
      // The worker accepts one batch at a time, even after the caller's timeout.
      if (vectorCheckPending) prepareAfterSearch()
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([encoded, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  function prepareAfterSearch() {
    if (!embedder || closed || preparing || scheduledPreparation !== undefined) return
    scheduledPreparation = setTimeout(() => {
      scheduledPreparation = undefined
      void prepareVectors()
    }, 0)
    scheduledPreparation.unref?.()
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
  function beginSearch(request: FileSearchRequest, startedAt = performance.now()) {
    if (!request.query.trim() || (request.minScore ?? 0) < 0 || !Number.isFinite(request.minScore ?? 0) || request.asOf !== undefined && !Number.isFinite(request.asOf)) throw new Error('invalid-memory-file-search')
    checkedDate(request.from); checkedDate(request.through)
    if (request.from && request.through && request.from > request.through) throw new Error('invalid-memory-file-date')
    const limit = checkedLimit(request.limit)
    const minimumBudget = JSON.stringify({ status: 'unavailable', hits: [], reasons: ['semantic-index-incomplete', 'full-text-fallback', 'candidate-limit', 'file-changed', 'output-budget'], partial: true }).length
    if (request.maxChars !== undefined && (!Number.isSafeInteger(request.maxChars) || request.maxChars < minimumBudget)) throw new Error('invalid-memory-file-output-budget')
    const scope = searchScope(request)
    const candidates = Math.min(defaults.searchMaxCandidates, limit * defaults.searchCandidateMultiplier)
    const query = memoryFileLexicalQuery(request.query)
    if (usePublishedIndex) {
      const page = index.lexicalCandidates(query, scope, candidateProbe(candidates))
      const reasons = page.mode === 'fallback' ? ['full-text-fallback'] : []
      return { scope, allowed: undefined, limit, candidates, lexical: page.rows, lexicalIncomplete: page.incomplete, reasons, startedAt }
    }
    sync()
    const allowed = authorized(request.allows, scope)
    const lexical = index.lexical(query, allowed, candidates)
    const reasons = lexical.mode === 'fallback' ? ['full-text-fallback'] : []
    return { scope, allowed, limit, candidates, lexical: lexical.hits, reasons, startedAt }
  }
  function qualifyCandidates(request: FileSearchRequest, lexical: MemoryFileHit[], vector: MemoryFileHit[]) {
    if (!request.automatic) return { lexical, vector }
    // A reciprocal rank is positive even for orthogonal vectors. For unsolicited
    // context, qualify candidates on their original evidence before fusing ranks.
    const subject = request.query.trim().replace(/^(?:请(?:帮我)?|帮我)(?:写|整理|查找|查询|查看|总结|起草)?\s*/u, '')
    const terms = new Set(memorySearchTokens(memoryFileLexicalQuery(subject), false))
    const identifiers = memoryIdentifierTokens(request.query)
    return { lexical: lexical.filter(hit => {
      const present = new Set(memorySearchTokens(hit.searchText, true))
      return identifiers.some(id => present.has(id))
        || terms.size > 0 && [...terms].filter(term => present.has(term)).length >= Math.min(terms.size, Math.max(2, Math.ceil(terms.size / 3)))
    }), vector: vector.filter(hit => hit.score >= defaults.automaticMinCosine) }
  }
  function selectSearch(request: FileSearchRequest, plan: ReturnType<typeof beginSearch>, vector: MemoryFileHit[],
    batch?: MemoryDocumentReadBatch, reportStale = true) {
    const { scope, allowed, limit, candidates, lexical, startedAt } = plan
    const timedOut = () => Boolean(request.signal?.aborted
      || request.automatic && performance.now() - startedAt >= defaults.automaticContextBudgetMs)
    const checks = verifier(request.allows, timedOut, batch, reportStale)
    const authorizedHits = (rows: readonly MemoryFileHit[]) => {
      const hits: MemoryFileHit[] = []
      for (const hit of rows) {
        if (timedOut()) break
        if (checks.verify(hit.file)) {
          if (hits.length === candidates) return { hits, truncated: true }
          hits.push(hit)
        }
      }
      return { hits, truncated: false }
    }
    const qualified = qualifyCandidates(request, lexical, vector)
    const safeLexical = authorizedHits(qualified.lexical)
    const safeVector = authorizedHits(qualified.vector)
    const ranked = fuseMemoryFileHits(safeLexical.hits, safeVector.hits).filter(hit => hit.score >= (request.minScore ?? defaults.searchMinScore))
    const context = request.contextKey ? hash(JSON.stringify([request.contextKey, request.query, request.from, request.through, request.asOf,
      request.minScore, allowed?.map(file => [file.workspace,file.id,file.revision,file.usageVersion,file.policyToken]) ?? scope.workspaces])) : null
    const seen = context ? returned.get(context) ?? new Set<string>() : new Set<string>()
    const remaining = ranked.filter(hit => !seen.has(memoryFileChunkKey(hit.ref)))
    const selected = selectMemoryFileHits(ranked, { limit, seen })
    return { checks, timedOut, ranked, context, seen, remaining, selected, lexicalFull: safeLexical.hits.length === candidates, limited: safeLexical.truncated || safeVector.truncated }
  }
  function finishSearch(request: FileSearchRequest, plan: ReturnType<typeof beginSearch>, vector: MemoryFileHit[], batch?: MemoryDocumentReadBatch): FileSearchResult {
    const { scope, allowed, limit, reasons } = plan
    if (closed || request.signal?.aborted) return unavailable('cancelled')
    const { checks, timedOut, ranked, context, seen, remaining, selected, limited } = selectSearch(request, plan, vector, batch)
    const read = batch?.read ?? readable
    if ((limited || plan.lexicalIncomplete) && !reasons.includes('candidate-limit')) reasons.push('candidate-limit')
    if (checks.incomplete() || timedOut()) reasons.push('file-changed')
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
      const view = checks.verify(hit.file)
      if (!view) continue
      const related = allowed ? expand(hit.file, allowed, checks.verify) : expandPublished(hit.file, scope, checks.verify)
      if (checks.incomplete() && !reasons.includes('file-changed')) reasons.push('file-changed')
      if (timedOut()) break
      const candidate: FileSearchHit = {id:view.id,workspace:view.workspace,path:view.path,revision:view.revision,startLine:hit.startLine,endLine:hit.endLine,
        text:hit.text,score:hit.score,applicability:applicability(view, request.allows, read),inlinks:related.inlinks,outlinks:related.outlinks}
      if (fits([...hits, candidate])) {
        hits.push(candidate)
        delivered.push(hit.ref)
        views.push(view, ...related.dependencies)
        continue
      }
      budgetLimited = true
      if (!hits.length) {
        const countsOnly = (neighbors: FileNeighbors): FileNeighbors => ({ neighbors: [], visibleCount: neighbors.visibleCount, partial: neighbors.visibleCount > 0 })
        const locator: FileSearchHit = { ...candidate, text: '', readRequired: true,
          inlinks: countsOnly(candidate.inlinks), outlinks: countsOnly(candidate.outlinks) }
        if (fits([locator])) {
          hits.push(locator)
          views.push(view, ...related.dependencies)
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
    if (timedOut() && !reasons.includes('file-changed')) reasons.push('file-changed')
    return {status:hits.length || budgetLimited ? 'ok' : ranked.length && context ? 'exhausted' : reasons.includes('file-changed') ? 'unavailable' : 'empty',
      hits,...readSet(views, read), reasons,partial:remaining.length > limit || reasons.length > 0}
  }
  function searchCached(request: FileSearchRequest): FileSearchResult {
    const observation = beginDiagnosticOperation(diagnostics, 'memory.recall', { identities: { sessionId: request.contextKey ?? null } })
    try {
      if (closed || request.signal?.aborted) { observation.end('cancelled', { reason: 'aborted' }); return unavailable('cancelled') }
      const plan = beginSearch(request)
      observation.progress({ stage: 'lexical', metrics: { count: plan.lexical.length } })
      if (embedder) plan.reasons.push('semantic-not-run')
      const result = finishSearch(request, plan, [])
      observation.end('completed', { stage: 'fusion', metrics: { count: result.hits.length, partial: result.partial } })
      return result
    } catch (error) { observation.fail(error); throw error }
  }
  async function search(request: FileSearchRequest, batch = usePublishedIndex ? policy.readBatch?.(request.signal) : undefined): Promise<FileSearchResult> {
    const startedAt = performance.now()
    const observation = beginDiagnosticOperation(diagnostics, 'memory.recall', { identities: { sessionId: request.contextKey ?? null } })
    try {
      if (closed || request.signal?.aborted) { observation.end('cancelled', { reason: 'aborted' }); return unavailable('cancelled') }
      const plan = beginSearch(request, startedAt)
      observation.progress({ stage: 'lexical', metrics: { count: plan.lexical.length } })
      const { scope, allowed, candidates, reasons } = plan
      const verificationBudget = (automatic: number, manual: number) => request.automatic
        ? Math.min(automatic, defaults.automaticContextBudgetMs - 15 - (performance.now() - startedAt)) : manual
      const loadingLexical = batch && loadFiles(batch, qualifyCandidates(request, plan.lexical, []).lexical.map(hit => hit.file),
        verificationBudget(85, defaults.fileVerificationBudgetMs), request.signal)
      let vector: MemoryFileHit[] = []
      if (embedder && (allowed?.length ?? scope.workspaces.length)) {
        observation.progress({ stage: 'vector', metrics: { count: allowed?.length ?? candidates } })
        const run = scopedController(request.signal)
        try {
          const state = index.vectorState()
          const target = space()
          const publishedOnly = usePublishedIndex || request.automatic || request.publishedVectorsOnly
          // Latency-sensitive reads only inspect the published generation. Checking every
          // stored vector or switching spaces is index maintenance.
          const needsPreparation = !state.active || state.space?.fingerprint !== target.fingerprint
            || state.space.dimensions !== target.dimensions || !publishedOnly && index.missingVectors(state.generation).length > 0
          if ((request.automatic || usePublishedIndex) && needsPreparation) prepareAfterSearch()
          const ready = !needsPreparation || !publishedOnly && await prepareVectors(run.controller.signal)
          if (ready && !run.controller.signal.aborted && index.vectorState().active) {
            const queryBudget = request.automatic
              ? defaults.automaticContextBudgetMs - defaults.automaticResultReserveMs - (performance.now() - startedAt)
              : defaults.automaticQueryTimeoutMs
            let output = null
            if (publishedOnly) {
              if (queryBudget > 0) output = await boundedQuery(request.query, queryBudget, request.signal, request.automatic)
            } else output = await encode([{kind:'query',text:request.query}], run.controller.signal)
            if (output?.[0] && !run.controller.signal.aborted) {
              const scoreDeadline = performance.now() + verificationBudget(40, defaults.automaticQueryTimeoutMs)
              const page = allowed ? null : await index.vectorCandidates(output[0], space(), scope, candidateProbe(candidates),
                () => !closed && !request.signal?.aborted, scoreDeadline)
              const hits = allowed ? index.vector(output[0], space(), allowed, candidates) : page?.rows
              if (hits) vector = hits
              else reasons.push('semantic-unavailable')
              if (page?.incomplete && !reasons.includes('candidate-limit')) reasons.push('candidate-limit')
            } else reasons.push('semantic-unavailable')
          } else reasons.push('semantic-index-incomplete')
        } catch { reasons.push('semantic-unavailable') }
        finally { run.done() }
      }
      if (batch) {
        await loadingLexical
        const qualified = qualifyCandidates(request, [], vector).vector
        await loadFiles(batch, qualified.map(hit => hit.file), verificationBudget(30, defaults.fileVerificationBudgetMs), request.signal)
        if (!closed && !request.signal?.aborted) {
          let selection = selectSearch(request, plan, vector, batch, false)
          const size = candidateProbe(candidates)
          const stopAt = performance.now() + verificationBudget(35, defaults.fileVerificationBudgetMs)
          for (let offset = size; plan.lexicalIncomplete && !selection.lexicalFull && selection.selected.length < plan.limit && offset < 512 && performance.now() < stopAt; offset += size) {
            const page = index.lexicalCandidates(memoryFileLexicalQuery(request.query), scope, size, offset)
            plan.lexical.push(...page.rows)
            await loadFiles(batch, qualifyCandidates(request, page.rows, []).lexical.map(hit => hit.file),
              stopAt - performance.now(), request.signal)
            if (closed || request.signal?.aborted) return unavailable('cancelled')
            plan.lexicalIncomplete = page.incomplete
            selection = selectSearch(request, plan, vector, batch, false)
          }
          const neighbors = selection.selected.flatMap(hit => {
            const { incoming, outgoing } = publishedLinks(hit.file, scope)
            return [...incoming.rows, ...outgoing.rows]
          })
          await loadFiles(batch, neighbors, verificationBudget(35, defaults.fileVerificationBudgetMs), request.signal)
        }
      }
      observation.progress({ stage: 'fusion', metrics: { count: vector.length } })
      const result = finishSearch(request, plan, vector, batch)
      observation.progress({ stage: 'relations', metrics: { count: result.hits.reduce((count, hit) => count + hit.inlinks.visibleCount + hit.outlinks.visibleCount, 0) } })
      observation.end(request.signal?.aborted ? 'cancelled' : 'completed', { metrics: { count: result.hits.length, partial: result.partial } })
      return result
    } catch (error) { observation.fail(error); throw error }
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
  function resolve(input: FileLookup, read = readable) {
    const scopes = input.workspaces ?? workspaces()
    if (input.workspace && !scopes.includes(input.workspace)) return null
    if (input.workspace && input.path) { const view=read(input.workspace,resolveAlias?.(input.workspace,input.path) ?? input.path); return view && (!input.id || view.id===input.id) && input.allows(view) ? view : null }
    if (!input.id) throw new Error('invalid-memory-file-read')
    const id = input.id
    const found = (input.workspace ? [input.workspace] : scopes).flatMap(workspace => {
      if (!resolveId) return policy.list(workspace)
      const path = resolveId(workspace, id)
      return path ? read(workspace, path) ?? [] : []
    }).filter(view => view.id === id && input.allows(view))
    return found.length===1 ? found[0]! : null
  }
  function read(input: FileReadInput, batch?: MemoryDocumentReadBatch) {
    if (closed || input.signal?.aborted) return null
    const lookup = batch?.read ?? readable
    const view=resolve(input, lookup)
    if (!view) return null
    const markdown=input.evidence ? view.markdown : view.currentMarkdown
    if (markdown===null) return null
    const lineCount = memoryDocumentLines(markdown).length
    const startLine=input.startLine ?? 1, endLine=Math.min(input.endLine ?? lineCount,lineCount)
    const text=readMemoryLines(markdown,startLine,input.endLine)
    if (startLine > lineCount) return null
    return {id:view.id,workspace:view.workspace,path:view.path,revision:view.revision,startLine,endLine,text,
      applicability:applicability(view,input.allows,lookup),...readSet([view],lookup)}
  }
  async function readAsync(input: FileReadInput, batch = policy.readBatch?.(input.signal)) {
    if (!batch || !resolveId) return read(input)
    if (closed || input.signal?.aborted) return null
    const files = (input.workspaces ?? workspaces()).flatMap(workspace => {
      if (input.workspace && input.workspace !== workspace) return []
      const path = input.workspace && input.path ? resolveAlias?.(workspace, input.path) ?? input.path : input.id && resolveId(workspace, input.id)
      return path ? [{ workspace, path }] : []
    })
    await loadFiles(batch, files, defaults.fileVerificationBudgetMs, input.signal)
    return read(input, batch)
  }
  function planNodeSearch(input: NodeSearchInput) {
    if (!input.query.trim()) throw new Error('invalid-memory-file-search')
    const limit = checkedLimit(input.limit)
    const scope = searchScope(input)
    const query = memoryFileLexicalQuery(input.query)
    if (!usePublishedIndex) sync()
    const candidates = usePublishedIndex ? index.nodeCandidates(query, scope, candidateProbe(Math.min(defaults.searchMaxCandidates, limit * defaults.searchCandidateMultiplier)))
      : { rows: authorized(input.allows, scope).flatMap(file => index.snapshot(file.workspace,file.id) ?? []), incomplete: false }
    return { query, limit, candidates }
  }
  function nodeSearch(input: NodeSearchInput, plan?: ReturnType<typeof planNodeSearch>, batch?: MemoryDocumentReadBatch) {
    if (closed || input.signal?.aborted) return {nodes:[],files:[],sourceIds:[],partial:false}
    const { query, limit, candidates } = plan ?? planNodeSearch(input)
    const checks = verifier(input.allows, undefined, batch)
    const rows = candidates.rows.flatMap(file => {
      const view = checks.verify(file)
      return view?.kind === 'digest' && view.applicability.state === 'current'
        ? [{ key: identityKey(file), text: `${file.name}
${file.description}`, file, view }] : []
    })
    const ranked = rankDailyMemory(rows,query,limit,0)
    return { nodes: ranked.hits.map(({ document, score }) => {
      const { id, workspace, path, name, description } = document.file
      return { id, workspace, path, name, description, score }
    }), ...readSet(ranked.hits.map(hit => hit.document.view), batch?.read), partial: ranked.partial || candidates.incomplete || checks.incomplete() }
  }
  async function nodeSearchAsync(input: NodeSearchInput, batch = usePublishedIndex ? policy.readBatch?.(input.signal) : undefined) {
    if (!batch || closed || input.signal?.aborted) return nodeSearch(input)
    const plan = planNodeSearch(input)
    const until = performance.now() + defaults.fileVerificationBudgetMs
    await loadFiles(batch, plan.candidates.rows, defaults.fileVerificationBudgetMs, input.signal)
    let result = nodeSearch(input, plan, batch)
    const size = candidateProbe(Math.min(defaults.searchMaxCandidates, plan.limit * defaults.searchCandidateMultiplier))
    for (let offset = size; !closed && !input.signal?.aborted && plan.candidates.incomplete && result.nodes.length < plan.limit && offset < 512 && performance.now() < until; offset += size) {
      const page = index.nodeCandidates(plan.query, searchScope(input), size, offset)
      await loadFiles(batch, page.rows, until - performance.now(), input.signal)
      if (closed || input.signal?.aborted) break
      plan.candidates.rows.push(...page.rows)
      plan.candidates.incomplete = page.incomplete
      result = nodeSearch(input, plan, batch)
    }
    return result
  }
  function relations(input:{workspace:string,path:string,allows:Allows}) {
    if (closed) return null
    const scope = searchScope()
    if (!scope.workspaces.includes(input.workspace)) return null
    if (!usePublishedIndex) sync()
    const direct = index.nodeAt(input.workspace, input.path)
    const alias = !direct && resolveAlias?.(input.workspace, input.path)
    const file = direct ?? (alias ? index.nodeAt(input.workspace, alias) : null)
    if (!file) return null
    const checks = verifier(input.allows)
    const view = checks.verify(file)
    if (!view) return null
    if (usePublishedIndex) {
      const result = expandPublished(file, scope, checks.verify)
      const partial = checks.incomplete()
      return {
        inlinks: { ...result.inlinks, partial: result.inlinks.partial || partial },
        outlinks: { ...result.outlinks, partial: result.outlinks.partial || partial },
        ...readSet([view, ...result.dependencies]),
      }
    }
    const result = expand(file, authorized(input.allows, scope), checks.verify)
    return { inlinks: result.inlinks, outlinks: result.outlinks, ...readSet([view, ...result.dependencies]) }
  }
  return {sync,publishFiles,preparePublication,watchProjection,search,searchCached,readAsync,nodeSearchAsync,
    read: (input: Parameters<typeof read>[0]) => observeDiagnosticSync(diagnostics, 'memory.recall', () => read(input), { stage: 'received', identities: { resourceId: input.id } }),
    nodeSearch: (input: Parameters<typeof nodeSearch>[0]) => observeDiagnosticSync(diagnostics, 'memory.recall', observation => {
      const result = nodeSearch(input)
      observation.progress({ stage: 'lexical', metrics: { count: result.nodes.length, partial: result.partial } })
      return result
    }, { stage: 'lexical' }),
    relations: (input: Parameters<typeof relations>[0]) => observeDiagnosticSync(diagnostics, 'memory.recall', observation => {
      const result = relations(input)
      observation.progress({ stage: 'relations', metrics: { count: result ? result.inlinks.visibleCount + result.outlinks.visibleCount : 0 } })
      return result
    }, { stage: 'relations' }), prepareVectors,indexedScores,
    reindex:()=>observeDiagnosticSync(diagnostics, 'memory.index', () => {
      if (closed) throw new Error('memory-file-retrieval-closed'); return index.reindex()
    }, { stage: 'rebuild' }),
    close(){closed=true;clearTimeout(scheduledPreparation);controllers.forEach(controller=>controller.abort());returned.clear()},
  }
}
