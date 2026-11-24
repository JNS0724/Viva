import { DAILY_MEMORY_DEFAULTS } from '../contracts/memory-daily-defaults.ts'
import { createRequestBudget, RequestTimeout } from '../../shared/request-budget.ts'
import { z } from 'zod'
import { beginDiagnosticOperation } from '../../diagnostics/operation.ts'
import type { MemoryDomainErrorCode, MemoryDomainErrorDetails } from '../contracts/domain-error.ts'
import type { MemoryComputeTools } from '../contracts/compute.ts'
import type { MemoryEmbedder } from '../contracts/embedding.ts'
import type {
  MemoryFileCreateRequest, MemoryFileEditRequest,
  MemoryFileForgetRequest,
  MemoryFileListRequest,
  MemoryFileMutation, MemoryFileMutationResult,
  MemoryFileSetEnabledRequest, MemoryFileUndoRequest,
  MemoryManagedFileIdentity
} from '../contracts/file-management.ts'
import { memoryFileMutation } from '../contracts/file-management.ts'
import { digestPath } from '../contracts/memory-file-contract.ts'
import type { AutomaticRecallResult, MemoryCompute, MemoryRequest, MemoryScope, MemorySpan } from '../contracts/memory-contract.ts'
import { operationId } from '../contracts/memory-contract.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import { MAX_MESSAGE_CHARS } from '../contracts/text-limits.ts'
import { localDay, nextDay } from './memory-calendar.ts'
import type { MemoryDocumentReadBatch, MemoryDocumentView } from './memory-document-read-policy.ts'
import { createMemoryDocumentEvidence, createMemoryDocumentReadPolicy, fileDependency } from './memory-document-read-policy.ts'
import { documentSourceProofCurrent } from './memory-source-proof.ts'
import { formatMemoryDocument, parseMemoryDocument } from './memory-document.ts'
import { stripTrustedMemoryLinks } from './memory-dream-material.ts'
import { memoryDocumentLinks } from './memory-dream-tools.ts'
import type { DreamCalculate } from './memory-dream-jobs.ts'
import { guardDiagnosticPort, NO_DIAGNOSTICS, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort } from '../../diagnostics/contracts.ts'
import type { DiagnosticOutcome, DiagnosticReason } from '../../diagnostics/contracts.ts'
import type { MemoryDreamStatus } from '../contracts/dream-status.ts'
import { createMemoryDreamJobs, dreamHistory } from './memory-dream-jobs.ts'
import { createMemoryFileManagement } from './memory-file-management.ts'
import type { FileSearchResult } from './memory-file-retrieval.ts'
import { createMemoryFileRetrieval } from './memory-file-retrieval.ts'
import { createMemoryNoteJobs } from './memory-note-jobs.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import {
  isResidentProfileIdentity, MAX_PROFILE_L2_CHARS, measureConfirmedSectionL2,
  mergeUserProfileEdit, projectProfileL2, RESIDENT_PROFILE_PATH, userWorkspaceId,
} from './resident-profile.ts'
import { looksSecret } from './memory-sensitive.ts'
import type { DocumentReceipt, DocumentSourceRef, MemoryDocuments } from './ports/documents.ts'
import type { Effect, Outcome } from './ports/effects.ts'
import type { MemoryFileIndexChanges, MemoryRuntimeResources } from './ports/runtime.ts'
import type { MemoryFileDependency, MemorySource, MemoryStore } from './ports/store.ts'
import type { MemoryPresentation } from './presentation.ts'
import { defaultMemoryText, MemoryDomainError } from './presentation.ts'
import { contextAllows } from './scope.ts'

type FileMutationCommitted = (result: MemoryFileMutationResult, affectedSources?: readonly MemorySourceReference[]) => void

// Bound the serialized tool response, including evidence, escaped characters and metadata.
export const MAX_RECALL_CHARS = 6000
export const MAX_DEEP_RECALL_CHARS = 12000
const USER = { kind: 'user' } as const
type FileProfileScope = { kind: 'user' } | { kind: 'project', id: string }
type Origin = { conversation: string | null, session: string | null, scope?: MemoryScope, context?: MemoryScope, project?: Extract<FileProfileScope, { kind: 'project' }>, foregroundTurn?: string, turn?: string }
type AnswerSource = { question: string, requestId: string, questionId: string, custom?: true, questionAt?: number, questionProfileGen?: number }
type Receipt = { sourceId: string, outcome: string }
type MemoryInterval = { from: number | null, to: number | null }
type Route = { provider: string, model: string }

const textOf = (result: object) => JSON.stringify(result)
const sameScope = (a: MemoryScope, b: MemoryScope) => a.kind === b.kind && (a.kind === 'user' || 'id' in b && a.id === b.id)

const INDEX_PUBLISH = 'memory.file-index-publish'
const INDEX_SEED = 'memory.file-index-seed'
const DOCUMENT_CLEANUP = 'memory.document-cleanup'
export const publicationEffectKinds: ReadonlySet<string> = new Set([INDEX_PUBLISH, INDEX_SEED, DOCUMENT_CLEANUP])

