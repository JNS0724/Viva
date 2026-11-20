import { guardDiagnosticPort, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort, DiagnosticReason, DiagnosticStage } from '../../diagnostics/contracts.ts'
import { MemoryComputeError } from '../contracts/compute.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { dailyPath, digestPath, parseDreamOperations } from '../contracts/memory-file-contract.ts'
import type { DreamOperation } from '../contracts/memory-file-contract.ts'
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
import { parseMemoryMarkdown } from './memory-markdown.ts'
import { createMemoryDocumentReadPolicy, createMemoryDocumentEvidence, mergeDocumentSources } from './memory-document-read-policy.ts'
import { createRequestBudget, RequestTimeout } from '../../shared/request-budget.ts'
import type { MemoryDocumentReadBatch, MemoryDocumentView } from './memory-document-read-policy.ts'
import { documentSourceRestricted, projectDocumentSource } from './memory-document-restrictions.ts'
import { DREAM_CONSOLIDATE_SYSTEM } from './memory-dream-prompts.ts'

export class MemoryDreamStaleError extends Error {
  constructor() { super('memory-dream-readset-stale'); this.name = 'MemoryDreamStaleError' }
}

export type DreamCalculate = (request: {
  job: Effect, stage: 'consolidate', system: string, input: object,
  sourceIds: () => readonly string[], current: () => boolean, observe?: (signal?: AbortSignal) => Promise<() => boolean>,
}) => Promise<string | undefined>

