import { z } from 'zod'
import { guardDiagnosticPort, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort, DiagnosticReason, DiagnosticStage } from '../../diagnostics/contracts.ts'
import type { MemoryComputeTools } from '../contracts/compute.ts'
import { MemoryComputeError } from '../contracts/compute.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { dreamUnitSchema, mergeDreamUnits, parseDreamUnits } from '../contracts/memory-file-contract.ts'
import type { DreamUnit } from '../contracts/memory-file-contract.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { MemoryIdentity } from './ports/runtime.ts'
import type { Effect, Effects, Outcome } from './ports/effects.ts'
import type { MemoryNotes } from './ports/notes.ts'
import type { MemoryDreamStatus } from '../contracts/dream-status.ts'
import type { MemoryStore, MemorySource } from './ports/store.ts'
import type { DocumentCorrection, DocumentReceipt, DocumentSourceRef, MemoryDocuments } from './ports/documents.ts'
import { DREAM, nextDreamAt } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import { todayAt } from './memory-calendar.ts'
import { parseMemoryDocument, updateMemoryFrontmatter } from './memory-document.ts'
import { createMemoryDreamTools, dreamChangesConclusion, memoryDocumentLinks, MemoryDreamStaleError } from './memory-dream-tools.ts'
import { createMemoryDocumentReadPolicy, createMemoryDocumentEvidence, mergeDocumentSources } from './memory-document-read-policy.ts'
import type { MemoryDocumentView } from './memory-document-read-policy.ts'
import { documentSourceRestricted, projectDocumentSource } from './memory-document-restrictions.ts'
import { validateDreamReview } from './memory-dream-evidence.ts'
import { DREAM_EXTRACT_SYSTEM, DREAM_INTEGRATE_SYSTEM, DREAM_TAG_SYSTEM, DREAM_VERIFY_SYSTEM } from './memory-dream-prompts.ts'

export type DreamCalculate = (request: {
  job: Effect, stage: 'extract' | 'integrate' | 'verify' | 'tag', system: string, input: object,
  sourceIds: () => readonly string[], current: () => boolean, tools?: MemoryComputeTools,
}) => Promise<string | undefined>
const sourceRefSchema = z.object({ id: z.string(), token: z.string(), spans: z.array(z.object({ start: z.int().nonnegative(), end: z.int().positive() })).optional() })
const fileRefSchema = z.object({ key: z.string(), workspace: z.string(), path: z.string(), revision: z.string(), policyToken: z.string().min(1), checkpoint: z.int(), oversized: z.literal(true).optional(), sources: z.array(sourceRefSchema), reads: z.array(z.object({ id: z.string(), revision: z.string(), usageVersion: z.int() })).default([]) })
const planSchema = z.object({
  version: z.literal(1), files: z.array(fileRefSchema),
  units: z.array(z.object({ workspace: z.string(), operationId: z.string(), unit: dreamUnitSchema, state: z.enum(['pending', 'done', 'deferred']) })),
  tags: z.array(z.object({ workspace: z.string(), path: z.string(), revision: z.string(), documentId: z.string().optional(), attempted: z.boolean() })),
  retryExtraction: z.boolean(),
})
type DreamPlan = z.infer<typeof planSchema>
type FileRef = z.infer<typeof fileRefSchema>
type PlannedUnit = DreamPlan['units'][number]
type Note = NonNullable<ReturnType<MemoryNotes['read']>>
type ToolSnapshot = MemoryDocumentView
const deferredReply = z.strictObject({ status: z.enum(['skip', 'deferred']), reason: z.string().trim().min(1).optional() })
const tagReply = z.strictObject({ memory_tags: z.array(z.string().trim().min(1)) })
const DAILY = 'daily'
const MANUAL_JOB = 'dream.manualJob'
const requestKey = (id: string) => `dream.request:${id}`
const receiptKey = (id: string) => `dream.receipt:${id}`
const DAY_MS = 86_400_000
const unique = <T>(values: readonly T[]) => [...new Set(values)]
const parse = (text: string) => JSON.parse(text) as unknown
const isModelTimeout = (error: unknown) => error instanceof MemoryComputeError && error.reason === 'timeout'