export function createMemoryRuntime({ store, resources, presentation = {}, compute, route, embedder, changed, injected: _injected,
  dailyNotes = false, diagnostics: providedDiagnostics = NO_DIAGNOSTICS,
  canCommit, now = Date.now, timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone }: {
  store: MemoryStore,
  diagnostics?: DiagnosticPort,
  resources: MemoryRuntimeResources,
  presentation?: MemoryPresentation,
  compute: (request: MemoryCompute, signal?: AbortSignal, tools?: MemoryComputeTools) => Promise<string> | null,
  route: () => Route | null,
  embedder?: Pick<MemoryEmbedder, 'fingerprint' | 'dimensions' | 'embedBatch' | 'close'>,
  dailyNotes?: boolean | DailyMemorySettings,
  changed: (change: { revision: number }) => void,
  now?: () => number,
  timezone?: () => string,
  injected?: (session: string, turn: number, pushed: Array<{ text: string, names: string[] }>) => void,
  canCommit: (source: MemorySource) => boolean,
}) {
  const { effects, identity: { newId: randomUUID, hash: memoryHash } } = resources
  const userWorkspace = userWorkspaceId(memoryHash)
  const diagnostics = guardDiagnosticPort(providedDiagnostics)
  const presentMessage = presentation.text ?? defaultMemoryText
  const domainError = (code: MemoryDomainErrorCode, details?: MemoryDomainErrorDetails) =>
    new MemoryDomainError(code, presentMessage(code, details ? { limit: details.limit, actual: details.actual } : {}), details)
  let documents: MemoryDocuments | null = null
  let closed = false

  function publish(revision: number) {
    try { changed({ revision }) } catch (error) {
      diagnostics.emit({ event: 'operation.progress', operation: 'memory.write', stage: 'checkpoint', reason: safeDiagnosticReason(error), metrics: { mark: revision } })
    }
  }

  function createSource(text: string, origin: Origin, operation: string, author: MemorySource['author'], answer?: AnswerSource, captured?: { at: number, timezone: string }) {
    const id = operationId.parse(operation)
    const denied = looksSecret(text) || (answer !== undefined && looksSecret(answer.question)) || (author === 'answer' && !answer?.custom)
    const hash = denied ? null : memoryHash(text)
    const existing = store.readSource(id)
    if (existing) {
      if (existing.author !== author || existing.conversation !== origin.conversation || (existing.hash !== null && existing.hash !== memoryHash(text))
        || existing.requestId !== (answer?.requestId ?? null) || existing.questionId !== (answer?.questionId ?? null)) throw domainError('operation.conflict')
      return existing
    }
    const source: MemorySource = {
      id, operation: id, version: 1, conversation: origin.conversation, session: origin.session,
      scope: origin.scope ?? USER, context: origin.context ?? origin.project ?? origin.scope ?? USER, project: origin.project ?? null, author, text: denied ? null : text, hash,
      length: denied ? 0 : text.length,
      question: answer && !denied ? answer.question.slice(0, 1000) : null,
      questionAt: answer && !denied ? (answer.questionAt ?? null) : null,
      questionProfileGen: answer && !denied ? (answer.questionProfileGen ?? null) : null,
      requestId: answer?.requestId ?? null, questionId: answer?.questionId ?? null,
      at: captured?.at ?? now(), timezone: captured?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      outcome: denied ? 'rejected' : 'received',
    }
    store.insertSource(source)
    return source
  }

  function accept(text: string, origin: Origin, operation: string = randomUUID(), answer?: AnswerSource, intake?: { deferAutomatic?: boolean, at: number, timezone: string }): Receipt {
    const source = store.tx(() => {
      const known = store.readSource(operation)
      const current = createSource(text, origin, operation, answer === undefined ? 'user' : 'answer', answer, intake)
      if (!current.text || known && known.outcome !== 'received') return current
      const outcome = intake?.deferAutomatic ? 'received' : dailyNotes ? 'note-pending' : 'recorded'
      store.outcome(current.id, outcome)
      return { ...current, outcome }
    })
    return { sourceId: source.id, outcome: source.outcome }
  }

  async function calculate(source: MemorySource, job: Effect, model: Route,
    stage: MemoryCompute['stage'], input: object, contextSources: readonly string[], system: string, stillCurrent: () => boolean) {
    const id = randomUUID(), token = resources.sourceToken(source)
    const current = () => {
      if (closed || !stillCurrent() || !effects.holds(job)) return false
      const latest = store.readSource(source.id)
      return Boolean(latest?.text && latest.version === source.version && latest.hash === source.hash && latest.text === source.text
          && resources.sourceToken(latest) === token && latest.question === source.question)
        && contextSources.every(fileSourceCurrent)
    }
    const observation = beginDiagnosticOperation(diagnostics, stage === 'dream' ? 'memory.dream' : 'memory.daily', { stage: 'extract',
      identities: { requestId: id, jobId: job.key, generation: job.generation } })
    try {
      const result = compute({ id, sourceId: source.id, generation: job.generation, stage, ...model, system, input: JSON.stringify(input) })
      if (!result) { observation.end('failed', { reason: 'unavailable' }); return }
      const response = await result
      if (!current()) { observation.end('cancelled', { reason: 'source_changed' }); return }
      return JSON.parse(response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as unknown
    } catch (error) { observation.fail(error); throw error }
    finally { observation.end() }
  }

  const INDEX_SEEDED = 'memory-file-index-publication-v1'
  let deferIndexPublication = true
  const indexChanges: MemoryFileIndexChanges = {
    queue: queueFilePublication,
    publish(workspace, id) {
      if (!deferIndexPublication) void flushPublication(workspace, id).catch(() => {
        // The durable generation stays queued for retry.
      })
    },
  }
  function documentVisibilityChanged() {
    store.nextRevision()
  }
  function trustedEditLocators(workspace: string, beforeMarkdown?: string): string[] {
    if (!beforeMarkdown) return []
    const links = memoryDocumentLinks(beforeMarkdown)
    if (!links.length) return []
    const trusted: string[] = []
    for (const link of links) {
      const targetPath = link.split('#')[0]!
      if (targetPath.startsWith('daily/')) {
        if (/^daily\/\d{4}-\d{2}-\d{2}\/note-[a-f0-9]{64}\.md$/u.test(targetPath)
          || Boolean(notes?.storage.registeredAt(workspace, targetPath))) {
          trusted.push(targetPath)
        }
      } else if (digestPath.safeParse(targetPath).success
        && (/^digest\/(?:personal|procedure|wiki)\/manual-[a-f0-9]{64}\.md$/u.test(targetPath)
          || Boolean(documents?.read(workspace, targetPath, { includeDisabled: true })))) {
        trusted.push(targetPath)
      }
    }
    return trusted
  }
  documents = resources.openDocuments(id => fileSourceCurrent(id), () => {
    store.nextRevision()
  }, {
    managementCurrent: (before, guard, after, staged) => filePolicy?.managementCurrent(before, guard.policyToken, after, staged) === true,
    manualCurrent: (source, beforeMarkdown) => !closed && source.author === 'manual' && source.id === source.operation
      && !store.readSource(source.id)
      && source.text !== null && source.length === source.text.length && source.hash === memoryHash(source.text)
      && !looksSecret(stripTrustedMemoryLinks(source.text, trustedEditLocators(resources.sourceWorkspace(source), beforeMarkdown))),
    index: indexChanges, deferRecovery: true })
  const notes = createMemoryNoteJobs({
    store, effects, now, diagnostics, capture: Boolean(dailyNotes), openNotes: (readable, currentJob) => resources.openNotes(readable, currentJob, { onCommitted: documentVisibilityChanged, index: indexChanges, deferRecovery: true }), settings: typeof dailyNotes === 'object' ? dailyNotes : undefined,
    readable: id => fileSourceCurrent(id),
    eligible: source => !closed && canCommit(source),
    allowsText: (text) => !looksSecret(text),
    async calculate(job, source, stage, system, input, sources, current) {
      const model = route()
      if (model) return calculate(source, job, model, stage, input, sources, system, current)
    },
  })

  const queueIndexCleanup = () => effects.queue(DOCUMENT_CLEANUP, 'index', null)
  const fileIndex = resources.openFileIndex(queueIndexCleanup)
  // Older databases can have a pending checkpoint with no durable cleanup job.
  if (fileIndex.pendingCleanup()) queueIndexCleanup()
  const documentEvidence = notes && documents ? createMemoryDocumentEvidence({ notes: notes.storage, documents, hash: memoryHash,
      readable: id => fileSourceCurrent(id), source: id => store.readSource(id) ?? undefined,
      allowsText: (text) => !looksSecret(text),
    }) : null
  function reference(id: string) {
    const source = store.readSource(id)
    return source && fileSourceCurrent(id) ? { namespace: 'canonical', sourceId: id, revision: source.version } : null
  }
  const filePolicy: ReturnType<typeof createMemoryDocumentReadPolicy> | null = notes && documents && documentEvidence ? createMemoryDocumentReadPolicy({ notes: notes.storage, documents, hash: memoryHash,
    ...documentEvidence, reference, readPhysicalFile: resources.readPhysicalFile,
  }) : null
  const fileWorkspaces = () => [...new Set([...(notes?.storage.allocations().map(note => note.workspace) ?? []), ...(documents?.workspaces() ?? [])])]
  function dailySources(refs: readonly DocumentSourceRef[], markdown = ''): MemorySourceReference[] | null {
    if (!documentEvidence?.refsCurrent(refs) || !documentEvidence.materialAllowed(markdown, refs)) return null
    const items = [...new Set(refs.map(ref => ref.id))].map(reference)
    return items.every(item => item !== null) ? items : null
  }
  const fileManagement = filePolicy && documents ? createMemoryFileManagement({ policy: filePolicy, documents,
    workspaces: fileWorkspaces, locate: ({ workspace, id }) => resolveFileId(workspace, id), hash: memoryHash, editing: true,
    daily: notes && documentEvidence ? {
      allocations: notes.storage.allocations,
    } : undefined,
  }) : null
  // Only the trusted owner host API calls this management surface. Model requests retain
  // their narrower scoped fileAllowsOrigin checks and ordinary model read policy.
  const managementAllows = (view: MemoryDocumentView) => !closed && fileWorkspaces().includes(view.workspace)
  const noteFileId = (key: string) => `daily:${memoryHash(key)}`
  function resolveFileId(workspace: string, id: string) {
    if (!id.startsWith('daily:')) return documents?.indexFile(workspace, id)?.path ?? null
    const published = fileIndex?.snapshot(workspace, id)
    const registered = published && notes?.storage.registeredAt(workspace, published.path)
    if (published && registered && noteFileId(registered.key) === id) return published.path
    return notes?.storage.allocations().find(note => note.workspace === workspace && noteFileId(note.key) === id)?.path ?? null
  }
  const fileRetrieval = filePolicy && fileIndex ? createMemoryFileRetrieval({ index: fileIndex, policy: filePolicy,
    workspaces: fileWorkspaces, hash: memoryHash, embedder, now, diagnostics,
    resolveId: resolveFileId,
    onStale(file) { scheduleStaleProjection(file.workspace, file.id) },
  }) : null
  const staleProjections = new Map<string, { workspace: string, id: string }>()
  let staleProjectionTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleStaleProjection(workspace: string, id: string) {
    if (closed || staleProjections.size >= 128) return
    staleProjections.set(publicationKey(workspace, id), { workspace, id })
    if (staleProjectionTimer !== undefined) return
    staleProjectionTimer = setTimeout(() => {
      staleProjectionTimer = undefined
      if (closed) return
      try {
        store.tx(() => {
          for (const [key, file] of staleProjections) {
            if (!effects.get(INDEX_PUBLISH, key)) stagePublication(file.workspace, file.id, [file.id], true)
          }
        })
        void effects.wake()
      } catch (error) {
        diagnostics.emit({ event: 'operation.progress', operation: 'memory.index', stage: 'queued', reason: safeDiagnosticReason(error) })
      } finally { staleProjections.clear() }
    }, 0)
  }
  function publicationKey(workspace: string, id: string) { return JSON.stringify([workspace, id]) }
  const publicationPayload = z.object({ workspace: z.string().regex(/^[a-f0-9]{64}$/u), ids: z.array(z.string()), repairOnly: z.boolean().optional() })
  function stagePublication(workspace: string, id: string, ids: Iterable<string>, repairOnly = false) {
    const key = publicationKey(workspace, id)
    const previous = publicationPayload.safeParse(effects.get(INDEX_PUBLISH, key)?.payload)
    effects.queue(INDEX_PUBLISH, key, { workspace, ...(repairOnly ? { repairOnly: true } : {}), ids: [...new Set([...ids, ...(previous.success ? previous.data.ids : [])])] })
  }
  function queueFilePublication({ workspace, id }: Parameters<MemoryFileIndexChanges['queue']>[0]) {
    if (!fileRetrieval) return
    stagePublication(workspace, id, [id])
    void effects.wake()
  }
  function physicalRevision(workspace: string, id: string, path: string) {
    if (id.startsWith('daily:')) return notes?.storage.registeredAt(workspace, path)?.file_revision
    const file = documents?.indexFile(workspace, id)
    return file?.state === 'active' && file.path === path ? file.revision : undefined
  }
  function publicationTargets(workspace: string, ids: readonly string[], paths?: ReadonlyMap<string, string>) {
    return ids.flatMap(id => {
      const path = (paths ? paths.get(publicationKey(workspace, id)) : resolveFileId(workspace, id)) ?? fileIndex?.snapshot(workspace, id)?.path
      return path ? [{ id, workspace, path }] : []
    })
  }
  function publishFileEffect(job: Effect, paths?: ReadonlyMap<string, string>, batch?: MemoryDocumentReadBatch): Set<string> {
    const unresolved = new Set<string>()
    if (!fileRetrieval || !effects.holds(job)) return unresolved
    const parsed = publicationPayload.safeParse(job.payload)
    if (!parsed.success) { effects.finishGeneration(job); return unresolved }
    const { workspace, ids, repairOnly } = parsed.data
    const targets = publicationTargets(workspace, ids, paths).flatMap(({ id, path }) => {
      const observation = batch ? batch.readObservation(workspace, path) : filePolicy?.read(workspace, path)
      const view = observation ?? null
      // An inconclusive read leaves the projection alone. A write owes durable
      // publication, while a read-triggered repair finishes after this observation.
      const revision = !view && physicalRevision(workspace, id, path)
      if (revision && batch && observation === undefined) {
        if (!repairOnly) unresolved.add(id)
        return []
      }
      if (revision && !repairOnly) {
        try {
          const observed = batch ? batch.observedRevision(workspace, path) : resources.readFileRevisionAtCommit(workspace, path)
          if (observed !== revision) unresolved.add(id)
        }
        catch { unresolved.add(id) }
      }
      return [{ workspace, path, view }]
    })
    const apply = fileRetrieval.preparePublication(targets)
    store.tx(() => {
      if (!effects.holds(job)) return
      apply()
      if (!unresolved.size) effects.finishGeneration(job)
    })
    return unresolved
  }
  async function publishFileEffectInBackground(job: Effect, paths?: ReadonlyMap<string, string>) {
    const batch = filePolicy?.readBatch()
    const input = publicationPayload.safeParse(job.payload)
    if (batch && input.success && effects.holds(job)) {
      const budget = createRequestBudget(DAILY_MEMORY_DEFAULTS.fileVerificationBudgetMs)
      const entries = publicationTargets(input.data.workspace, input.data.ids, paths)
      const repair = input.data.repairOnly && entries[0]
      const stillCurrent = repair && fileRetrieval?.watchProjection(repair.workspace, repair.path)
      try {
        const targets = entries.filter(target => physicalRevision(target.workspace, target.id, target.path))
        await budget.run(() => batch.load(targets, budget.signal))
      } catch (error) {
        if (!(error instanceof RequestTimeout)) throw error
      }
      finally { budget.close() }
      if (!closed && stillCurrent && !stillCurrent()) {
        effects.finishGeneration(job)
        return new Set<string>()
      }
    }
    return closed ? new Set<string>() : publishFileEffect(job, paths, batch)
  }
  const publishing = new Map<string, { generation: number, work: Promise<Set<string>> }>()
  function publishOnce(job: Effect, paths?: ReadonlyMap<string, string>) {
    const prior = publishing.get(job.key)
    if (prior?.generation === job.generation) return prior.work
    const work = publishFileEffectInBackground(job, paths).finally(() => {
      if (publishing.get(job.key)?.work === work) publishing.delete(job.key)
    })
    publishing.set(job.key, { generation: job.generation, work })
    return work
  }
  async function flushPublication(workspace: string, id: string) {
    if (closed || deferIndexPublication || !fileRetrieval) return
    const key = publicationKey(workspace, id)
    const deadline = performance.now() + 1_000
    let job = effects.get(INDEX_PUBLISH, key)
    while (job) {
      const unresolved = await publishOnce(job)
      if (closed) throw domainError('change.pending')
      const latest = effects.get(INDEX_PUBLISH, key)
      if (!latest) return
      if (latest.generation === job.generation) {
        if (unresolved.has(id)) throw domainError('change.pending')
        return
      }
      // A restored daily note may publish a newer projection while its original
      // receipt is waiting. Join that generation up to the same caller deadline.
      if (performance.now() >= deadline) throw domainError('change.pending')
      job = latest
    }
  }
  async function searchableReceipt(result: MemoryFileMutationResult) {
    if (closed) throw domainError('change.pending')
    if (result.action !== 'FORGET') await flushPublication(result.identity.workspace, result.identity.id)
    return result
  }
  function indexPaths() {
    const paths = new Map<string, string>()
    for (const note of notes?.storage.allocations() ?? []) paths.set(publicationKey(note.workspace, noteFileId(note.key)), note.path)
    for (const workspace of documents?.workspaces() ?? []) {
      for (const doc of documents?.registered(workspace) ?? []) paths.set(publicationKey(workspace, doc.id), doc.path)
    }
    return paths
  }
  effects.runs(INDEX_PUBLISH, async jobs => {
    const paths = indexPaths()
    const outcomes = new Map<string, Outcome>()
    for (const job of jobs) {
      // Give the connection and foreground requests a turn between publications.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      if (closed) break
      try { outcomes.set(job.key, (await publishOnce(job, paths)).size ? 'retry' : 'done') }
      catch { outcomes.set(job.key, 'retry') }
    }
    return outcomes
  })
  effects.runs(INDEX_SEED, async jobs => {
    if (!fileRetrieval) return new Map(jobs.map(job => [job.key, 'done' as const]))
    const paths = indexPaths()
    for (const row of fileIndex?.files(fileWorkspaces()) ?? []) paths.set(publicationKey(row.workspace, row.id), row.path)
    store.tx(() => {
      for (const key of paths.keys()) {
        const [workspace, id] = JSON.parse(key) as [string, string]
        if (!effects.get(INDEX_PUBLISH, key)) stagePublication(workspace, id, [id])
      }
      store.setMeta(INDEX_SEEDED, '1')
    })
    void effects.wake()
    return new Map(jobs.map(job => [job.key, 'done' as const]))
  })
  notes?.storage.recover()
  documents?.recover()
  deferIndexPublication = false
  if (fileRetrieval && !store.meta(INDEX_SEEDED)) {
    effects.queue(INDEX_SEED, 'all', null)
    void effects.wake()
  }
  type FileLocator = { id: string; workspace: string; path: string; revision?: string }
  const fileLocatorKey = (file: Pick<FileLocator, 'workspace' | 'path'>) => JSON.stringify([file.workspace, file.path])

  function filePacket(result: FileSearchResult, batch?: MemoryDocumentReadBatch) {
    if (!fileDependenciesCurrent(result.files, batch)) return textOf({ status: 'unavailable' })
    return fileSearchPacket(result)
  }
  function fileSearchPacket(result: FileSearchResult) {
    const { files: _dependencies, sourceIds: _sources, hits, ...status } = result
    return textOf({ ...status, notes: hits.map(({ text, ...hit }) => ({ ...hit, markdown: text })) })
  }
  function automaticRecallFromSearch(result: FileSearchResult | null, batch?: MemoryDocumentReadBatch): AutomaticRecallResult {
    if (!result) return { status: 'timeout' }
    if (!fileDependenciesCurrent(result.files, batch)) return { status: 'timeout' }
    if (result.hits.length > 0) {
      return {
        status: 'hit',
        text: fileSearchPacket(result),
        partial: result.partial,
        hits: result.hits.map(hit => ({ text: hit.text, names: [] })),
      }
    }
    if (result.partial || result.status === 'unavailable') return { status: 'timeout' }
    return { status: 'empty' }
  }
  function residentProfileText(): string {
    if (closed || !filePolicy) return ''
    const view = filePolicy.read(userWorkspace, RESIDENT_PROFILE_PATH)
    if (!view) return ''
    return projectProfileL2(view.markdown, MAX_PROFILE_L2_CHARS)
  }
  function residentProfileIdentity(): MemoryManagedFileIdentity | null {
    if (closed || !documents) return null
    const doc = documents.read(userWorkspace, RESIDENT_PROFILE_PATH, { includeDisabled: true })
    return doc ? { kind: 'digest', workspace: userWorkspace, id: doc.id } : null
  }
  function recallInterval(asOf: string | undefined, at: number): MemoryInterval | null {
    if (!asOf) return { from: at, to: at + 1 }
    const zone = timezone(), from = localDay(asOf, zone)
    if (from === null) return null
    const to = localDay(nextDay(asOf), zone)
    return to === null ? null : { from, to }
  }
  // Workspace identity is derived from these three scope fields. Restrict SQL candidates
  // before ranking; current source and policy checks still run on each returned document.
  function visibleWorkspaces(origin: Origin, scope = origin.context ?? origin.scope) {
    const keys = new Set<string>()
    for (const owned of [USER, scope, origin.project]) {
      if (!owned) continue
      for (const context of [null, USER, origin.context ?? origin.scope, origin.project]) {
        if (context === undefined) continue
        for (const project of [null, origin.project]) {
          if (project !== undefined) keys.add(memoryHash(JSON.stringify([owned, context, project])))
        }
      }
    }
    return [...keys]
  }
  function fileQuery(request: RecallRequest, origin: Origin) {
    const interval = recallInterval(request.asOf, now())
    if (!interval) return null
    const scope = recallScope(request, origin)
    const turn = origin.turn ?? origin.foregroundTurn
    return { workspaces: visibleWorkspaces(origin, scope), query: request.query, limit: request.limit, minScore: request.min_score, maxChars: (request.deep ? MAX_DEEP_RECALL_CHARS : MAX_RECALL_CHARS) - 128,
      ...(turn && origin.session === request.session ? { contextKey: JSON.stringify(['recall', request.session, turn, scope ?? null, origin.project ?? null]) } : {}),
      from: request.start_date, through: request.end_date,
      ...(request.asOf ? { asOf: interval.to! - 1 } : {}),
      allows: (view: MemoryDocumentView) => fileAllowsOrigin(view, origin, scope) }
  }
  function fileDependenciesCurrent(refs: readonly MemoryFileDependency[], batch?: MemoryDocumentReadBatch): boolean {
    return refs.every(ref => {
      const view = batch ? batch.read(ref.workspace, ref.path) : filePolicy?.read(ref.workspace, ref.path)
      return Boolean(view && view.id === ref.id && view.revision === ref.revision && view.usageVersion === ref.usageVersion
        && view.policyToken === ref.policyToken && JSON.stringify(ref.sourceRanges) === JSON.stringify(fileDependency(view).sourceRanges))
    })
  }
  function sourceAllowsOrigin(source: MemorySource, origin: Origin, scope = origin.context ?? origin.scope) {
    return fileSourceCurrent(source.id) && (contextAllows(source.scope, scope) || contextAllows(source.scope, origin.project))
      && (!source.project || Boolean(origin.project && sameScope(source.project, origin.project)))
      && (!source.context || contextAllows(source.context, origin.context ?? origin.scope) || contextAllows(source.context, origin.project))
  }
  const automaticAllows = (view: MemoryDocumentView, origin: Origin, session: string) =>
    !isResidentProfileIdentity(view.workspace, view.path, userWorkspace)
    && (view.kind !== 'daily' || view.session !== session)
    && fileAllowsOrigin(view, origin)

  function fileAllowsOrigin(view: MemoryDocumentView, origin: Origin, scope = origin.context ?? origin.scope) {
    return view.sourceTokens.length > 0 && view.sourceTokens.every(ref => {
      const source = store.readSource(ref.id)
      return Boolean(source && sourceAllowsOrigin(source, origin, scope))
    })
  }
  function documentChanged(_receipt: DocumentReceipt) {
    publish(store.revision())
  }
  const calculateDocument: DreamCalculate = async request => {
      const model = route(), sources = request.sourceIds()
      if (!model || !sources.length) {
        diagnostics.emit({ event: 'operation.progress', operation: 'memory.dream', stage: request.stage,
          reason: !model ? 'not_ready' : 'source_changed', identities: { jobId: request.job.key, generation: request.job.generation } })
        return
      }
      const observe = request.observe
      const fresh = async () => {
        const check = observe ? await observe() : request.current
        return check()
      }
      if (!await fresh()) {
        diagnostics.emit({ event: 'operation.progress', operation: 'memory.dream', stage: request.stage,
          reason: 'source_changed', identities: { jobId: request.job.key, generation: request.job.generation } })
        return
      }
      const id = randomUUID(), snapshotRevision = store.revision()
      const observation = beginDiagnosticOperation(diagnostics, 'memory.dream', {
        stage: request.stage, identities: { operationId: id, jobId: request.job.key, generation: request.job.generation } })
      let diagnosticOutcome: DiagnosticOutcome = 'cancelled'
      let diagnosticReason: DiagnosticReason | undefined = 'denied'
      try {
        const result = compute({ id, sourceId: sources[0]!, stage: 'dream', generation: request.job.generation,
          ...model, system: request.system, input: JSON.stringify(request.input) }, undefined, request.tools)
        if (!result) return
        const text = await result
        const valid = await fresh() && !closed && request.sourceIds().every(fileSourceCurrent) && store.revision() === snapshotRevision
        diagnosticOutcome = valid ? 'completed' : 'cancelled'; diagnosticReason = valid ? undefined : 'stale'
        return valid ? text : undefined
      } catch (error) {
        diagnosticOutcome = 'failed'; diagnosticReason = safeDiagnosticReason(error)
        throw error
      } finally {
        observation.end(diagnosticOutcome, diagnosticReason ? { reason: diagnosticReason } : {})
      }
    }
  const dream = dailyNotes && notes && documents ? createMemoryDreamJobs({
    store, notes: notes.storage, documents, effects, identity: resources.identity, now, transaction: store.tx, diagnostics, digestNodes: fileIndex?.digestNodes,
    readFileAtCommit: resources.readFileAtCommit,
    searchDigestNodes: fileRetrieval
      ? async (workspace, query, limit, offset, signal) => {
          const batch = filePolicy?.readBatch(signal)
          const res = await fileRetrieval.nodeSearchAsync({ workspaces: [workspace], query, limit, offset, allows: () => true, signal }, batch)
          return { nodes: res.nodes.map(node => ({ id: node.id, path: node.path, score: node.score })), partial: res.partial }
        }
      : undefined,
    readPhysicalFile: resources.readPhysicalFile,
    settings: typeof dailyNotes === 'object' ? dailyNotes : undefined,
    readable: fileSourceCurrent,
    eligible: source => !closed && canCommit(source),
    source: id => store.readSource(id) ?? undefined,
    reference(id) {
      const source = store.readSource(id)
      return source && fileSourceCurrent(id) ? { namespace: 'canonical', sourceId: id, revision: source.version } : null
    },
    allowsText: (text) => !looksSecret(text),
    committed: documentChanged,
    calculate: calculateDocument,
  }) : null
  effects.runs(DOCUMENT_CLEANUP, async jobs => {
    // Recover interrupted file commits and finish pending local cleanup.
    const revision = store.revision(), pending = documents?.pendingCleanup()
    notes?.storage.recoverDeletedFiles()
    documents?.recoverDeletedFiles()
    if (notes?.storage.needsRecovery()) notes.storage.recover()
    if (documents?.needsRecovery()) documents.recover()
    // WAL truncation only removes residual bytes after logical invalidation has committed.
    notes?.storage.checkpointCleanup()
    documents?.checkpointCleanup()
    fileIndex?.recover()
    if (store.revision() !== revision || documents?.pendingCleanup() !== pending) publish(store.revision())
    return new Map(jobs.map(job => [job.key, notes?.storage.pendingCleanup() || documents?.hasPendingCleanup(job.key) || fileIndex?.pendingCleanup() ? 'retry' as const : 'done' as const]))
  })
  function canonicalSource(id: string, inspected = new Map<string, MemorySource | null>()): MemorySource | null {
    if (inspected.has(id)) return inspected.get(id)!
    inspected.set(id, null)
    const source = store.readSource(id)
    if (!source?.hash) return null
    if (source.author === 'manual' && store.manualFileParents(id).some(ref => {
      const parent = canonicalSource(ref.id, inspected)
      return !parent?.text || !documentSourceProofCurrent(ref, parent.text, resources.sourceToken(parent))
    })) return null
    inspected.set(id, source)
    return source
  }
  // Accepted file proof tracks disjoint source ranges and versions.
  function fileSourceCurrent(id: string) {
    return Boolean(canonicalSource(id)?.text)
  }
  const sourceCurrent = fileSourceCurrent

  type RecallRequest = Extract<MemoryRequest, { op: 'recall' }>

  async function listFilesAsync(input: MemoryFileListRequest, signal?: AbortSignal) {
    if (!fileManagement || closed) throw new Error('Document memory is not enabled')
    signal?.throwIfAborted()
    if (!filePolicy || !resources.readPhysicalFile) return fileManagement.list(input, managementAllows)
    const scope = new Set(fileWorkspaces())
    const committed = input.kind === 'digest' ? [] : notes?.storage.fileRegistry() ?? []
    const budget = createRequestBudget(DAILY_MEMORY_DEFAULTS.fileVerificationBudgetMs, signal)
    try {
      return await fileManagement.listPage(input, view => !closed && scope.has(view.workspace), committed, {
        revision: store.revision, signal, exhausted: () => budget.signal.aborted,
        async load(files) {
          const batch = filePolicy.readBatch(signal, 128)!
          try { await budget.run(() => batch.load(files, budget.signal)) }
          catch (error) { if (!(error instanceof RequestTimeout) || signal?.aborted) throw error }
          return batch.managementObservation
        },
      })
    } finally { budget.close() }
  }
  async function readFileAsync(identity: MemoryManagedFileIdentity, signal?: AbortSignal) {
    if (!fileManagement || closed) return null
    signal?.throwIfAborted()
    const batch = filePolicy?.readBatch(signal)
    const workspace = identity.workspace
    const path = batch && fileWorkspaces().includes(workspace) ? resolveFileId(workspace, identity.id) : null
    if (path && batch) await batch.load([{ workspace, path }])
    signal?.throwIfAborted()
    if (closed) return null
    const detail = fileManagement.detail(identity, managementAllows, batch?.managementRead)
    if (detail?.enabled && path && fileIndex && !fileIndex.nodeAt(workspace, path) && batch?.read(workspace, path) != null) {
      const key = publicationKey(workspace, identity.id)
      const pending = effects.timing(INDEX_PUBLISH, key)
      if (pending && pending.dueAt > now()) {
        const job = effects.get(INDEX_PUBLISH, key)
        if (job) {
          effects.queue(INDEX_PUBLISH, key, job.payload)
          void effects.wake()
        }
      } else if (!pending) scheduleStaleProjection(workspace, identity.id)
    }
    return detail
  }

  function recallScope(request: RecallRequest, origin: Origin) {
    return request.scope === 'project' ? origin.project : origin.context ?? origin.scope
  }

  async function automaticRecall(
    request: { session: string, turn?: number, question: string },
    origin: Origin,
    stillCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<AutomaticRecallResult> {
    const current = () => !closed && !signal?.aborted && stillCurrent()
    if (!current()) return { status: 'unavailable' }
    if (!request.question.trim() || looksSecret(request.question)) return { status: 'skipped' }
    if (!fileRetrieval) return { status: 'empty' }
    const budget = createRequestBudget(DAILY_MEMORY_DEFAULTS.automaticSearchBudgetMs, signal)
    const batch = filePolicy?.readBatch(budget.signal)
    try {
      const result = await budget.run(() => fileRetrieval.search({
        query: request.question, automatic: true, limit: 3, maxChars: MAX_RECALL_CHARS - 128,
        signal: budget.signal, workspaces: visibleWorkspaces(origin), allows: view => automaticAllows(view, origin, request.session),
      }, batch))
      if (!current()) return { status: 'unavailable' }
      return automaticRecallFromSearch(result, batch)
    } catch (error) {
      if (!(error instanceof RequestTimeout) && !signal?.aborted) throw error
      return current() ? { status: 'timeout' } : { status: 'unavailable' }
    } finally { budget.close() }
  }

  function handleModelRequest(request: MemoryRequest, origin: Origin, stillCurrent: () => boolean, signal?: AbortSignal) {
    const current = () => !closed && !signal?.aborted && stillCurrent()
    if (fileRetrieval && request.op === 'recall') {
      if (request.scope === 'project' && !origin.project) return textOf({ status: 'rejected', reason: 'project-unavailable' })
      const query = fileQuery(request, origin)
      if (!query) return textOf({ status: 'rejected', reason: 'invalid-date' })
      if (!current()) return textOf({ status: 'unavailable' })
      const batch = filePolicy?.readBatch(signal)
      return fileRetrieval.search({ ...query, signal }, batch).then(result => {
        if (!current()) return textOf({ status: 'unavailable' })
        return filePacket(result, batch)
      })
    }
    if (request.op === 'context') {
      return automaticRecall(request, origin, stillCurrent, signal).then(result => textOf(result))
    }
    if (fileRetrieval && (request.op === 'file_read' || request.op === 'node_search')) {
      if (!current()) return textOf({ status: 'unavailable' })
      const batch = filePolicy?.readBatch(signal)
      const allows = (view: MemoryDocumentView) => fileAllowsOrigin(view, origin)
      if (request.op === 'file_read') {
        return fileRetrieval.readAsync({ workspaces: visibleWorkspaces(origin), id: request.id, startLine: request.start_line, endLine: request.end_line,
          allows, signal }, batch).then(result =>
          current() && result && fileDependenciesCurrent(result.files, batch)
            ? fileReadPacket(result) : textOf({ status: 'unavailable' }))
      }
      return fileRetrieval.nodeSearchAsync({ workspaces: visibleWorkspaces(origin), query: request.query, limit: request.limit, allows, signal }, batch).then(result =>
        current() && fileDependenciesCurrent(result.files, batch)
          ? nodeSearchPacket(result) : textOf({ status: 'unavailable' }))
    }
    return handle(request, origin)
  }

  function rebuildIndexes() {
    const files = fileRetrieval?.reindex()
    if (files) {
      effects.queue(INDEX_SEED, 'all', null)
      void effects.wake()
      void fileRetrieval?.prepareVectors().catch(() => {})
    }
    return { fullText: Boolean(files), semantic: Boolean(files), ...(files ? { files } : {}) }
  }

  function fileReadPacket(result: NonNullable<ReturnType<NonNullable<typeof fileRetrieval>['read']>>) {
    const { files: _files, sourceIds: _sources, ...content } = result
    let packet: Record<string, unknown> = content
    if (textOf(packet).length > MAX_DEEP_RECALL_CHARS && 'lineHistory' in content && content.lineHistory !== undefined) {
      const { lineHistory: _omitted, ...plain } = content
      packet = plain
    }
    if (textOf(packet).length > MAX_DEEP_RECALL_CHARS) return textOf({ status: 'rejected', reason: 'narrow-line-range' })
    return textOf({ status: 'ok', ...packet })
  }
  function nodeSearchPacket(result: ReturnType<NonNullable<typeof fileRetrieval>['nodeSearch']>) {
    const { nodes, partial } = result
    return textOf({ status: 'ok', nodes, partial })
  }
  function handle(request: MemoryRequest, origin: Origin) {
    if ((closed) && ['context', 'recall', 'file_read', 'node_search'].includes(request.op)) return request.op === 'context' ? '' : textOf({ status: 'unavailable' })
    const scope = origin.context ?? origin.scope
    if (request.op === 'file_read') {
      const result = fileRetrieval?.read({ id: request.id, startLine: request.start_line, endLine: request.end_line,
        allows: view => fileAllowsOrigin(view, origin, scope) })
      return result ? fileReadPacket(result) : textOf({ status: 'unavailable' })
    }
    if (request.op === 'node_search') {
      const result = fileRetrieval?.nodeSearch({ workspaces: visibleWorkspaces(origin), query: request.query, limit: request.limit, allows: view => fileAllowsOrigin(view, origin, scope) })
      return result ? nodeSearchPacket(result) : textOf({ status: 'unavailable' })
    }
    if (request.op === 'recall') {
      if (request.scope === 'project' && !origin.project) return textOf({ status: 'rejected', reason: 'project-unavailable' })
      const query = fileQuery(request, origin)
      return query && fileRetrieval ? filePacket(fileRetrieval.searchCached(query))
        : textOf({ status: 'rejected', reason: 'invalid-date' })
    }
    if (request.op === 'context') {
      if (!request.question.trim() || looksSecret(request.question)) return textOf({ status: 'skipped' } satisfies AutomaticRecallResult)
      const result = fileRetrieval?.searchCached({ workspaces: visibleWorkspaces(origin), query: request.question, automatic: true, limit: 3, maxChars: MAX_RECALL_CHARS - 128, allows: view => automaticAllows(view, origin, request.session) })
      return textOf(result ? automaticRecallFromSearch(result) : ({ status: 'empty' } satisfies AutomaticRecallResult))
    }
    return textOf({ status: 'rejected', reason: 'no-explicit-user-source' })
  }
  function finishTurn(_session: string | null, _completed = false) { void effects.wake() }

  const manualFileWorkspace = (project?: Origin['project'], context: MemoryScope = project ?? USER) =>
    memoryHash(JSON.stringify([USER, context, project ?? null]))
  function explicitFileSource(text: string, origin: Origin, sourceIds: readonly string[]): DocumentSourceRef | null {
    if (!origin.session || !origin.foregroundTurn || closed || !text.trim() || text.length > MAX_MESSAGE_CHARS
      || /[\u0000\uD800-\uDFFF]/u.test(text) || looksSecret(text)) return null
    for (const id of [...sourceIds].reverse()) {
      const source = store.readSource(id)
      if (!source?.text || (source.author !== 'user' && source.author !== 'answer') || !sourceAllowsOrigin(source, origin)) continue
      const start = source.text.indexOf(text)
      if (start < 0 || source.text.lastIndexOf(text) !== start) continue
      const proof = { id, token: resources.sourceToken(source), spans: [{ start, end: start + text.length }] }
      return proof
    }
    return null
  }

  async function writeSourceFile(operationId: string, proof: DocumentSourceRef, committed: FileMutationCommitted,
    current: () => boolean, waitForPublication = true): Promise<MemoryFileMutationResult> {
    if (!documents || !filePolicy) throw domainError('not.found')
    const storage = documents, policy = filePolicy
    const source = store.readSource(proof.id)
    if (!source) throw domainError('not.found')
    const workspace = resources.sourceWorkspace(source)
    const response = (() => {
      if (closed || !current()) throw domainError('not.found')
      const latest = store.readSource(proof.id)
      if (!latest?.text || !fileSourceCurrent(latest.id)
        || resources.sourceToken(latest) !== proof.token || proof.spans?.length !== 1) throw domainError('revision.conflict')
      const span = proof.spans[0]!
      const text = latest.text.slice(span.start, span.end)
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end > latest.text.length
        || span.start >= span.end || !text.trim() || text.length > MAX_MESSAGE_CHARS || /[\u0000\uD800-\uDFFF]/u.test(text)
        || (latest.author !== 'user' && latest.author !== 'answer') || looksSecret(text)) throw domainError('invalid.text')
      const markdown = formatMemoryDocument({ metadata: { name: [...text.split(/\r?\n/u, 1)[0]!].slice(0, 100).join('') }, body: text })
      const already = storage.receipt(workspace, operationId)
      const receipt = already ?? storage.commit({ operationId, workspace, path: `digest/personal/remember-${memoryHash(operationId)}.md`,
        expectedRevision: null, action: 'CREATE', markdown, sources: [proof], reads: [] })
      if (receipt.revision !== memoryHash(markdown) || receipt.action !== 'CREATE') throw domainError('operation.conflict')
      const file = { path: receipt.path, revision: receipt.revision, markdown }
      const view = policy.read(workspace, file.path, (area, path) => area === workspace && path === file.path ? file : null)
      if (!view || view.id !== receipt.documentId || view.usageVersion !== receipt.usageVersion) throw domainError('revision.conflict')
      const result: MemoryFileMutationResult = { operationId, identity: { kind: 'digest', workspace, id: receipt.documentId },
        contentRevision: receipt.revision, usageVersion: receipt.usageVersion, action: 'CREATE' }
      if (!already) documentChanged(receipt)
      store.tx(() => {
        committed(result)
      })
      return result
    })()
    dream?.run()
    void effects.wake()
    if (waitForPublication) await searchableReceipt(response)
    return response
  }

  function freshFileEvidence(id: string, text: string, parent?: MemorySource, project?: Origin['project'], context: MemoryScope = project ?? USER): MemorySource {
    return { id, operation: id, version: 1, conversation: null, session: null, scope: parent?.scope ?? USER,
      context: parent ? parent.context : context, project: parent ? parent.project ?? null : project ?? null, author: 'manual', text, hash: memoryHash(text), length: text.length,
      question: null, requestId: null, questionId: null, at: now(), timezone: timezone(), outcome: 'written' }
  }

  async function writeManagedFile(operationId: string, workspace: string, input: MemoryFileCreateRequest | MemoryFileEditRequest | undefined,
    committed: FileMutationCommitted, project?: Origin['project'], context?: MemoryScope, waitForPublication = true): Promise<MemoryFileMutationResult | null> {
    if (!documents || !fileManagement) throw domainError('not.found')
    if (!/^[a-f0-9]{64}$/u.test(workspace)) throw domainError('revision.conflict')
    const storage = documents, management = fileManagement
    const result = (() => {
      if (closed) throw domainError('not.found')
      const already = storage.receipt(workspace, operationId)
      if (!already && storage.recoverManagement(operationId) === 'cancelled') throw domainError('revision.conflict')
      let receipt = already ?? storage.receipt(workspace, operationId)
      if (!receipt) {
        // A crash before the file intent is durable has no retained draft to write.
        // The same operation can be retried with its original payload.
        if (!input) return null
        const body = input.text
        const title = input.title === undefined ? undefined : input.title.trim()
        const target = 'identity' in input ? management.editTarget(input, managementAllows) : null
        const existing = target ? parseMemoryDocument(target.markdown) : null
        const shownTitle = typeof existing?.metadata.name === 'string' ? existing.metadata.name : ''
        const unchanged = existing?.body === body && (input.title === undefined || input.title === shownTitle || title === shownTitle)
        const sourceText = title ? `${title}\n${body}` : body
        if (!unchanged) {
          if (!body.trim() || body.length > MAX_MESSAGE_CHARS) throw domainError('invalid.text')
          const inspectedSourceText = stripTrustedMemoryLinks(sourceText, trustedEditLocators(workspace, target?.markdown))
          if (looksSecret(inspectedSourceText)) throw domainError('credentials')
          if (/[\u0000\uD800-\uDFFF]/u.test(body) || title && /[\u0000\r\n\uD800-\uDFFF]/u.test(title)) throw domainError('invalid.text')
        }
        const isProfileTarget = Boolean(target && isResidentProfileIdentity(workspace, target.path, userWorkspace))
        const finalBody = !unchanged && isProfileTarget && existing
          ? mergeUserProfileEdit(existing.body, body)
          : body
        if (!unchanged && isProfileTarget) {
          const actual = measureConfirmedSectionL2(finalBody)
          if (actual > MAX_PROFILE_L2_CHARS) {
            throw domainError('profile.confirmed_too_long', { limit: MAX_PROFILE_L2_CHARS, actual })
          }
        }
        const parent = target ? canonicalSource(target.sources[0]!.id) : null
        if (target && !parent) throw domainError('revision.conflict')
        const metadata: Record<string, unknown> = existing ? { ...existing.metadata, ...(title === undefined ? {} : { name: title }) }
          : { name: title ?? [...finalBody.trimStart().split(/\r?\n/u, 1)[0]!].slice(0, 100).join('') }
        if (existing && existing.body !== finalBody) delete metadata.description
        const markdown = unchanged ? target!.markdown : formatMemoryDocument({ metadata, body: finalBody })
        // User edits are explicit input. A full-editor draft stays tied to the
        // accepted proof it may have quoted, so it cannot launder forgotten text.
        const finalSourceText = title ? `${title}\n${finalBody}` : finalBody
        const source = unchanged ? null : freshFileEvidence(operationId, finalSourceText, parent ?? undefined, project, context)
        if (source && (resources.sourceWorkspace(source) !== workspace || store.readSource(operationId))) throw domainError('operation.conflict')
        receipt = storage.writeManual({ operationId, workspace, path: target?.path ?? `digest/wiki/manual-${memoryHash(operationId)}.md`,
          markdown, source,
          expected: target && 'identity' in input ? { id: target.id, revision: target.revision, usageVersion: target.usageVersion,
            policyToken: input.version.policyToken } : undefined })
      }
      if (!receipt.revision || (receipt.action !== 'CREATE' && receipt.action !== 'REFINE')) throw domainError('operation.conflict')
      const response: MemoryFileMutationResult = { operationId, identity: { kind: 'digest', workspace, id: receipt.documentId },
        contentRevision: receipt.revision, usageVersion: receipt.usageVersion, action: receipt.action === 'CREATE' ? 'CREATE' : 'EDIT' }
      if (!already) documentChanged(receipt)
      committed(response)
      return response
    })()
    if (result) { dream?.run(); void effects.wake() }
    return result && waitForPublication ? searchableReceipt(result) : result
  }

  function forgetManagedFile(input: MemoryFileForgetRequest, committed: (result: MemoryFileMutationResult) => void) {
    if (closed || !documents || !fileManagement || !notes) throw domainError('not.found')
    const result = store.tx(() => {
      const view = fileManagement.deletionTarget(input, managementAllows)
      queueFilePublication({ workspace: view.workspace, id: view.id })
      const usageVersion = view.daily
        ? notes.storage.deleteFile(view.workspace, view.daily.allocation.key, view.daily.allocation.revision)
        : documents.deleteFile(view.workspace, view.id, view.usageVersion)
      if (!view.daily && isResidentProfileIdentity(view.workspace, view.path, userWorkspace)) {
        const prevRaw = store.meta('profile_deleted_at')
        const prev = prevRaw === undefined ? null : Number(prevRaw)
        const nextWatermark = prev !== null && Number.isFinite(prev) ? Math.max(prev, now()) : now()
        store.setMeta('profile_deleted_at', String(nextWatermark))
        const prevGen = Number(store.meta('profile_deletion_generation') ?? 0)
        const nextGen = Number.isFinite(prevGen) && prevGen >= 0 ? prevGen + 1 : 1
        store.setMeta('profile_deletion_generation', String(nextGen))
        if (store.maxSourceSeq) {
          const prevSeqRaw = store.meta('profile_deleted_source_seq')
          const prevSeq = prevSeqRaw === undefined ? null : Number(prevSeqRaw)
          const currentSeq = store.maxSourceSeq()
          const nextSeq = prevSeq !== null && Number.isFinite(prevSeq) ? Math.max(prevSeq, currentSeq) : currentSeq
          store.setMeta('profile_deleted_source_seq', String(nextSeq))
        }
      }
      store.nextRevision()
      // Deleting the last daily file also removes its workspace from catalog discovery.
      const indexed = fileIndex?.snapshot(view.workspace, view.id)
      if (indexed) fileIndex?.remove(indexed)
      effects.queue(DOCUMENT_CLEANUP, view.id, null)
      const result: MemoryFileMutationResult = { operationId: input.operationId, identity: input.identity,
        action: 'FORGET', contentRevision: view.revision, usageVersion }
      committed(result)
      return result
    })
    publish(store.revision())
    void effects.wake()
    return result
  }

  async function mutateManagedFile(input: MemoryFileMutation, committed?: FileMutationCommitted, waitForPublication = true): Promise<MemoryFileMutationResult> {
    const command = memoryFileMutation.parse(input)
    if (!documents || !fileManagement) throw domainError('not.found')
    let changed = false
    const result = (() => {
      if (closed) throw domainError('not.found')
      if (command.identity.kind === 'daily') {
        if (!notes || command.action !== 'setEnabled') throw domainError('invalid.text')
        const storage = notes.storage
        const key = 'daily-file-usage:' + command.operationId
        const fingerprint = memoryHash(JSON.stringify(command))
        const applied = store.tx(() => {
          const prior = store.command(key)
          if (prior) {
            const saved = JSON.parse(prior.payload) as { fingerprint: string, result: MemoryFileMutationResult }
            if (saved.fingerprint !== fingerprint) throw domainError('operation.conflict')
            return saved.result
          }
          const { view } = fileManagement.validate(command, managementAllows)
          const allocation = view.daily!.allocation
          const changed = view.enabled !== command.enabled
          if (changed) {
            if (!storage.setEnabled(allocation.key, allocation.revision, command.enabled)) throw domainError('revision.conflict')
            queueFilePublication({ workspace: view.workspace, id: view.id })
            store.nextRevision()
          }
          const response: MemoryFileMutationResult = { operationId: command.operationId, identity: command.identity,
            contentRevision: view.revision, usageVersion: allocation.revision + Number(changed), action: command.enabled ? 'ENABLE' : 'DISABLE' }
          store.recordCommand(key, 'setEnabled', JSON.stringify({ fingerprint, result: response }), response.usageVersion)
          return response
        })
        changed = applied.usageVersion !== command.version.usageVersion
        if (changed) publish(store.revision())
        if (changed && command.enabled) notes.flush()
        committed?.(applied, [])
        return applied
      }
      if (!fileWorkspaces().includes(command.identity.workspace)) throw domainError('not.found')
      const { identity, version, operationId } = command
      const alreadyCommitted = documents.receipt(identity.workspace, operationId)
      if (!alreadyCommitted && documents.recoverManagement(operationId) === 'cancelled') throw domainError('revision.conflict')
      const prior = alreadyCommitted ?? documents.receipt(identity.workspace, operationId)
      // A completed operation must replay its original full input fingerprint, even if
      // later edits make its original CAS stale. Storage rejects any changed argument.
      if (!prior) fileManagement.validate(command, managementAllows)
      const receipt = command.action === 'setEnabled'
        ? documents.setEnabled({ operationId, workspace: identity.workspace, documentId: identity.id,
          expectedRevision: version.contentRevision, expectedUsageVersion: version.usageVersion,
          expectedPolicyToken: version.policyToken, enabled: command.enabled })
        : documents.undo({ operationId, workspace: identity.workspace, documentId: identity.id,
          revision: version.contentRevision, usageVersion: version.usageVersion,
          expectedPolicyToken: version.policyToken, expectedChangeId: command.changeId })
      if (receipt.revision === null || !['ENABLE', 'DISABLE', 'UNDO'].includes(receipt.action)) throw new Error('Unexpected memory file mutation receipt')
      const response: MemoryFileMutationResult = { operationId, identity: { ...identity }, contentRevision: receipt.revision,
        usageVersion: receipt.usageVersion, action: receipt.action as MemoryFileMutationResult['action'] }
      if (!alreadyCommitted && response.usageVersion !== version.usageVersion) { changed = true; documentChanged(receipt) }
      // A crash between storage receipt and callback is completed by replaying the receipt.
      committed?.(response)
      return response
    })()
    if (changed) { dream?.run(); void effects.wake() }
    return waitForPublication ? searchableReceipt(result) : result
  }

  return {
    listFilesAsync, readFileAsync, automaticRecall, residentProfileText, residentProfileIdentity,
    async fileForSession(id: string, origin: Origin, signal?: AbortSignal) {
      if (!filePolicy || closed || !origin.session) return null
      signal?.throwIfAborted()
      const locations = fileWorkspaces().flatMap(workspace => {
        const path = resolveFileId(workspace, id)
        return path ? [{ workspace, path }] : []
      })
      const batch = filePolicy.readBatch(signal)
      if (batch) {
        const budget = createRequestBudget(DAILY_MEMORY_DEFAULTS.fileVerificationBudgetMs, signal)
        try { await budget.run(() => batch.load(locations, budget.signal)) }
        finally { budget.close() }
        if (batch.incomplete()) throw new RequestTimeout()
      }
      if (closed) throw domainError('change.pending')
      for (const { workspace, path } of locations) {
        const found = (batch ?? filePolicy).read(workspace, path)
        const file = found?.id === id && fileAllowsOrigin(found, origin) ? found : null
        if (file) return { identity: { kind: file.kind, workspace, id },
          version: { contentRevision: file.revision, usageVersion: file.usageVersion, policyToken: file.policyToken } }
      }
      return null
    },
    listFiles(input: MemoryFileListRequest) {
      if (!fileManagement || closed) throw new Error('Document memory is not enabled')
      return fileManagement.list(input, managementAllows)
    },
    readFile(identity: MemoryManagedFileIdentity) {
      if (!fileManagement || closed) return null
      return fileManagement.detail(identity, managementAllows)
    },
    setFileEnabled: (input: MemoryFileSetEnabledRequest, committed?: FileMutationCommitted, waitForPublication = true) =>
      mutateManagedFile({ ...input, action: 'setEnabled' }, committed, waitForPublication),
    forgetFile: forgetManagedFile,
    manualFileWorkspace,
    writeManagedFile, searchableReceipt,
    explicitFileSource,
    writeSourceFile,
    undoFile: (input: MemoryFileUndoRequest, committed?: FileMutationCommitted, waitForPublication = true) =>
      mutateManagedFile({ ...input, action: 'undo' }, committed, waitForPublication),
    dreamStatus: (operationId?: string): MemoryDreamStatus => dream?.status(operationId) ?? { state: 'disabled', ...dreamHistory(store) },
    requestDream: (operationId?: string): MemoryDreamStatus => dream?.request(operationId) ?? { state: 'disabled', ...dreamHistory(store) },
    runDocumentDream: () => { dream?.run(); return effects.wake() },
    readDocument: documents?.read,
    listDocuments: documents?.list,
    async undoDocument(input: Parameters<NonNullable<typeof documents>['undo']>[0]) {
      if (!documents) throw new Error('Document memory is not enabled')
      const result = (() => {
        const receipt = documents.undo(input)
        documentChanged(receipt)
        return receipt
      })()
      dream?.run()
      await flushPublication(input.workspace, result.documentId)
      return result
    },
    async setDocumentEnabled(input: Parameters<NonNullable<typeof documents>['setEnabled']>[0]) {
      if (!documents) throw new Error('Document memory is not enabled')
      const result = (() => {
        const receipt = documents.setEnabled(input)
        documentChanged(receipt)
        return receipt
      })()
      dream?.run()
      await flushPublication(input.workspace, result.documentId)
      return result
    },
    accept,
    recordNoteTurn: notes?.record,
    flushNoteTurns: notes?.flush,
    handle,
    handleModelRequest,
    rebuildIndexes,
    sourceCurrent,
    deletedFileCleanupPending(identity: MemoryFileForgetRequest['identity']) {
      return identity.kind === 'daily' ? notes?.storage.deletedFileCleanupPending(identity.workspace, identity.id) === true
        : documents?.deletedFileCleanupPending(identity.workspace, identity.id) === true
    },
    cleanupPending: () => (notes?.storage.pendingCleanup() ?? 0) + (documents?.pendingCleanup() ?? 0) + (fileIndex?.pendingCleanup() ?? 0),
    revision: store.revision,
    epoch: store.epoch,
    profileDeletionGeneration: () => {
      const value = Number(store.meta('profile_deletion_generation') ?? 0)
      return Number.isFinite(value) && value >= 0 ? value : 0
    },
    finishTurn,
    wake: () => effects.wake(),
    close() { closed = true; clearTimeout(staleProjectionTimer); staleProjections.clear(); fileRetrieval?.close(); embedder?.close(); effects.close(); store.close() }
  }
}
export type MemoryRuntime = ReturnType<typeof createMemoryRuntime>
