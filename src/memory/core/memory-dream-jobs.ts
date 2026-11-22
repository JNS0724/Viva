import { guardDiagnosticPort, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort, DiagnosticReason, DiagnosticStage } from '../../diagnostics/contracts.ts'
import { MemoryComputeError } from '../contracts/compute.ts'
import type { MemoryComputeTools } from '../contracts/compute.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { dailyPath, parseDreamPlan } from '../contracts/memory-file-contract.ts'
import type { DreamEdit, DreamOperation } from '../contracts/memory-file-contract.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { MemoryIdentity } from './ports/runtime.ts'
import type { Effect, Effects, Outcome } from './ports/effects.ts'
import type { MemoryNotes } from './ports/notes.ts'
import type { MemoryDreamStatus } from '../contracts/dream-status.ts'
import type { MemoryStore, MemorySource } from './ports/store.ts'
import type { DocumentReceipt, DocumentSourceRef, MemoryDocuments, ReadMemoryPhysicalFile } from './ports/documents.ts'
import type { MemoryFileIndex } from './ports/file-index.ts'
import { memorySearchTokens } from './search-tokens.ts'
import { DREAM, nextDreamAt } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import { todayAt } from './memory-calendar.ts'
import { formatMemoryDocument, parseMemoryDocument } from './memory-document.ts'
import { createMemoryDocumentReadPolicy, createMemoryDocumentEvidence, mergeDocumentSources } from './memory-document-read-policy.ts'
import { createRequestBudget, RequestTimeout } from '../../shared/request-budget.ts'
import type { MemoryDocumentReadBatch, MemoryDocumentView } from './memory-document-read-policy.ts'
import { documentSourceRestricted, projectDocumentSource } from './memory-document-restrictions.ts'
import { DREAM_CONSOLIDATE_SYSTEM } from './memory-dream-prompts.ts'
import { createMemoryDreamTools, dreamNodeMetadata, memoryDocumentLinks, MemoryDreamStaleError } from './memory-dream-tools.ts'
import type { DreamSearchPage } from './memory-dream-tools.ts'

export { MemoryDreamStaleError } from './memory-dream-tools.ts'

export type DreamCalculate = (request: {
  job: Effect, stage: 'consolidate', system: string, input: object,
  sourceIds: () => readonly string[], current: () => boolean,
  observe?: (signal?: AbortSignal) => Promise<() => boolean>,
  tools?: MemoryComputeTools,
}) => Promise<string | undefined>

type FileRef = {
  key: string
  workspace: string
  path: string
  revision: string
  policyToken: string
  checkpoint: number
  sources: DocumentSourceRef[]
}
type Note = NonNullable<ReturnType<MemoryNotes['read']>>
type Location = { workspace: string, path: string }
type PreparedOperation = {
  operation: DreamOperation
  before: MemoryDocumentView | null
  markdown: string
  evidence: DocumentSourceRef[]
  reads: Array<{ id: string, revision: string, usageVersion: number }>
  linkedPaths: string[]
  files: Array<{ path: string, revision: string }>
}
type PersistedOperation = {
  operationId: string
  action: DreamOperation['action']
  path: string
  expectedRevision: string | null
  markdown: string
  sources: DocumentSourceRef[]
  reads: Array<{ id: string, revision: string, usageVersion: number }>
  linkedPaths: string[]
  files: Array<{ path: string, revision: string }>
}
type PersistedBatch = {
  workspace: string
  fileRefs: FileRef[]
  operations: PersistedOperation[]
  checkpointPaths: string[]
}

const DAILY = 'daily'
const MANUAL_JOB = 'dream.manualJob'
const MANUAL_FOLLOWUP = 'dream.manualFollowup'
const requestKey = (id: string) => `dream.request:${id}`
const receiptKey = (id: string) => `dream.receipt:${id}`
const DAY_MS = 86_400_000
const unique = <T>(values: readonly T[]) => [...new Set(values)]
const parse = (text: string) => JSON.parse(text) as unknown
const isModelTimeout = (error: unknown) => error instanceof MemoryComputeError && error.reason === 'timeout'
const STALE_COMMIT_ERRORS = new Set([
  'memory-document-version',
  'memory-document-source-version',
  'memory-document-action',
  'memory-document-source-loss',
])
const isStaleCommitError = (error: unknown) =>
  error instanceof MemoryDreamStaleError || (error instanceof Error && STALE_COMMIT_ERRORS.has(error.message))

function pendingBatchOf(payload: unknown): PersistedBatch | null {
  if (!payload || typeof payload !== 'object' || !('pendingBatch' in payload)) return null
  const candidate = (payload as { pendingBatch?: unknown }).pendingBatch
  if (!candidate || typeof candidate !== 'object') return null
  const batch = candidate as Partial<PersistedBatch>
  if (typeof batch.workspace !== 'string' || !Array.isArray(batch.fileRefs)
    || !Array.isArray(batch.operations) || !Array.isArray(batch.checkpointPaths)) {
    return null
  }
  return batch as PersistedBatch
}

function applyRefineEdits(beforeBody: string, edits: readonly DreamEdit[]): string {
  let body = beforeBody
  for (const edit of edits) {
    const first = body.indexOf(edit.oldText)
    if (first === -1 || body.indexOf(edit.oldText, first + 1) !== -1) throw new Error('dream-edit-not-unique')
    body = body.slice(0, first) + edit.newText + body.slice(first + edit.oldText.length)
  }
  return body
}