/** ReMe day grouping and UTF-8 budget. Oversized single files remain standalone, never silently disappear. */
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

/** Four-stage document jobs. Storage and provider message/reasoning state stay behind their respective ports. */
export function createMemoryDreamJobs({ notes, documents, effects, store, identity, now, settings, readable, eligible, source, reference,
  calculate, transaction, mutate, committed = () => {}, allowsText = () => true, diagnostics: diagnosticPort }: {
  store: Pick<MemoryStore, 'meta' | 'setMeta' | 'command' | 'recordCommand'>, notes: MemoryNotes, documents: MemoryDocuments, effects: Effects, identity: MemoryIdentity, now: () => number,
  settings?: DailyMemorySettings, readable: (id: string) => boolean, eligible: (source: MemorySource) => boolean,
  source: (id: string) => MemorySource | undefined, reference: (id: string) => MemorySourceReference | null,
  calculate: DreamCalculate, transaction: (write: () => void) => void, mutate: <T>(write: () => T) => Promise<T>, committed?: (receipt: DocumentReceipt) => void,
  allowsText?: (text: string, source: MemorySource) => boolean,
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
  const status = (): MemoryDreamStatus => {
    const scheduled = effects.timing(DREAM, DAILY)
    return {
      state: active ? 'running' : scheduled?.generation === waitingGeneration ? 'waiting'
        : scheduled && scheduled.dueAt <= now() ? 'queued' : scheduled?.attempts ? 'retry' : 'idle',
      ...dreamHistory(store),
    }
  }
  const refOf = (note: Note, view = policy.read(note.workspace, note.path)): FileRef => {
    if (!view || view.applicability.state === 'unavailable') throw new MemoryDreamStaleError()
    return { key: note.key, workspace: note.workspace, path: note.path, revision: note.fileRevision,
      policyToken: view.policyToken, checkpoint: note.revision, sources: notes.references(note.key), reads: [] }
  }
  const { refsCurrent, materialAllowed } = createMemoryDocumentEvidence({ notes, documents, hash: identity.hash, source, readable, allowsText })
  const fileCurrent = (ref: FileRef) => {
    const latest = notes.read(ref.key)
    return latest?.workspace === ref.workspace && latest.path === ref.path && latest.fileRevision === ref.revision && policy.read(ref.workspace, ref.path)?.policyToken === ref.policyToken && refsCurrent(ref.sources)
      && !ref.sources.some(source => documentSourceRestricted(source, documents.sourceRestrictions(ref.workspace)))
  }
  const allSources = mergeDocumentSources
  const policy = createMemoryDocumentReadPolicy({ notes, documents, hash: identity.hash, refsCurrent, materialAllowed, reference })
  const scopedDocuments = (workspace: string) => ({
    read: (path: string) => policy.read(workspace, path),
    list: () => policy.list(workspace, 'digest'),
    locatorRetired: (path: string) => documents.locatorRetired(workspace, path),
  })
  const extractedReadsCurrent = (files: readonly FileRef[]) => files.every(file => file.reads.every(ref =>
    documents.list(file.workspace).some(doc => doc.id === ref.id && doc.revision === ref.revision && doc.usageVersion === ref.usageVersion)))
  function advanceOwnReads(plan: DreamPlan, workspace: string, receipt: DocumentReceipt) {
    const latest = documents.read(workspace, receipt.path)
    if (!latest || latest.id !== receipt.documentId || latest.revision !== receipt.revision || latest.usageVersion !== receipt.usageVersion) return
    for (const file of plan.files) if (file.workspace === latest.workspace) {
      const view = policy.read(file.workspace, file.path)
      if (!view || view.applicability.state === 'unavailable' || view.revision !== file.revision) continue
      const previous = new Map(file.reads.map(ref => [ref.id, ref]))
      // Only this exact receipt can explain a changed dependency. A new replacement
      // elsewhere in the chain must invalidate the persisted extraction instead.
      if (!view.supporting.some(doc => doc.id === latest.id)
        || view.supporting.some(doc => {
          const expected = doc.id === latest.id ? latest : previous.get(doc.id)
          return !expected || expected.revision !== doc.revision || expected.usageVersion !== doc.usageVersion
        }) || file.reads.some(ref => !view.supporting.some(doc => doc.id === ref.id))) continue
      file.sources = allSources([...file.sources, ...view.sourceTokens])
      file.reads = view.supporting.map(doc => ({ id: doc.id, revision: doc.revision, usageVersion: doc.usageVersion }))
      file.policyToken = view.policyToken
    }
  }
  function persist(job: Effect, plan: DreamPlan) {
    if (!effects.amend(job, plan)) throw new MemoryDreamStaleError()
  }
  function checkpointFiles(plan: DreamPlan, at: number) {
    let advanced = false
    for (const file of plan.files) {
      const waiting = plan.units.some(item => item.workspace === file.workspace && item.unit.paths.includes(file.path) && item.state !== 'done')
      if (!waiting && fileCurrent(file) && notes.markProcessed(file.key, file.checkpoint) && !file.oversized) advanced = true
    }
    if (advanced) store.setMeta('dream.lastProcessedAt', String(at))
  }
  function complete(job: Effect, plan: DreamPlan): Outcome {
    if (!effects.holds(job)) return 'done'
    transaction(() => {
      const at = now()
      checkpointFiles(plan, at)
      if (plan.retryExtraction) effects.amend(job, {})
      else {
        store.setMeta('dream.lastCheckedAt', String(at))
        store.setMeta('dream.lastCheckResult', plan.files.some(file => file.oversized) ? 'size-limit' : plan.files.length ? 'processed' : 'empty')
        const jobId = store.meta(MANUAL_JOB)
        if (jobId) {
          const receipt: MemoryDreamStatus = { state: 'idle', ...dreamHistory(store), jobId, completedAt: at }
          store.setMeta(receiptKey(jobId), JSON.stringify(receipt))
          store.setMeta(MANUAL_JOB, '')
        }
        effects.finishGeneration(job)
        schedule()
      }
    })
    return plan.retryExtraction ? 'retry' : 'done'
  }
  async function extract(job: Effect): Promise<DreamPlan | 'wait' | 'retry' | undefined> {
    const today = todayAt(now(), timezone)
    const from = new Date(Date.parse(today) - (scanDays - 1) * DAY_MS).toISOString().slice(0, 10)
    const plan: DreamPlan = { version: 1, files: [], units: [], tags: [], retryExtraction: false }
    let waitingForAdmission = false
    const changed = notes.changed(from, today).filter(note => {
      const refs = notes.references(note.key)
      if (!refsCurrent(refs) || refs.some(ref => documentSourceRestricted(ref, documents.sourceRestrictions(note.workspace))) || !materialAllowed(note.document, refs)) return false
      const admitted = refs.every(ref => { const original = source(ref.id); return original && eligible(original) })
      if (!admitted) waitingForAdmission = true
      return admitted
    })
    // Temporary recovery/turn admission is not an empty extraction. Keep the same durable job
    // until the owner's next wake, rather than postponing unprocessed notes to tomorrow.
    if (waitingForAdmission) return 'wait'
    const workspaces = unique(changed.map(note => note.workspace))
    const extracted: Array<{ workspace: string, unit: DreamUnit }> = []
    let count = 0, stopPass = false
    for (const workspace of workspaces) {
      if (stopPass) break
      const candidates = changed.filter(note => note.workspace === workspace
        && scopedDocuments(workspace).read(note.path)?.applicability?.state !== 'unavailable')
      const consume = async (batch: Note[]): Promise<void> => {
        if (stopPass || count >= dreamUnits || !effects.holds(job)) return
        const view = scopedDocuments(workspace)
        const snapshots = batch.map(note => view.read(note.path))
        if (snapshots.some(snapshot => !snapshot || snapshot.applicability?.state === 'unavailable')) return
        const seen = snapshots as ToolSnapshot[]
        const refs = batch.map((note, index) => ({ ...refOf(note, seen[index]!), sources: seen[index]!.sourceTokens,
          reads: seen[index]!.supporting.map(doc => ({ id: doc.id, revision: doc.revision, usageVersion: doc.usageVersion })) }))
        const sources = allSources(refs.flatMap(ref => ref.sources))
        const current = () => effects.holds(job) && refs.every(fileCurrent) && extractedReadsCurrent(refs)
          && seen.every(snapshot => view.read(snapshot.path)?.policyToken === snapshot.policyToken)
        if (!current()) { progress(job, 'source_changed', 'extract'); plan.retryExtraction = true; return }
        const rememberFiles = (oversized = false) => {
          for (const file of refs) if (!plan.files.some(previous => previous.key === file.key)) plan.files.push(oversized ? { ...file, oversized: true } : file)
        }
        const split = async () => {
          const middle = Math.floor(batch.length / 2)
          await consume(batch.slice(0, middle))
          if (!stopPass) await consume(batch.slice(middle))
        }
        let units: DreamUnit[] | undefined
        let invalid = false
        for (let attempt = 0; attempt < 2 && !units; attempt++) {
          try {
            const input = { maxUnits: dreamUnits - count, notes: batch.map((note, index) => {
              const snapshot = seen[index]!
              const name = parseMemoryDocument(snapshot.markdown).metadata.name
              const chars = [...snapshot.markdown]
              return { path: note.path, title: typeof name === 'string' ? name : '', markdown: chars.slice(0, defaults.dreamFileChars).join('') + (chars.length > defaults.dreamFileChars ? '\n\n[truncated]' : ''),
                applicability: snapshot.applicability, replacements: snapshot.supporting.map(doc => ({ path: doc.path, revision: doc.revision, markdown: doc.markdown })) }
            }), ...(invalid ? { retry: 'The prior JSON had an invalid shape, budget or source path. Correct it using only the supplied inputs.' } : {}) }
            if (batch.length > 1 && dreamBatchBytes && new TextEncoder().encode(JSON.stringify(input)).length > dreamBatchBytes) {
              await split()
              return
            }
            const result = await calculateStage({ job, stage: 'extract', system: DREAM_EXTRACT_SYSTEM, input,
              sourceIds: () => sources.map(ref => ref.id), current })
            if (result === undefined) { progress(job, 'unavailable', 'extract', attempt); stopPass = true; plan.retryExtraction = true; return }
            if (!current()) { progress(job, 'source_changed', 'extract', attempt); plan.retryExtraction = true; return }
            try { units = parseDreamUnits(parse(result), new Set(batch.map(note => note.path)), dreamUnits - count) }
            catch { invalid = true; progress(job, 'validation_failed', 'extract', attempt) }
          } catch (error) {
            if (error instanceof MemoryComputeError && error.reason === 'context-window-exceeded' && current()) {
              progress(job, 'oversized', 'extract', attempt)
              if (batch.length > 1) await split()
              // Its persisted note revision is reconsidered when its content changes.
              else rememberFiles(true)
              return
            }
            if (!isModelTimeout(error)) progress(job, safeDiagnosticReason(error), 'extract', attempt)
            stopPass = true
            plan.retryExtraction = true
            return
          }
        }
        if (!units || !current()) { stopPass = true; plan.retryExtraction = true; return }
        rememberFiles()
        for (const unit of units) extracted.push({ workspace, unit })
        count = plan.units.length + workspaces.reduce((sum, scope) => sum + mergeDreamUnits(extracted.filter(item => item.workspace === scope).map(item => item.unit)).length, 0)
      }
      for (const batch of batchDreamNotes(candidates, dreamBatchBytes)) await consume(batch)
    }
    if (!effects.holds(job)) return undefined
    for (const workspace of workspaces) for (const unit of mergeDreamUnits(extracted.filter(item => item.workspace === workspace).map(item => item.unit))) {
      const operationId = `dream:${identity.newId()}`
      plan.units.push({ workspace, operationId, unit, state: 'pending' })
    }
    if (stopPass && !plan.files.length) return 'retry'
    persist(job, plan)
    if (stopPass) return 'retry'
    return plan
  }
  async function integrate(job: Effect, plan: DreamPlan, item: PlannedUnit): Promise<'done' | 'retry' | 'wait'> {
    const committedReceipt = documents.receipt(item.workspace, item.operationId)
    if (committedReceipt) {
      advanceOwnReads(plan, item.workspace, committedReceipt)
      if (committedReceipt.revision && !plan.tags.some(tag => tag.workspace === item.workspace && tag.path === committedReceipt.path)) {
        plan.tags.push({ workspace: item.workspace, path: committedReceipt.path, revision: committedReceipt.revision, documentId: committedReceipt.documentId, attempted: false })
      }
      return 'done'
    }
    const files = plan.files.filter(file => file.workspace === item.workspace && item.unit.paths.includes(file.path))
    if (files.length !== unique(item.unit.paths).length || !files.every(fileCurrent)) throw new MemoryDreamStaleError()
    function sourceQuestionContext(id: string) {
      if (source(id)?.outcome !== 'document-clarification') return notes.sourceQuestionContext(id)
      const refs = documents.answerDependencies(id)
      return { current: refs.length > 0 && readable(id) && refsCurrent(refs), refs }
    }
    const scope = scopedDocuments(item.workspace)
    const readSources = new Map(allSources(files.flatMap(file => file.sources)).map(ref => [ref.id, ref]))
    const toolAttempts: ReturnType<typeof createMemoryDreamTools<ToolSnapshot>>[] = []
    const newTools = () => createMemoryDreamTools({ unit: item.unit, documents: scope,
      allowsDraftMaterial: markdown => materialAllowed(markdown, [...readSources.values()]), onRead(snapshot) {
        for (const ref of allSources([...readSources.values(), ...snapshot.sourceTokens, ...snapshot.correctionSources ?? []])) readSources.set(ref.id, ref)
      } })
    const questionContexts = new Map<string, DocumentSourceRef[]>()
    const refs = () => [...readSources.values()]
    const toolReads = () => toolAttempts.flatMap(tools => tools.reads())
    const readDocuments = () => toolReads().flatMap(snapshot => [...snapshot.backing ? [snapshot.backing] : [], ...snapshot.supporting])
    const current = () => effects.holds(job) && files.every(fileCurrent) && extractedReadsCurrent(files) && refsCurrent(refs())
      && refs().every(ref => { const original = source(ref.id); return original && eligible(original) }) && toolAttempts.every(tools => tools.current())
      && [...questionContexts].every(([id, refs]) => { const current = sourceQuestionContext(id);
        return current.current && JSON.stringify(current.refs) === JSON.stringify(refs) })
      && readDocuments().every(snapshot => {
        const latest = documents.read(item.workspace, snapshot.path)
        return latest?.id === snapshot.id && latest.revision === snapshot.revision && latest.usageVersion === snapshot.usageVersion
      })
    const skip = () => {
      if (!current()) throw new MemoryDreamStaleError()
      progress(job, 'deferred', 'integrate')
      return 'done' as const
    }
    if (!current()) throw new MemoryDreamStaleError()
    let repair: { reason: string, rejected: { action: string, target_path: string, markdown: string } } | undefined
    // One repair belongs to the same unit/operation. Both attempts retain their
    // reads, but each gets an isolated draft so a wrong target can be corrected.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current()) throw new MemoryDreamStaleError()
      const tools = newTools()
      toolAttempts.push(tools)
      const project = (text: string) => documents.projectErasedLocators?.(item.workspace, text) ?? text
      const raw = await calculateStage({ job, stage: 'integrate', system: DREAM_INTEGRATE_SYSTEM,
        input: { unit: item.unit, ...(repair ? { repair } : {}) },
        sourceIds: () => [...readSources.keys()], current, tools: { tools: tools.tools, executeTool: tools.executeTool } })
      if (raw === undefined) { progress(job, 'external_wake', 'integrate'); return 'wait' }
      if (!current()) throw new MemoryDreamStaleError()
      let output: unknown
      try { output = parse(raw) }
      catch (error) { progress(job, 'validation_failed', 'integrate', attempt); throw error }
      const deferred = deferredReply.safeParse(output)
      if (deferred.success) return skip()
      let draft: ReturnType<typeof tools.finish>
      try { draft = tools.finish(output) }
      catch (error) { progress(job, 'validation_failed', 'integrate', attempt); throw error }
      const substantive = draft.before && dreamChangesConclusion(draft.before.markdown, draft.markdown, item.unit.paths)
      if (!substantive && draft.receipt.action === 'CORRECT') throw new Error('memory-dream-correction-without-change')
      // Search hits stay in the authorization/read set. Only an actual citation makes a hit evidence for a direct write.
      let sources: DocumentSourceRef[] = []
      let corrections: DocumentCorrection[] = []
      if (!substantive) {
        const cited = new Set(memoryDocumentLinks(draft.markdown).map(link => link.split('#')[0]))
        sources = allSources([...files.flatMap(file => file.sources), ...draft.reads.filter(read => cited.has(read.path))
          .flatMap(read => [...read.sourceTokens, ...read.correctionSources ?? []])])
      }
      const restrictions = documents.sourceRestrictions(item.workspace)
      const canonicalSources: Array<{ sourceId: string, version: number, author: MemorySource['author'], text: string,
        question: string | null, questionUnavailable: boolean, at: number, timezone: string }> = []
      for (const ref of substantive ? readSources.values() : sources) {
        const { id } = ref
        const original = source(id)
        if (!original?.text) throw new MemoryDreamStaleError()
        if (!substantive && !original.question) continue
        const context = sourceQuestionContext(id)
        const wholeSource = !ref.spans || ref.spans.some(span => span.start === 0 && span.end === original.text!.length)
        const questionAllowed = Boolean(original.question) && wholeSource && context.current
          && !documentSourceRestricted({ id, token: ref.token }, restrictions)
          && context.refs.every(ref => !documentSourceRestricted(ref, restrictions))
          && (!context.refs.length || refsCurrent(context.refs))
          && allowsText(original.question!, original)
          && context.refs.every(ref => { const dependency = source(ref.id); return dependency?.text && allowsText(dependency.text, dependency) })
        if (questionAllowed) {
          questionContexts.set(id, context.refs)
          for (const dependency of allSources([...readSources.values(), ...context.refs])) readSources.set(dependency.id, dependency)
        }
        if (substantive) canonicalSources.push({ sourceId: original.id, version: original.version, author: original.author,
          text: project(projectDocumentSource(original.text, ref, restrictions)), question: questionAllowed ? project(original.question!) : null,
          questionUnavailable: (original.author === 'answer' || Boolean(original.question)) && !questionAllowed, at: original.at, timezone: original.timezone })
      }
      if (!materialAllowed(draft.markdown, refs()) || !current()) throw new MemoryDreamStaleError()
      if (!substantive) {
        if (!sources.length || files.some(file => !file.sources.length)
          || sources.some(ref => documentSourceRestricted(ref, restrictions))) throw new MemoryDreamStaleError()
      } else {
        const reviewed = await calculateStage({ job, stage: 'verify', system: DREAM_VERIFY_SYSTEM,
          input: { unit: item.unit, action: draft.receipt.action, note: draft.receipt.note, target_path: draft.path,
            before: draft.before && { path: draft.before.path, revision: draft.before.revision, markdown: draft.before.markdown },
            proposed: draft.markdown, documents: toolReads().map(doc => ({ path: doc.path, revision: doc.revision, markdown: doc.markdown, applicability: doc.applicability })),
            canonicalSources },
          sourceIds: () => [...readSources.keys()], current })
        if (reviewed === undefined) { progress(job, 'external_wake', 'verify'); return 'wait' }
        if (!current()) throw new MemoryDreamStaleError()
        let review: ReturnType<typeof validateDreamReview>
        try {
          review = validateDreamReview({ value: parse(reviewed), action: draft.receipt.action, sources: refs(), source,
            reads: toolReads(), unitSources: files.map(file => file.sources.map(ref => ref.id)),
            restricted: ref => documentSourceRestricted(ref, documents.sourceRestrictions(item.workspace)) })
        } catch (error) { progress(job, 'validation_failed', 'verify'); throw error }
        if (review.verdict === 'deferred') { progress(job, 'deferred', 'verify'); return skip() }
        if (review.verdict === 'rejected') {
          progress(job, 'validation_failed', 'verify', attempt)
          if (attempt === 1 || !materialAllowed(review.reason, refs())) return 'retry'
          repair = { reason: review.reason, rejected: { action: draft.receipt.action, target_path: draft.path, markdown: draft.markdown } }
          continue
        }
        sources = review.sources
        corrections = review.corrections
      }
      const correctionSources = corrections.flatMap(correction => toolReads().find(snapshot => snapshot.path === correction.path
        && snapshot.revision === correction.revision)?.sourceTokens ?? [])
      const evidence = allSources([...(draft.before?.sourceTokens ?? []), ...sources, ...sources.flatMap(ref => questionContexts.get(ref.id) ?? []), ...correctionSources])
      if (!current()) throw new MemoryDreamStaleError()
      const receipt = await mutate(() => {
        if (!current()) throw new MemoryDreamStaleError()
        return documents.commit({ operationId: item.operationId, workspace: item.workspace, path: draft.path,
        expectedRevision: draft.before?.revision ?? null, markdown: draft.markdown, action: draft.receipt.action,
        sources: evidence, reads: readDocuments(), corrections,
          files: unique([...files.map(file => JSON.stringify({ path: file.path, revision: file.revision })),
            ...toolReads().filter(snapshot => snapshot.path.startsWith('daily/')).map(snapshot => JSON.stringify({ path: snapshot.path, revision: snapshot.revision }))])
            .map(value => JSON.parse(value) as { path: string, revision: string }) })
      })
      advanceOwnReads(plan, item.workspace, receipt)
      committed(receipt)
      diagnostics.emit({ event: 'operation.progress', operation: 'memory.write', stage: 'applied',
        identities: { requestId: item.operationId, jobId: job.key, generation: job.generation, resourceId: receipt.documentId, methodId: receipt.action },
        metrics: { count: evidence.length } })
      if (receipt.revision) {
        const tag = plan.tags.find(tag => tag.workspace === item.workspace && tag.path === receipt.path)
        if (tag) { tag.revision = receipt.revision; tag.documentId = receipt.documentId; tag.attempted = false }
        else plan.tags.push({ workspace: item.workspace, path: receipt.path, revision: receipt.revision, documentId: receipt.documentId, attempted: false })
      }
      return 'done'
    }
    return 'retry'
  }
  async function tag(job: Effect, plan: DreamPlan) {
    for (const item of plan.tags) {
      if (item.attempted || !effects.holds(job)) continue
      // The attempt ledger below is durable before model IO, including across a plan replay.
      item.attempted = true
      const target = documents.read(item.workspace, item.path)
      const targetView = policy.read(item.workspace, item.path)
      if (!targetView || targetView.applicability.state !== 'current') continue
      if (!target || target.revision !== item.revision || !refsCurrent(target.sources)) continue
      const operationId = `tag:${identity.hash(JSON.stringify([item.workspace, target.id, target.revision]))}`
      if (documents.tagAttempt(item.workspace, operationId)) continue
      const attempt = { workspace: item.workspace, operationId, path: item.path, revision: target.revision }
      documents.recordTagAttempt({ ...attempt, state: 'attempted' })
      const fail = (reason: string) => documents.recordTagAttempt({ ...attempt, state: 'failed', reason })
      const current = () => effects.holds(job) && refsCurrent(target.sources)
        && policy.read(item.workspace, item.path)?.policyToken === targetView.policyToken
        && documents.read(item.workspace, item.path)?.revision === target.revision
        && documents.read(item.workspace, item.path)?.usageVersion === target.usageVersion
      let receipt: DocumentReceipt
      try {
        const result = await calculateStage({ job, stage: 'tag', system: DREAM_TAG_SYSTEM,
          input: { path: target.path, markdown: targetView.markdown }, sourceIds: () => target.sources.map(ref => ref.id), current })
        if (result === undefined) { progress(job, 'unavailable', 'tag'); fail('unavailable'); continue }
        if (!current()) { progress(job, 'source_changed', 'tag'); fail('unavailable'); continue }
        let reply: ReturnType<typeof tagReply.parse>
        try { reply = tagReply.parse(parse(result)) }
        catch (error) { progress(job, 'validation_failed', 'tag'); throw error }
        const markdown = updateMemoryFrontmatter(target.markdown, { memory_tags: unique(reply.memory_tags) })
        if (!materialAllowed(markdown, target.sources)) { fail('rejected'); continue }
        if (markdown === target.markdown) { documents.recordTagAttempt({ ...attempt, state: 'completed' }); continue }
        receipt = await mutate(() => {
          if (!current()) throw new MemoryDreamStaleError()
          return documents.commit({ operationId,
          workspace: item.workspace, path: target.path, expectedRevision: target.revision, markdown, action: 'TAG',
          sources: target.sources, reads: [target] })
        })
      } catch (error) {
        const saved = documents.receipt(item.workspace, operationId)
        if (!saved) {
          if (!isModelTimeout(error)) progress(job, error instanceof MemoryDreamStaleError ? 'source_changed' : safeDiagnosticReason(error), 'tag')
          fail(isModelTimeout(error) ? 'timeout' : 'failed')
          continue
        }
        receipt = saved
      }
      // If publication stops here, recovery replays the receipt, never the model request.
      advanceOwnReads(plan, item.workspace, receipt)
      committed(receipt)
      persist(job, plan)
    }
  }
  async function runJob(job: Effect): Promise<Outcome> {
    if (notes.needsRecovery() || documents.needsRecovery()) await mutate(() => {
      if (notes.needsRecovery()) notes.recover()
      if (documents.needsRecovery()) documents.recover()
    })
    let plan = planSchema.safeParse(job.payload).data
    if (!plan) {
      const extracted = await extract(job)
      if (extracted === 'wait' || extracted === 'retry') return extracted
      plan = extracted
    }
    if (!plan) return 'done'
    // A journal receipt can precede the effect-plan write when the process stops. Only exact owned receipts
    // may advance these reads; unrelated later revisions never count as our continuation.
    const priorPlan = JSON.stringify(plan)
    for (const unit of plan.units) {
      const receipt = documents.receipt(unit.workspace, unit.operationId)
      if (receipt) advanceOwnReads(plan, unit.workspace, receipt)
    }
    for (const item of plan.tags) {
      const id = item.documentId ?? documents.read(item.workspace, item.path, { includeDisabled: true })?.id
      if (!id) continue
      const receipt = documents.receipt(item.workspace, `tag:${identity.hash(JSON.stringify([item.workspace, id, item.revision]))}`)
      if (receipt) {
        advanceOwnReads(plan, item.workspace, receipt)
        if (!item.attempted) { committed(receipt); item.attempted = true }
      }
    }
    if (priorPlan !== JSON.stringify(plan)) persist(job, plan)
    if (plan.files.some(file => !fileCurrent(file))) {
      if (effects.holds(job)) effects.amend(job, {})
      return 'retry'
    }
    let retry = false, wait = false, unitTimedOut = false
    for (const item of plan.units) {
      if (item.state === 'deferred' || documents.retiredClarification(item.workspace, item.operationId)) {
        item.state = 'done'
        persist(job, plan)
      }
      if (item.state === 'done') continue
      try {
        const outcome = await integrate(job, plan, item)
        if (outcome === 'done') { item.state = outcome; persist(job, plan) }
        else if (outcome === 'wait') wait = true
        else retry = true
      } catch (error) {
        if (!effects.holds(job)) return 'done'
        if (isModelTimeout(error)) { unitTimedOut = true; break }
        progress(job, error instanceof MemoryDreamStaleError ? 'source_changed' : safeDiagnosticReason(error), 'integrate')
        if (error instanceof MemoryDreamStaleError) { effects.amend(job, {}); return 'retry' }
        retry = true
      }
    }
    if (unitTimedOut) retry = true
    else await tag(job, plan)
    if (retry || wait) {
      // Successful paths can checkpoint independently; the durable plan still retains failed units for retries.
      if (effects.holds(job)) transaction(() => checkpointFiles(plan, now()))
      return retry ? 'retry' : 'wait'
    }
    return complete(job, plan)
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
  documents.settleInterruptedTagAttempts()
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
      const jobId = store.meta(MANUAL_JOB) || operationId
      transaction(() => {
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
      const plan = planSchema.safeParse(job?.payload).data
      if (job && (!plan || plan.files.some(file => file.sources.some(ref => ref.id === sourceId)))) {
        transaction(() => { effects.cancel(DREAM, DAILY); schedule() })
      }
    },
  }
}