type FileRef = {
  key: string
  workspace: string
  path: string
  revision: string
  policyToken: string
  checkpoint: number
  sources: DocumentSourceRef[]
  reads: Array<{ id: string, revision: string, usageVersion: number }>
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

const DAILY = 'daily'
const MANUAL_JOB = 'dream.manualJob'
const MANUAL_FOLLOWUP = 'dream.manualFollowup'
const CANDIDATE_DIGEST_LIMIT = 8
const requestKey = (id: string) => `dream.request:${id}`
const receiptKey = (id: string) => `dream.receipt:${id}`
const DAY_MS = 86_400_000
const unique = <T>(values: readonly T[]) => [...new Set(values)]
const parse = (text: string) => JSON.parse(text) as unknown
const isModelTimeout = (error: unknown) => error instanceof MemoryComputeError && error.reason === 'timeout'

function documentLinks(markdown: string): string[] {
  return unique(parseMemoryMarkdown(markdown).links
    .filter(link => dailyPath.safeParse(link.path).success || digestPath.safeParse(link.path).success)
    .map(link => link.path + (link.anchor === undefined ? '' : `#${link.anchor}`)))
}

function digestNameAndDescription(path: string, markdown: string) {
  const { metadata } = parseMemoryDocument(markdown)
  const name = typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : path.split('/').at(-1)!.replace(/\.md$/u, '')
  const description = typeof metadata.description === 'string' ? metadata.description : ''
  return { name, description }
}

function formatDigestMarkdown(operation: DreamOperation, before: MemoryDocumentView | null) {
  const existingLinks = before ? documentLinks(before.markdown) : []
  const bodyLinks = documentLinks(operation.body)
  const presentExact = new Set(bodyLinks)
  const presentPaths = new Set(bodyLinks.map(link => link.split('#')[0]!))
  const missingExisting = existingLinks.filter(link => !presentExact.has(link))
  for (const link of missingExisting) presentPaths.add(link.split('#')[0]!)
  const missingDaily = operation.dailyPaths.filter(path => !presentPaths.has(path))
  const missing = unique([...missingExisting, ...missingDaily])
  let body = operation.body.trimEnd()
  if (missing.length) {
    const lines = missing.map(link => `- [[${link}]]`).join('\n')
    const hasSourcesHeading = /(?:^|\n)#{1,6}\s+(?:Sources|来源|来源依据)\s*(?:\n|$)/iu.test(body)
    body = hasSourcesHeading ? `${body}\n${lines}` : `${body}\n\n## Sources\n${lines}`
  }
  const previousMetadata = before ? parseMemoryDocument(before.markdown).metadata : {}
  return formatMemoryDocument({
    metadata: { ...previousMetadata, name: operation.name, description: operation.description },
    body,
  })
}

function shrinkCandidateDigests(digests: readonly MemoryDocumentView[]): MemoryDocumentView[] {
  if (!digests.length) return []
  const underCap = digests.filter(doc => doc.markdown.length <= defaults.dreamFileChars)
  if (underCap.length < digests.length) return underCap
  const dropCount = Math.max(1, Math.ceil(digests.length / 2))
  const bySize = [...digests].sort((a, b) => b.markdown.length - a.markdown.length || b.path.localeCompare(a.path))
  const drop = new Set(bySize.slice(0, dropCount).map(doc => doc.path))
  return digests.filter(doc => !drop.has(doc.path))
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

/** Single-stage document consolidation: local candidate recall, structured JSON merge, and deterministic guards. */
export function createMemoryDreamJobs({ notes, documents, effects, store, identity, now, settings, readable, eligible, source, reference,
  calculate, transaction, mutate, readPhysicalFile, digestNodes, committed = () => {}, allowsText = () => true, diagnostics: diagnosticPort }: {
  store: Pick<MemoryStore, 'meta' | 'setMeta' | 'command' | 'recordCommand'>, notes: MemoryNotes, documents: MemoryDocuments, effects: Effects, identity: MemoryIdentity, now: () => number,
  settings?: DailyMemorySettings, readable: (id: string) => boolean, eligible: (source: MemorySource) => boolean,
  source: (id: string) => MemorySource | undefined, reference: (id: string) => MemorySourceReference | null,
  calculate: DreamCalculate, transaction: (write: () => void) => void, mutate: <T>(write: () => T) => Promise<T>, committed?: (receipt: DocumentReceipt) => void,
  digestNodes?: MemoryFileIndex['digestNodes'], readPhysicalFile?: ReadMemoryPhysicalFile, allowsText?: (text: string, source: MemorySource) => boolean,
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
  function dependencies(files: readonly FileRef[]): Location[] {
    return files.flatMap(file => [file, ...file.reads.flatMap(ref => {
      const target = documents.indexFile(file.workspace, ref.id)
      return target ? [{ workspace: file.workspace, path: target.path }] : []
    })])
  }
  const readsCurrent = (files: readonly FileRef[], batch?: MemoryDocumentReadBatch) => files.every(file => file.reads.every(ref => {
    const target = documents.indexFile(file.workspace, ref.id)
    const doc = target && documents.read(file.workspace, target.path, { physical: batch?.physical(file.workspace, target.path) })
    return doc?.id === ref.id && doc.revision === ref.revision && doc.usageVersion === ref.usageVersion
  }))
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

  async function recallCandidateDigests(workspace: string, notesText: string, signal?: AbortSignal) {
    const terms = new Set(memorySearchTokens(notesText, false))
    const published = new Map(digestNodes?.(workspace).map(node => [node.id, node]))
    const restrictions = documents.sourceRestrictions(workspace)
    const entries = (restrictions.length
      ? documents.registered(workspace).filter(doc => !doc.sources.some(ref => documentSourceRestricted(ref, restrictions)))
      : documents.fileRegistry(workspace)).filter(row => row.state === 'active')
    const scored: Array<{ path: string, score: number }> = []
    let yieldAt = performance.now() + 4
    for (const row of entries) {
      if (performance.now() >= yieldAt) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        signal?.throwIfAborted()
        yieldAt = performance.now() + 4
      }
      const node = published.get(row.id)
      let words: string[] | undefined
      if (node && node.revision === row.revision && node.usageVersion === row.usageVersion && node.path === row.path) {
        const name = node.name || row.path.split('/').at(-1)!.replace(/\.md$/u, '')
        words = memorySearchTokens(`${name} ${node.description}`, true)
      } else {
        const accepted = documents.acceptedSnapshot(workspace, row.id)
        if (accepted) {
          const { name, description } = digestNameAndDescription(accepted.path, accepted.markdown)
          words = memorySearchTokens(`${name} ${description}`, true)
        }
      }
      const score = words ? unique(words.filter(word => terms.has(word))).length : 0
      if (entries.length <= CANDIDATE_DIGEST_LIMIT || !words || score > 0) scored.push({ path: row.path, score })
    }
    const selected = scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, CANDIDATE_DIGEST_LIMIT).map(item => item.path)
    const batch = selected.length ? await loadFiles(selected.map(path => ({ workspace, path })), signal, true) : undefined
    let incomplete = false
    const digests: MemoryDocumentView[] = []
    for (const path of selected) {
      const view = batch ? batch.readObservation(workspace, path) : policy.read(workspace, path)
      if (view === undefined) { incomplete = true; continue }
      if (view && view.currentMarkdown !== null && view.applicability.state === 'current') digests.push(view)
    }
    return { digests, incomplete }
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
      if (view && view.applicability.state !== 'unavailable') {
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

      const consume = async (batch: Note[]): Promise<void> => {
        if (stopPass || !effects.holds(job)) return
        if (operationsUsed >= dreamUnits) { retry = true; return }
        const seen = batch.map(note => initialViews.get(note.key)!)
        const fileRefs: FileRef[] = batch.map((note, index) => {
          const view = seen[index]!
          return {
            key: note.key, workspace: note.workspace, path: note.path, revision: note.fileRevision,
            policyToken: view.policyToken, checkpoint: note.revision, sources: view.sourceTokens,
            reads: view.supporting.map(doc => ({ id: doc.id, revision: doc.revision, usageVersion: doc.usageVersion })),
          }
        })
        const restrictions = documents.sourceRestrictions(workspace)
        const recalled = await recallCandidateDigests(workspace, seen.map(view => view.markdown).join('\n'))
        let activeDigests = recalled.digests

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

        const activeDigestReads = () => activeDigests.flatMap(doc => [...(doc.backing ? [doc.backing] : []), ...doc.supporting])
        const activeReadSources = () => mergeDocumentSources([
          ...batchSourceMap.values(),
          ...[...questionContexts.values()].flat(),
          ...activeDigests.flatMap(doc => [...doc.sourceTokens, ...(doc.correctionSources ?? [])]),
        ])
        const committedPaths = new Set<string>()
        const current = (observed?: MemoryDocumentReadBatch) => {
          const readSources = activeReadSources()
          return effects.holds(job)
            && fileRefs.every(ref => fileCurrent(ref, observed))
            && readsCurrent(fileRefs, observed)
            && seen.every(snapshot => (observed ?? policy).read(workspace, snapshot.path)?.policyToken === snapshot.policyToken)
            && refsCurrent(readSources)
            && readSources.every(ref => { const item = source(ref.id); return Boolean(item && eligible(item)) })
            && [...questionContexts].every(([id, expected]) => {
              const latest = notes.sourceQuestionContext(id)
              return latest.current && JSON.stringify(latest.refs) === JSON.stringify(expected)
            })
            && activeDigests.every(doc => committedPaths.has(doc.path) || (observed ?? policy).read(workspace, doc.path)?.policyToken === doc.policyToken)
            && activeDigestReads().every(doc => {
              if (committedPaths.has(doc.path)) return true
              const latest = documents.read(workspace, doc.path, { physical: observed?.physical(workspace, doc.path) })
              return latest?.id === doc.id && latest.revision === doc.revision && latest.usageVersion === doc.usageVersion
            })
        }
        const locations = () => [...dependencies(fileRefs), ...activeDigests.map(doc => ({ workspace, path: doc.path })),
          ...activeDigestReads().map(doc => ({ workspace, path: doc.path }))]
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
        let prepared: PreparedOperation[] | undefined
        let retryHint: string | undefined

        consolidate: while (true) {
          const existingByPath = new Map(activeDigests.map(doc => [doc.path, doc]))
          for (let attempt = 0; attempt < 2 && !prepared; attempt++) {
            const remaining = dreamUnits - operationsUsed
            const input = {
              maxOperations: remaining,
              notes: batch.map((note, index) => {
                const snapshot = seen[index]!
                const name = parseMemoryDocument(snapshot.markdown).metadata.name
                const chars = [...snapshot.markdown]
                return {
                  path: note.path,
                  title: typeof name === 'string' ? name : '',
                  markdown: chars.slice(0, defaults.dreamFileChars).join('') + (chars.length > defaults.dreamFileChars ? '\n\n[truncated]' : ''),
                  sourceIds: fileRefs[index]!.sources.map(ref => ref.id),
                  applicability: snapshot.applicability,
                  replacements: snapshot.supporting.map(doc => ({ path: doc.path, revision: doc.revision, markdown: doc.markdown })),
                }
              }),
              canonicalSources,
              existingDigests: activeDigests.map(doc => {
                const { name, description } = digestNameAndDescription(doc.path, doc.markdown)
                return { path: doc.path, name, description, markdown: doc.markdown }
              }),
              ...(retryHint ? { retry: retryHint } : {}),
            }
            if (batch.length > 1 && dreamBatchBytes && new TextEncoder().encode(JSON.stringify(input)).length > dreamBatchBytes) {
              if (activeDigests.some(doc => doc.markdown.length > defaults.dreamFileChars)) {
                activeDigests = shrinkCandidateDigests(activeDigests)
                retryHint = undefined
                continue consolidate
              }
              await split()
              return
            }
            try {
              const raw = await calculateStage({
                job, stage: 'consolidate', system: DREAM_CONSOLIDATE_SYSTEM, input,
                sourceIds: () => activeReadSources().map(ref => ref.id), current, observe,
              })
              if (raw === undefined) { progress(job, 'unavailable', 'consolidate', attempt); stopPass = true; retry = true; return }
              if (!await inputsCurrent()) { progress(job, 'source_changed', 'consolidate', attempt); retry = true; return }
              try {
                const operations = parseDreamOperations(parse(raw), changedPaths, allowedSourceIds, remaining)
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
                    if (recalled.incomplete) throw new Error('dream-candidates-incomplete')
                    if (documents.locatorRetired(workspace, operation.path)
                      || documents.read(workspace, operation.path, { includeDisabled: true }) !== null
                      || policy.read(workspace, operation.path) !== null) {
                      throw new Error('dream-target-unavailable')
                    }
                  } else {
                    before = existingByPath.get(operation.path) ?? null
                    if (!before || !before.backing) throw new Error('dream-refine-target-missing')
                  }
                  const markdown = formatDigestMarkdown(operation, before)
                  const beforeLinkPaths = new Set(before ? documentLinks(before.markdown).map(link => link.split('#')[0]!) : [])
                  const referencedDigests: MemoryDocumentView[] = []
                  const referencedPlanned: Array<{ evidence: DocumentSourceRef[], reads: Array<{ id: string, revision: string, usageVersion: number }> }> = []
                  const linkedPaths = new Set<string>()
                  for (const link of documentLinks(markdown)) {
                    const targetPath = link.split('#')[0]!
                    if (targetPath === operation.path) continue
                    if (dailyPath.safeParse(targetPath).success) {
                      if (!operation.dailyPaths.includes(targetPath) && !beforeLinkPaths.has(targetPath)) {
                        throw new Error('dream-ungrounded-link')
                      }
                      continue
                    }
                    const recalledDigest = existingByPath.get(targetPath)
                    const planned = plannedByPath.get(targetPath)
                    if (recalledDigest) { referencedDigests.push(recalledDigest); linkedPaths.add(targetPath) }
                    if (planned) { referencedPlanned.push(planned); linkedPaths.add(targetPath) }
                    if (!recalledDigest && !planned && !beforeLinkPaths.has(targetPath)) throw new Error('dream-ungrounded-link')
                  }
                  const boundDigests = unique([...(before ? [before] : []), ...referencedDigests])
                  const evidence = mergeDocumentSources([
                    ...boundDigests.flatMap(doc => [...doc.sourceTokens, ...(doc.correctionSources ?? [])]),
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
                    for (const read of [...(doc.backing ? [doc.backing] : []), ...doc.supporting]) {
                      opReadsMap.set(read.id, { id: read.id, revision: read.revision, usageVersion: read.usageVersion })
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
                prepared = validated
              } catch (error) {
                const reason = error instanceof Error ? error.message : 'invalid-output'
                if (reason === 'dream-candidates-incomplete') { retry = true; return }
                retryHint = 'The prior JSON had an invalid shape, target path, budget, or source reference. Correct it using only the supplied inputs.'
                progress(job, 'validation_failed', 'consolidate', attempt)
              }
            } catch (error) {
              if (error instanceof MemoryComputeError && error.reason === 'context-window-exceeded' && await inputsCurrent()) {
                progress(job, 'oversized', 'consolidate', attempt)
                if (activeDigests.length > 0 && (batch.length === 1 || activeDigests.some(doc => doc.markdown.length > defaults.dreamFileChars))) {
                  activeDigests = shrinkCandidateDigests(activeDigests)
                  retryHint = undefined
                  continue consolidate
                }
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
              if (!isModelTimeout(error)) progress(job, safeDiagnosticReason(error), 'consolidate', attempt)
              stopPass = true
              retry = true
              return
            }
          }
          break consolidate
        }

        if (!prepared || !await inputsCurrent()) {
          stopPass = !prepared
          retry = true
          return
        }

        const committedReads = new Map<string, { id: string, revision: string, usageVersion: number }>()
        const committedByPath = new Map<string, { id: string, revision: string, usageVersion: number }>()
        for (const item of prepared) {
          if (!await inputsCurrent()) { retry = true; return }
          const operationId = `dream:${identity.newId()}`
          const reads = new Map(item.reads.map(ref => [ref.id, committedReads.get(ref.id) ?? ref]))
          for (const linkedPath of item.linkedPaths) {
            const committedTarget = committedByPath.get(linkedPath)
            if (committedTarget) reads.set(committedTarget.id, committedTarget)
          }
          try {
            const receipt = await mutate(() => {
              if (!current()) throw new MemoryDreamStaleError()
              return documents.commit({
                operationId, workspace, path: item.operation.path,
                expectedRevision: item.before?.revision ?? null,
                markdown: item.markdown, action: item.operation.action,
                sources: item.evidence, reads: [...reads.values()], corrections: [], files: item.files,
              })
            })
            operationsUsed++
            committedPaths.add(item.operation.path)
            if (receipt.revision !== null) {
              const nextRead = { id: receipt.documentId, revision: receipt.revision, usageVersion: receipt.usageVersion }
              committedReads.set(receipt.documentId, nextRead)
              committedByPath.set(item.operation.path, nextRead)
            }
            committed(receipt)
            diagnostics.emit({
              event: 'operation.progress', operation: 'memory.write', stage: 'applied',
              identities: { requestId: operationId, jobId: job.key, generation: job.generation, resourceId: receipt.documentId, methodId: receipt.action },
              metrics: { count: item.evidence.length },
            })
          } catch (error) {
            if (!effects.holds(job)) return
            progress(job, error instanceof MemoryDreamStaleError ? 'source_changed' : safeDiagnosticReason(error), 'consolidate')
            retry = true
            return
          }
        }

        const checkpointBatch = await loadFiles(fileRefs, undefined, true)
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
        if (committedPaths.size && recalled.incomplete) retry = true
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
        if (state !== 'running' && state !== 'queued') effects.queue(DREAM, DAILY, null)
        store.setMeta(MANUAL_JOB, jobId)
        store.recordCommand(key, 'dream.request', jobId, null)
      })
      if (state !== 'running') void effects.wake()
      return { ...status(), jobId, completedAt: null }
    },
    run() {
      transaction(() => effects.queue(DREAM, DAILY, null))
      void effects.wake()
    },
    withdraw(sourceId: string) {
      const job = effects.get(DREAM, DAILY)
      if (job && active) {
        transaction(() => {
          effects.cancel(DREAM, DAILY)
          if (store.meta(MANUAL_JOB)) {
            store.setMeta(MANUAL_FOLLOWUP, '')
            effects.queue(DREAM, DAILY, null)
            void effects.wake()
          } else schedule()
        })
      }
      void sourceId
    },
  }
}