function formatDigestMarkdown(operation: DreamOperation, before: MemoryDocumentView | null) {
  const beforeParsed = before ? parseMemoryDocument(before.markdown) : null
  const draftBody = operation.action === 'CREATE'
    ? operation.body
    : operation.body !== undefined
      ? operation.body
      : applyRefineEdits(beforeParsed!.body, operation.edits!)
  const existingLinks = before ? memoryDocumentLinks(before.markdown) : []
  const bodyLinks = memoryDocumentLinks(draftBody)
  const presentExact = new Set(bodyLinks)
  const presentPaths = new Set(bodyLinks.map(link => link.split('#')[0]!))
  const missingExisting = existingLinks.filter(link => !presentExact.has(link))
  for (const link of missingExisting) presentPaths.add(link.split('#')[0]!)
  const missingDaily = operation.dailyPaths.filter(path => !presentPaths.has(path))
  const missing = unique([...missingExisting, ...missingDaily])
  let body = draftBody.trimEnd()
  if (missing.length) {
    const lines = missing.map(link => `- [[${link}]]`).join('\n')
    const hasSourcesHeading = /(?:^|\n)#{1,6}\s+(?:Sources|来源|来源依据)\s*(?:\n|$)/iu.test(body)
    body = hasSourcesHeading ? `${body}\n${lines}` : `${body}\n\n## Sources\n${lines}`
  }
  const previousMetadata = beforeParsed ? beforeParsed.metadata : {}
  return formatMemoryDocument({
    metadata: { ...previousMetadata, name: operation.name, description: operation.description },
    body,
  })
}

function retryHintFor(reason: string): string {
  switch (reason) {
    case 'dream-search-required':
      return 'Call node_search to inspect existing digests before using CREATE.'
    case 'dream-read-target-first':
      return 'Call read on the target digest before using REFINE on it.'
    case 'dream-edit-not-unique':
      return 'Each REFINE edits[].oldText must match exactly once in the existing digest body; fix oldText or supply body instead.'
    case 'dream-ungrounded-link':
      return 'Only link paths from dailyPaths, inspected digests from node_search/read, or prior links already in the target digest.'
    default:
      return 'The prior JSON had an invalid shape, target path, budget, or source reference. Correct it using only the supplied inputs.'
  }
}

/** Day grouping and UTF-8 budget. Oversized single files remain standalone, never silently disappear. */
export function batchDreamNotes<T extends { day: string, document: string }>(notes: readonly T[], budget: number): T[][] {
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('invalid-dream-byte-budget')
  if (!budget) return notes.length ? [[...notes]] : []
  const days = new Map<string, T[]>()
  for (const note of notes) days.set(note.day, [...days.get(note.day) ?? [], note])
  const batches: T[][] = []
  let batch: T[] = [], bytes = 0
  const size = (note: T) => new TextEncoder().encode(note.document).byteLength
  const flush = () => { if (batch.length) batches.push(batch); batch = []; bytes = 0 }
  for (const day of days.values()) {
    const dayBytes = day.reduce((sum, note) => sum + size(note), 0)
    if (bytes + dayBytes > budget) flush()
    if (dayBytes <= budget) { batch.push(...day); bytes += dayBytes; continue }
    for (const note of day) {
      const count = size(note)
      if (bytes + count > budget) flush()
      batch.push(note); bytes += count
    }
  }
  flush()
  return batches
}

export function dreamHistory(store: Pick<MemoryStore, 'meta'>) {
  const read = (key: string) => {
    const value = store.meta(key)
    return value === undefined ? null : Number(value)
  }
  const result = store.meta('dream.lastCheckResult')
  const lastCheckResult: MemoryDreamStatus['lastCheckResult'] = result === 'empty' || result === 'processed' || result === 'size-limit' ? result : null
  return { lastCheckResult, lastCheckedAt: read('dream.lastCheckedAt'), lastProcessedAt: read('dream.lastProcessedAt') }
}

/** Dream consolidation: read-only exploration (node_search + read), structured JSON output, and deterministic guards. */
export function createMemoryDreamJobs({ notes, documents, effects, store, identity, now, settings, readable, eligible, source, reference,
  calculate, transaction, mutate, readPhysicalFile, digestNodes, searchDigestNodes, committed = () => {}, allowsText = () => true, diagnostics: diagnosticPort }: {
  store: Pick<MemoryStore, 'meta' | 'setMeta' | 'command' | 'recordCommand'>, notes: MemoryNotes, documents: MemoryDocuments, effects: Effects, identity: MemoryIdentity, now: () => number,
  settings?: DailyMemorySettings, readable: (id: string) => boolean, eligible: (source: MemorySource) => boolean,
  source: (id: string) => MemorySource | undefined, reference: (id: string) => MemorySourceReference | null,
  calculate: DreamCalculate, transaction: (write: () => void) => void, mutate: <T>(write: () => T) => Promise<T>, committed?: (receipt: DocumentReceipt) => void,
  digestNodes?: MemoryFileIndex['digestNodes'],
  searchDigestNodes?: (workspace: string, query: string, limit: number, signal?: AbortSignal) => Promise<Array<{ id: string, path: string, score: number }>>,
  readPhysicalFile?: ReadMemoryPhysicalFile, allowsText?: (text: string, source: MemorySource) => boolean,
  diagnostics?: DiagnosticPort,
}) {
  const diagnostics = guardDiagnosticPort(diagnosticPort)
  const progress = (job: Effect, reason: DiagnosticReason, stage?: DiagnosticStage, attempt?: number) => diagnostics.emit({
    event: 'operation.progress', operation: 'memory.dream', reason, ...(stage ? { stage } : {}),
    identities: { jobId: job.key, generation: job.generation },
    ...(attempt === undefined ? {} : { metrics: { attempt } }),
  })
  async function calculateStage(request: Parameters<DreamCalculate>[0]) {
    try { return await calculate(request) }
    catch (error) {
      if (isModelTimeout(error)) progress(request.job, 'timeout', request.stage)
      throw error
    }
  }
  const { timezone, dreamTime, scanDays, dreamUnits, dreamBatchBytes } = { ...defaults, ...settings }
  if (!Number.isSafeInteger(scanDays) || scanDays < 1 || !Number.isSafeInteger(dreamUnits) || dreamUnits < 1) throw new Error('invalid-dream-settings')
  const schedule = () => effects.queue(DREAM, DAILY, null, nextDreamAt(now(), timezone, dreamTime))
  let active = false
  let waitingGeneration: number | null = null
  const status = (operationId?: string): MemoryDreamStatus => {
    const receipt = operationId && store.command(requestKey(operationId))
    const scheduled = effects.timing(DREAM, DAILY)
    return {
      state: active ? 'running' : scheduled?.generation === waitingGeneration ? 'waiting'
        : scheduled && scheduled.dueAt <= now() ? 'queued' : scheduled?.attempts ? 'retry' : 'idle',
      ...dreamHistory(store), ...(receipt && { jobId: receipt.payload }),
    }
  }
  const { refsCurrent, materialAllowed } = createMemoryDocumentEvidence({ notes, documents, hash: identity.hash, source, readable, allowsText })
  const policy = createMemoryDocumentReadPolicy({ notes, documents, hash: identity.hash, refsCurrent, materialAllowed, reference, readPhysicalFile })
  const fileCurrent = (ref: FileRef, batch?: MemoryDocumentReadBatch) => {
    const latest = notes.read(ref.key, batch?.physical(ref.workspace, ref.path))
    return latest?.workspace === ref.workspace && latest.path === ref.path && latest.fileRevision === ref.revision
      && (batch ?? policy).read(ref.workspace, ref.path)?.policyToken === ref.policyToken && refsCurrent(ref.sources)
      && !ref.sources.some(item => documentSourceRestricted(item, documents.sourceRestrictions(ref.workspace)))
  }
  async function loadFiles(files: Location[], signal?: AbortSignal, partial = false) {
    const batch = policy.readBatch(signal, files.length + 512)
    if (!batch) return
    const budget = createRequestBudget(defaults.fileVerificationBudgetMs, signal)
    try { await budget.run(() => batch.load(files, budget.signal)) }
    catch (error) {
      if (!partial || signal?.aborted || !(error instanceof RequestTimeout)) throw error
    } finally { budget.close() }
    return batch
  }
  function observeReadset(locations: () => Location[], current: (batch?: MemoryDocumentReadBatch) => boolean) {
    return async (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      const batch = await loadFiles(locations(), signal)
      if (!batch) return () => !signal?.aborted && current()
      if (batch.incomplete()) throw new RequestTimeout()
      return () => !signal?.aborted && locations().every(file => batch.observedRevision(file.workspace, file.path) !== undefined) && current(batch)
    }
  }
  const verified = async (observe: () => Promise<() => boolean>) => {
    const check = await observe()
    return check()
  }

  const scopedDocuments = (workspace: string) => {
    const unpublished = new Map<string, { revision: string, path: string, name: string, terms: string[] }>()
    const activeEntries = () => {
      const restrictions = documents.sourceRestrictions(workspace)
      const entries = restrictions.length
        ? documents.registered(workspace).filter(doc => !doc.sources.some(ref => documentSourceRestricted(ref, restrictions)))
        : documents.fileRegistry(workspace)
      return entries.filter(row => row.state === 'active')
    }
    async function candidates(query: string, limit: number, signal?: AbortSignal) {
      const terms = new Set(memorySearchTokens(query, false))
      const published = new Map(digestNodes?.(workspace).map(node => [node.id, node]))
      const hybridScores = new Map<string, number>()
      if (searchDigestNodes) {
        try {
          const hits = await searchDigestNodes(workspace, query, limit, signal)
          for (const hit of hits) hybridScores.set(hit.id, Math.max(hybridScores.get(hit.id) ?? 0, hit.score))
        } catch { /* Fall back to local lexical candidate scan. */ }
      }
      const matches: Array<{ path: string, revision: string, usageVersion: number, score: number }> = []
      let yieldAt = performance.now() + 4
      for (const row of activeEntries()) {
        if (performance.now() >= yieldAt) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          signal?.throwIfAborted()
          yieldAt = performance.now() + 4
        }
        const node = published.get(row.id)
        let words: string[] | undefined, name: string | undefined
        if (node && node.revision === row.revision && node.usageVersion === row.usageVersion && node.path === row.path) {
          name = node.name || row.path.split('/').at(-1)!.replace(/\.md$/u, '')
          words = memorySearchTokens(`${name} ${node.description}`, true)
        } else {
          const cached = unpublished.get(row.id)
          if (cached?.revision === row.revision && cached.path === row.path) { words = cached.terms; name = cached.name }
          else {
            const accepted = documents.acceptedSnapshot(workspace, row.id)
            if (accepted) {
              const metadata = dreamNodeMetadata(accepted)
              words = memorySearchTokens(`${metadata.name} ${metadata.description}`, true)
              name = metadata.name
              unpublished.set(row.id, { revision: row.revision, path: row.path, name, terms: words })
            }
          }
        }
        const lexicalScore = name?.toLowerCase() === query.toLowerCase() ? terms.size + 1 : words
          ? [...new Set(words.filter(word => terms.has(word)))].length : 0
        const hybridScore = hybridScores.get(row.id) ?? 0
        const score = hybridScore > 0 ? hybridScore * 100 + lexicalScore : lexicalScore
        if (!words || score > 0) matches.push({ path: row.path, revision: row.revision, usageVersion: row.usageVersion, score })
      }
      return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    }
    return {
      countActive: () => activeEntries().length,
      read: (path: string) => policy.read(workspace, path),
      list: () => policy.list(workspace, 'digest'),
      async load(required: string[], search: { query: string, limit?: number, page?: DreamSearchPage } | null, signal?: AbortSignal) {
        signal?.throwIfAborted()
        const limit = Math.min(defaults.searchMaxCandidates, (search?.limit ?? defaults.searchLimit) * defaults.searchCandidateMultiplier)
        const matches = search ? await candidates(search.query, limit, signal) : []
        const fingerprint = search ? identity.hash(JSON.stringify(matches)) : ''
        const offset = search?.page?.fingerprint === fingerprint ? search.page.offset : 0
        const pageSlice = matches.slice(offset, offset + limit)
        const selected = pageSlice.map(match => match.path)
        const scored = searchDigestNodes && pageSlice.some(match => match.score > 0)
          ? new Map(pageSlice.map(match => [match.path, match.score]))
          : undefined
        const locations = (paths: string[]) => paths.map(path => ({ workspace, path }))
        const requiredSet = new Set(required)
        const mandatory = await loadFiles(locations([...requiredSet]), signal)
        const optional = await loadFiles(locations(selected.filter(path => !requiredSet.has(path))), signal, true)
        const observation = (path: string) => {
          const batch = requiredSet.has(path) ? mandatory : optional
          return batch ? batch.readObservation(workspace, path) : policy.read(workspace, path)
        }
        const read = (path: string) => {
          const view = observation(path)
          if (view === undefined) throw new RequestTimeout()
          return view
        }
        for (const path of requiredSet) read(path)
        let unread = false
        const list = selected.flatMap(path => {
          const view = observation(path)
          if (view === undefined) unread = true
          return view ?? []
        })
        const nextOffset = unread ? offset : offset + selected.length
        const partial = unread || nextOffset < matches.length
        return { read, list: () => list, ...(scored ? { scored } : {}), partial, next: partial ? { fingerprint, offset: nextOffset } : undefined }
      },
    }
  }

  async function runJob(job: Effect): Promise<Outcome> {
    if (notes.needsRecovery() || documents.needsRecovery()) await mutate(() => {
      if (notes.needsRecovery()) notes.recover()
      if (documents.needsRecovery()) documents.recover()
    })
    const today = todayAt(now(), timezone)
    const from = new Date(Date.parse(today) - (scanDays - 1) * DAY_MS).toISOString().slice(0, 10)
    let retry = false
    let waitingForAdmission = false
    let processedAny = false
    let oversizedAny = false
    let operationsUsed = 0
    const clearPendingBatch = () => {
      if (effects.holds(job)) effects.amend(job, {})
    }
    const checkpointFiles = async (fileRefs: readonly FileRef[]) => {
      const checkpointBatch = await loadFiles([...fileRefs], undefined, true)
      if (!effects.holds(job)) return
      if (checkpointBatch && fileRefs.some(file => checkpointBatch.readObservation(file.workspace, file.path) === undefined)) retry = true
      transaction(() => {
        const at = now()
        let advanced = false
        for (const file of fileRefs) {
          const unreadable = checkpointBatch && checkpointBatch.readObservation(file.workspace, file.path) === undefined
          if (!unreadable && fileCurrent(file, checkpointBatch) && notes.markProcessed(file.key, file.checkpoint)) {
            advanced = true
            processedAny = true
          }
        }
        if (advanced) store.setMeta('dream.lastProcessedAt', String(at))
      })
    }

    async function commitBatchOperations(
      workspace: string,
      operations: readonly PersistedOperation[],
      options: {
        verifyOp(op: PersistedOperation, opReads: Array<{ id: string, revision: string, usageVersion: number }>): Promise<'ready' | 'wait' | 'stale' | 'retry' | 'cancelled'>
        assertMutateCurrent(op: PersistedOperation, opReads: Array<{ id: string, revision: string, usageVersion: number }>): void
        onCommittedPath?(path: string): void
      },
    ): Promise<'done' | 'wait' | 'stale' | 'retry' | 'cancelled'> {
      const committedReads = new Map<string, { id: string, revision: string, usageVersion: number }>()
      const committedByPath = new Map<string, { id: string, revision: string, usageVersion: number }>()
      for (const op of operations) {
        if (!effects.holds(job)) return 'cancelled'
        const prior = documents.receipt(workspace, op.operationId)
        if (prior) {
          options.onCommittedPath?.(op.path)
          if (prior.revision !== null) {
            const nextRead = { id: prior.documentId, revision: prior.revision, usageVersion: prior.usageVersion }
            committedReads.set(prior.documentId, nextRead)
            committedByPath.set(op.path, nextRead)
          }
          continue
        }
        if (operationsUsed >= dreamUnits) return 'retry'
        const reads = new Map(op.reads.map(ref => [ref.id, committedReads.get(ref.id) ?? ref]))
        for (const linkedPath of op.linkedPaths) {
          const committedTarget = committedByPath.get(linkedPath)
          if (committedTarget) reads.set(committedTarget.id, committedTarget)
        }
        const opReads = [...reads.values()]
        const verifiedState = await options.verifyOp(op, opReads)
        if (verifiedState !== 'ready') return verifiedState
        try {
          const receipt = await mutate(() => {
            const existing = documents.receipt(workspace, op.operationId)
            if (existing) return existing
            options.assertMutateCurrent(op, opReads)
            return documents.commit({
              operationId: op.operationId, workspace, path: op.path,
              expectedRevision: op.expectedRevision,
              markdown: op.markdown, action: op.action,
              sources: op.sources, reads: opReads, files: op.files,
            })
          })
          operationsUsed++
          options.onCommittedPath?.(op.path)
          if (receipt.revision !== null) {
            const nextRead = { id: receipt.documentId, revision: receipt.revision, usageVersion: receipt.usageVersion }
            committedReads.set(receipt.documentId, nextRead)
            committedByPath.set(op.path, nextRead)
          }
          committed(receipt)
          diagnostics.emit({
            event: 'operation.progress', operation: 'memory.write', stage: 'applied',
            identities: { requestId: op.operationId, jobId: job.key, generation: job.generation, resourceId: receipt.documentId, methodId: receipt.action },
            metrics: { count: op.sources.length },
          })
        } catch (error) {
          if (!effects.holds(job)) return 'cancelled'
          if (isStaleCommitError(error)) {
            clearPendingBatch()
            progress(job, 'source_changed', 'consolidate')
            return 'stale'
          }
          progress(job, safeDiagnosticReason(error), 'consolidate')
          return 'retry'
        }
      }
      return 'done'
    }

    const pendingBatch = pendingBatchOf(job.payload)
    if (pendingBatch) {
      const workspace = pendingBatch.workspace
      const project = (text: string) => documents.projectErasedLocators(workspace, text)
      const opSourcesValid = (op: PersistedOperation, requireEligible: boolean) => {
        const restrictions = documents.sourceRestrictions(workspace)
        return refsCurrent(op.sources)
          && !op.sources.some(ref => documentSourceRestricted(ref, restrictions))
          && (!requireEligible || op.sources.every(ref => { const item = source(ref.id); return Boolean(item && eligible(item)) }))
          && materialAllowed(op.markdown, op.sources)
          && project(op.markdown) === op.markdown
      }
      const makeOpCurrent = (op: PersistedOperation, opReads: Array<{ id: string, revision: string, usageVersion: number }>) =>
        (observed?: MemoryDocumentReadBatch) => {
          if (!effects.holds(job)
            || !pendingBatch.fileRefs.every(ref => fileCurrent(ref, observed))
            || !opSourcesValid(op, true)) return false
          if (!opReads.every(ref => {
            const target = documents.indexFile(workspace, ref.id)
            const doc = target && documents.read(workspace, target.path, { physical: observed?.physical(workspace, target.path) })
            return doc?.id === ref.id && doc.revision === ref.revision && doc.usageVersion === ref.usageVersion
          })) return false
          const physical = observed?.physical(workspace, op.path)
          if (op.action === 'CREATE') {
            return !documents.locatorRetired(workspace, op.path)
              && documents.read(workspace, op.path, { includeDisabled: true, physical }) === null
              && (observed ?? policy).read(workspace, op.path) === null
          }
          const target = documents.read(workspace, op.path, { physical })
          return target !== null && target.revision === op.expectedRevision
        }
      const resumeOutcome = await commitBatchOperations(workspace, pendingBatch.operations, {
        async verifyOp(op, opReads) {
          const opLocations = (): Location[] => [
            ...pendingBatch.fileRefs,
            { workspace, path: op.path },
            ...opReads.flatMap(ref => {
              const target = documents.indexFile(workspace, ref.id)
              return target ? [{ workspace, path: target.path }] : []
            }),
          ]
          let currentReady = false
          try {
            currentReady = await verified(observeReadset(opLocations, makeOpCurrent(op, opReads)))
          } catch (error) {
            if (!(error instanceof RequestTimeout)) throw error
            return 'retry'
          }
          if (currentReady) return 'ready'
          if (!effects.holds(job)) return 'cancelled'
          if (opSourcesValid(op, false) && op.sources.some(ref => { const item = source(ref.id); return Boolean(item && !eligible(item)) })) {
            return 'wait'
          }
          clearPendingBatch()
          progress(job, 'source_changed', 'consolidate')
          return 'stale'
        },
        assertMutateCurrent(op, opReads) {
          if (!makeOpCurrent(op, opReads)()) throw new MemoryDreamStaleError()
        },
      })

      if (resumeOutcome === 'cancelled') return 'done'
      if (resumeOutcome === 'wait') return 'wait'
      if (resumeOutcome === 'retry') return 'retry'
      if (resumeOutcome === 'done') {
        clearPendingBatch()
        const toCheckpoint = pendingBatch.fileRefs.filter(file => pendingBatch.checkpointPaths.includes(file.path))
        if (toCheckpoint.length) await checkpointFiles(toCheckpoint)
      }
    }

    const available: Note[] = []
    const initialViews = new Map<string, MemoryDocumentView>()
    for (const file of notes.changedFiles(from, today)) {
      if (!effects.holds(job)) return 'done'
      let check: MemoryDocumentReadBatch | undefined
      try {
        check = await loadFiles([file])
        if (check?.incomplete()) throw new RequestTimeout()
      } catch (error) {
        if (!(error instanceof RequestTimeout)) throw error
        retry = true
        continue
      }
      if (!effects.holds(job)) return 'done'
      const note = notes.read(file.key, check?.physical(file.workspace, file.path))
      if (!note) continue
      const view = (check ?? policy).read(file.workspace, file.path)
      if (view) {
        available.push(note)
        initialViews.set(note.key, view)
      }
    }
    const changed = available.filter(note => {
      const refs = notes.references(note.key)
      if (!refsCurrent(refs) || refs.some(ref => documentSourceRestricted(ref, documents.sourceRestrictions(note.workspace))) || !materialAllowed(note.document, refs)) return false
      const admitted = refs.every(ref => { const original = source(ref.id); return original && eligible(original) })
      if (!admitted) waitingForAdmission = true
      return admitted
    })
    if (waitingForAdmission) return 'wait'

    let stopPass = false
    for (const workspace of unique(changed.map(note => note.workspace))) {
      if (stopPass || !effects.holds(job)) break
      const candidates = changed.filter(note => note.workspace === workspace)
      const project = (text: string) => documents.projectErasedLocators(workspace, text)
      const scope = scopedDocuments(workspace)

      const consume = async (batch: Note[]): Promise<void> => {
        if (stopPass || !effects.holds(job)) return
        if (operationsUsed >= dreamUnits) { retry = true; return }
        const seen = batch.map(note => initialViews.get(note.key)!)
        const fileRefs: FileRef[] = batch.map((note, index) => {
          const view = seen[index]!
          return {
            key: note.key, workspace: note.workspace, path: note.path, revision: note.fileRevision,
            policyToken: view.policyToken, checkpoint: note.revision, sources: view.sourceTokens,
          }
        })
        const restrictions = documents.sourceRestrictions(workspace)
        const existingDigestCount = scope.countActive()

        const batchSourceMap = new Map<string, DocumentSourceRef>()
        for (const ref of mergeDocumentSources(fileRefs.flatMap(file => file.sources))) batchSourceMap.set(ref.id, ref)
        const questionContexts = new Map<string, DocumentSourceRef[]>()
        const canonicalSources: Array<{
          sourceId: string, author: MemorySource['author'], text: string,
          question: string | null, questionUnavailable: boolean, at: number, timezone: string,
        }> = []
        for (const ref of batchSourceMap.values()) {
          const original = source(ref.id)
          if (!original?.text) { progress(job, 'source_changed', 'consolidate'); retry = true; return }
          const context = notes.sourceQuestionContext(ref.id)
          const wholeSource = !ref.spans || ref.spans.some(span => span.start === 0 && span.end === original.text!.length)
          const questionAllowed = Boolean(original.question) && wholeSource && context.current
            && !documentSourceRestricted({ id: ref.id, token: ref.token }, restrictions)
            && context.refs.every(dep => !documentSourceRestricted(dep, restrictions))
            && (!context.refs.length || refsCurrent(context.refs))
            && allowsText(original.question!, original)
            && context.refs.every(dep => { const item = source(dep.id); return Boolean(item?.text && allowsText(item.text, item)) })
          if (questionAllowed) questionContexts.set(ref.id, context.refs)
          canonicalSources.push({
            sourceId: original.id, author: original.author,
            text: project(projectDocumentSource(original.text, ref, restrictions)),
            question: questionAllowed ? project(original.question!) : null,
            questionUnavailable: (original.author === 'answer' || Boolean(original.question)) && !questionAllowed,
            at: original.at, timezone: original.timezone,
          })
        }

        const readSources = new Map(mergeDocumentSources([
          ...batchSourceMap.values(),
          ...[...questionContexts.values()].flat(),
        ]).map(ref => [ref.id, ref]))
        const toolAttempts: ReturnType<typeof createMemoryDreamTools<MemoryDocumentView>>[] = []
        const newTools = () => createMemoryDreamTools<MemoryDocumentView>({
          documents: scope,
          onRead(snapshot) {
            for (const ref of mergeDocumentSources([...readSources.values(), ...snapshot.sourceTokens])) {
              readSources.set(ref.id, ref)
            }
          },
        })
        const committedPaths = new Set<string>()
        const toolReadDocs = () => toolAttempts.flatMap(tools => tools.reads())
          .flatMap(doc => doc.backing ? [doc.backing] : [])
        const current = (observed?: MemoryDocumentReadBatch) => {
          const allRefs = [...readSources.values()]
          return effects.holds(job)
            && fileRefs.every(ref => fileCurrent(ref, observed))
            && seen.every(snapshot => (observed ?? policy).read(workspace, snapshot.path)?.policyToken === snapshot.policyToken)
            && refsCurrent(allRefs)
            && allRefs.every(ref => { const item = source(ref.id); return Boolean(item && eligible(item)) })
            && [...questionContexts].every(([id, expected]) => {
              const latest = notes.sourceQuestionContext(id)
              return latest.current && JSON.stringify(latest.refs) === JSON.stringify(expected)
            })
            && toolAttempts.every(tools => tools.current(observed ? path => observed.read(workspace, path) : undefined, committedPaths))
            && toolReadDocs().every(doc => {
              if (committedPaths.has(doc.path)) return true
              const latest = documents.read(workspace, doc.path, { physical: observed?.physical(workspace, doc.path) })
              return latest?.id === doc.id && latest.revision === doc.revision && latest.usageVersion === doc.usageVersion
            })
        }
        const locations = () => [
          ...fileRefs,
          ...toolAttempts.flatMap(tools => tools.checkedPaths().map(path => ({ workspace, path }))),
          ...toolReadDocs().map(doc => ({ workspace, path: doc.path })),
        ]
        const observe = observeReadset(locations, current)
        const inputsCurrent = async () => {
          try { return await verified(observe) }
          catch (error) {
            if (!(error instanceof RequestTimeout)) throw error
            return false
          }
        }
        if (!await inputsCurrent()) { progress(job, 'source_changed', 'consolidate'); retry = true; return }

        const split = async () => {
          const middle = Math.floor(batch.length / 2)
          await consume(batch.slice(0, middle))
          if (!stopPass) await consume(batch.slice(middle))
        }

        const noteByPath = new Map(fileRefs.map(ref => [ref.path, ref]))
        const changedPaths = new Set(noteByPath.keys())
        const allowedSourceIds = new Set(batchSourceMap.keys())
        const remainingAtStart = dreamUnits - operationsUsed
        let prepared: { operations: PreparedOperation[], hasMore: boolean } | undefined
        let retryHint: string | undefined

        for (let attempt = 0; attempt < 2 && !prepared; attempt++) {
          const tools = newTools()
          toolAttempts.push(tools)
          const input = {
            maxOperations: remainingAtStart,
            existingDigestCount,
            notes: batch.map((note, index) => {
              const snapshot = seen[index]!
              const name = parseMemoryDocument(snapshot.markdown).metadata.name
              const chars = [...snapshot.markdown]
              return {
                path: note.path,
                title: typeof name === 'string' ? name : '',
                markdown: chars.slice(0, defaults.dreamFileChars).join('') + (chars.length > defaults.dreamFileChars ? '\n\n[truncated]' : ''),
                sourceIds: fileRefs[index]!.sources.map(ref => ref.id),
              }
            }),
            canonicalSources,
            ...(retryHint ? { retry: retryHint } : {}),
          }
          if (batch.length > 1 && dreamBatchBytes && new TextEncoder().encode(JSON.stringify(input)).length > dreamBatchBytes) {
            await split()
            return
          }
          try {
            const raw = await calculateStage({
              job, stage: 'consolidate', system: DREAM_CONSOLIDATE_SYSTEM, input,
              sourceIds: () => [...readSources.keys()], current, observe,
              tools: { tools: tools.tools, executeTool: tools.executeTool },
            })
            if (raw === undefined) { progress(job, 'unavailable', 'consolidate', attempt); stopPass = true; retry = true; return }
            if (!await inputsCurrent()) { progress(job, 'source_changed', 'consolidate', attempt); retry = true; return }
            try {
              const plan = parseDreamPlan(parse(raw), changedPaths, allowedSourceIds, remainingAtStart)
              const operations = plan.operations
              const validated: PreparedOperation[] = []
              const plannedByPath = new Map<string, { evidence: DocumentSourceRef[], reads: Array<{ id: string, revision: string, usageVersion: number }> }>()
              for (const operation of operations) {
                const opFiles = operation.dailyPaths.map(path => noteByPath.get(path)!)
                const opFileSourceMap = new Map(mergeDocumentSources(opFiles.flatMap(file => file.sources)).map(ref => [ref.id, ref]))
                const opRefs = operation.sourceIds.map(id => {
                  const ref = opFileSourceMap.get(id)
                  if (!ref) throw new Error('dream-source-outside-daily')
                  return ref
                })
                if (opRefs.some(ref => documentSourceRestricted(ref, restrictions))) throw new Error('dream-source-restricted')
                let before: MemoryDocumentView | null = null
                if (operation.action === 'CREATE') {
                  if (existingDigestCount > 0 && !tools.searched()) throw new Error('dream-search-required')
                  if (tools.searchIncomplete()) throw new Error('dream-search-incomplete')
                  if (documents.locatorRetired(workspace, operation.path)
                    || documents.read(workspace, operation.path, { includeDisabled: true }) !== null
                    || policy.read(workspace, operation.path) !== null) {
                    throw new Error('dream-target-unavailable')
                  }
                } else {
                  if (!tools.bodyRead(operation.path)) throw new Error('dream-read-target-first')
                  before = tools.observed(operation.path)
                  if (!before || !before.backing) throw new Error('dream-refine-target-missing')
                }
                const markdown = formatDigestMarkdown(operation, before)
                const beforeLinkPaths = new Set(before ? memoryDocumentLinks(before.markdown).map(link => link.split('#')[0]!) : [])
                const referencedDigests: MemoryDocumentView[] = []
                const referencedPlanned: Array<{ evidence: DocumentSourceRef[], reads: Array<{ id: string, revision: string, usageVersion: number }> }> = []
                const linkedPaths = new Set<string>()
                for (const link of memoryDocumentLinks(markdown)) {
                  const targetPath = link.split('#')[0]!
                  if (targetPath === operation.path) continue
                  if (dailyPath.safeParse(targetPath).success) {
                    if (!operation.dailyPaths.includes(targetPath) && !beforeLinkPaths.has(targetPath)) {
                      throw new Error('dream-ungrounded-link')
                    }
                    continue
                  }
                  const observedDigest = tools.observed(targetPath)
                  const planned = plannedByPath.get(targetPath)
                  if (observedDigest) { referencedDigests.push(observedDigest); linkedPaths.add(targetPath) }
                  if (planned) { referencedPlanned.push(planned); linkedPaths.add(targetPath) }
                  if (!observedDigest && !planned && !beforeLinkPaths.has(targetPath)) throw new Error('dream-ungrounded-link')
                }
                const boundDigests = unique([...(before ? [before] : []), ...referencedDigests])
                const evidence = mergeDocumentSources([
                  ...boundDigests.flatMap(doc => doc.sourceTokens),
                  ...referencedPlanned.flatMap(item => item.evidence),
                  ...opRefs,
                  ...opRefs.flatMap(ref => questionContexts.get(ref.id) ?? []),
                ])
                if (!evidence.length || !refsCurrent(evidence)
                  || evidence.some(ref => documentSourceRestricted(ref, restrictions))
                  || !materialAllowed(markdown, evidence)
                  || project(markdown) !== markdown) {
                  throw new Error('dream-material-rejected')
                }
                const opReadsMap = new Map<string, { id: string, revision: string, usageVersion: number }>()
                for (const doc of boundDigests) {
                  if (doc.backing) {
                    opReadsMap.set(doc.backing.id, { id: doc.backing.id, revision: doc.backing.revision, usageVersion: doc.backing.usageVersion })
                  }
                }
                for (const item of referencedPlanned) {
                  for (const read of item.reads) opReadsMap.set(read.id, read)
                }
                const opReads = [...opReadsMap.values()]
                plannedByPath.set(operation.path, { evidence, reads: opReads })
                validated.push({
                  operation, before, markdown, evidence, reads: opReads, linkedPaths: [...linkedPaths],
                  files: opFiles.map(file => ({ path: file.path, revision: file.revision })),
                })
              }
              prepared = { operations: validated, hasMore: plan.hasMore }
            } catch (error) {
              const reason = error instanceof Error ? error.message : 'invalid-output'
              if (reason === 'dream-search-incomplete') { retry = true; return }
              retryHint = retryHintFor(reason)
              progress(job, 'validation_failed', 'consolidate', attempt)
            }
          } catch (error) {
            if (error instanceof MemoryComputeError && error.reason === 'context-window-exceeded' && await inputsCurrent()) {
              progress(job, 'oversized', 'consolidate', attempt)
              if (batch.length > 1) await split()
              else {
                oversizedAny = true
                transaction(() => {
                  const file = fileRefs[0]!
                  if (fileCurrent(file)) notes.markProcessed(file.key, file.checkpoint)
                })
              }
              return
            }
            if (error instanceof RequestTimeout) { retry = true; return }
            if (error instanceof MemoryDreamStaleError) { progress(job, 'source_changed', 'consolidate', attempt); retry = true; return }
            if (!isModelTimeout(error)) progress(job, safeDiagnosticReason(error), 'consolidate', attempt)
            stopPass = true
            retry = true
            return
          }
        }

        if (!prepared || !await inputsCurrent()) {
          stopPass = !prepared
          retry = true
          return
        }

        const hitLimit = prepared.operations.length > 0 && prepared.operations.length >= remainingAtStart
        const coveredPaths = new Set(prepared.operations.flatMap(item => item.operation.dailyPaths))
        // Explicit hasMore defers the entire batch (including a single multi-topic daily note).
        // Without hasMore, an exact-cap pass checkpoints covered files so it cannot loop forever,
        // while keeping any unreferenced files in a multi-file batch pending for retry.
        const checkpointRefs = prepared.hasMore
          ? []
          : hitLimit
            ? fileRefs.filter(file => coveredPaths.has(file.path))
            : fileRefs
        const checkpointPaths = checkpointRefs.map(file => file.path)
        const deferRetry = prepared.hasMore || checkpointRefs.length < fileRefs.length
        const persistedOps: PersistedOperation[] = prepared.operations.map(item => ({
          operationId: `dream:${identity.newId()}`,
          action: item.operation.action,
          path: item.operation.path,
          expectedRevision: item.before?.revision ?? null,
          markdown: item.markdown,
          sources: item.evidence,
          reads: item.reads,
          linkedPaths: item.linkedPaths,
          files: item.files,
        }))
        if (persistedOps.length > 0) {
          const nextPending: PersistedBatch = { workspace, fileRefs, operations: persistedOps, checkpointPaths }
          if (!effects.amend(job, { pendingBatch: nextPending })) return
        }

        const commitOutcome = await commitBatchOperations(workspace, persistedOps, {
          async verifyOp() {
            if (await inputsCurrent()) return 'ready'
            clearPendingBatch()
            progress(job, 'source_changed', 'consolidate')
            return 'stale'
          },
          assertMutateCurrent() {
            if (!current()) throw new MemoryDreamStaleError()
          },
          onCommittedPath(path) {
            committedPaths.add(path)
          },
        })
        if (commitOutcome === 'cancelled') return
        if (commitOutcome !== 'done') {
          if (commitOutcome === 'retry') stopPass = true
          retry = true
          return
        }
        if (persistedOps.length > 0) clearPendingBatch()

        if (deferRetry) retry = true
        if (checkpointRefs.length) await checkpointFiles(checkpointRefs)
      }

      for (const batch of batchDreamNotes(candidates, dreamBatchBytes)) await consume(batch)
    }

    if (!effects.holds(job)) return 'done'
    if (retry) return 'retry'
    transaction(() => {
      const at = now()
      store.setMeta('dream.lastCheckedAt', String(at))
      store.setMeta('dream.lastCheckResult', oversizedAny ? 'size-limit' : processedAny ? 'processed' : 'empty')
      const jobId = store.meta(MANUAL_JOB)
      if (jobId && store.meta(MANUAL_FOLLOWUP) === jobId) {
        store.setMeta(MANUAL_FOLLOWUP, '')
        effects.queue(DREAM, DAILY, null)
        void effects.wake()
        return
      }
      if (jobId) {
        const receipt: MemoryDreamStatus = { state: 'idle', ...dreamHistory(store), jobId, completedAt: at }
        store.setMeta(receiptKey(jobId), JSON.stringify(receipt))
        store.setMeta(MANUAL_JOB, '')
      }
      effects.finishGeneration(job)
      schedule()
    })
    return 'done'
  }

  effects.runs(DREAM, async jobs => {
    const outcomes = new Map<string, Outcome>()
    for (const job of jobs) {
      active = true
      waitingGeneration = null
      try {
        const outcome = await runJob(job)
        if (outcome === 'wait') waitingGeneration = job.generation
        outcomes.set(job.key, outcome)
        progress(job, outcome === 'retry' ? 'retry' : outcome === 'wait' ? 'external_wake' : 'normal')
      } catch (error) { progress(job, safeDiagnosticReason(error)); outcomes.set(job.key, 'retry') }
      finally { active = false }
    }
    return outcomes
  }, attempts => Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** attempts))
  transaction(() => { if (!effects.get(DREAM, DAILY)) schedule() })
  return {
    status,
    isRunning: () => active,
    request(operationId = identity.newId()) {
      const key = requestKey(operationId)
      const prior = store.command(key)
      if (prior) {
        const saved = store.meta(receiptKey(prior.payload))
        return saved ? JSON.parse(saved) as MemoryDreamStatus : { ...status(), jobId: prior.payload, completedAt: null }
      }
      const state = status().state
      const joined = store.meta(MANUAL_JOB)
      const jobId = joined || operationId
      transaction(() => {
        if (!joined && active) store.setMeta(MANUAL_FOLLOWUP, jobId)
        if (state !== 'running' && state !== 'queued') effects.queue(DREAM, DAILY, effects.get(DREAM, DAILY)?.payload ?? null)
        store.setMeta(MANUAL_JOB, jobId)
        store.recordCommand(key, 'dream.request', jobId, null)
      })
      if (state !== 'running') void effects.wake()
      return { ...status(), jobId, completedAt: null }
    },
    run() {
      transaction(() => effects.queue(DREAM, DAILY, effects.get(DREAM, DAILY)?.payload ?? null))
      void effects.wake()
    },
    withdraw(sourceId: string) {
      const job = effects.get(DREAM, DAILY)
      if (job) {
        transaction(() => {
          if (active) {
            effects.cancel(DREAM, DAILY)
            if (store.meta(MANUAL_JOB)) {
              store.setMeta(MANUAL_FOLLOWUP, '')
              effects.queue(DREAM, DAILY, null)
              void effects.wake()
            } else schedule()
          } else if (pendingBatchOf(job.payload)) {
            effects.amend(job, {})
          }
        })
      }
      void sourceId
    },
  }
}
