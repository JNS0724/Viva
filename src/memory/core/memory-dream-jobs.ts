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
import type { MemorySource } from './ports/store.ts'
import type { DeferredDocumentWork, DocumentReceipt, DocumentSourceRef, MemoryDocuments } from './ports/documents.ts'
import { DREAM, nextDreamAt } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import { todayAt } from './memory-calendar.ts'
import { parseMemoryDocument, updateMemoryFrontmatter } from './memory-document.ts'
import { createMemoryDreamTools, MemoryDreamStaleError } from './memory-dream-tools.ts'
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
const fileRefSchema = z.object({ key: z.string(), workspace: z.string(), path: z.string(), revision: z.string(), policyToken: z.string().min(1), checkpoint: z.int(), sources: z.array(sourceRefSchema), reads: z.array(z.object({ id: z.string(), revision: z.string(), usageVersion: z.int() })).default([]) })
const planSchema = z.object({
  version: z.literal(1), files: z.array(fileRefSchema),
  units: z.array(z.object({ workspace: z.string(), operationId: z.string(), unit: dreamUnitSchema, state: z.enum(['pending', 'done', 'deferred']) })),
  tags: z.array(z.object({ workspace: z.string(), path: z.string(), revision: z.string(), attempted: z.boolean() })),
  retryExtraction: z.boolean(),
})
type DreamPlan = z.infer<typeof planSchema>
type FileRef = z.infer<typeof fileRefSchema>
type PlannedUnit = DreamPlan['units'][number]
type Note = NonNullable<ReturnType<MemoryNotes['read']>>
type ToolSnapshot = MemoryDocumentView
const deferredReply = z.strictObject({ status: z.literal('deferred'), reason: z.string().trim().min(1) })
const tagReply = z.strictObject({ memory_tags: z.array(z.string().trim().min(1)) })
const DAILY = 'daily'
const DAY_MS = 86_400_000
const unique = <T>(values: readonly T[]) => [...new Set(values)]
const parse = (text: string) => JSON.parse(text) as unknown

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

/** Four-stage document jobs. Storage and provider message/reasoning state stay behind their respective ports. */
export function createMemoryDreamJobs({ notes, documents, effects, identity, now, settings, readable, eligible, source, reference,
  calculate, transaction, mutate, committed = () => {}, allowsText = () => true, diagnostics: diagnosticPort }: {
  notes: MemoryNotes, documents: MemoryDocuments, effects: Effects, identity: MemoryIdentity, now: () => number,
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
  const { timezone, dreamTime, scanDays, dreamUnits, dreamBatchBytes } = { ...defaults, ...settings }
  if (!Number.isSafeInteger(scanDays) || scanDays < 1 || !Number.isSafeInteger(dreamUnits) || dreamUnits < 1) throw new Error('invalid-dream-settings')
  const schedule = () => effects.queue(DREAM, DAILY, null, nextDreamAt(now(), timezone, dreamTime))
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
  const deferredPoliciesCurrent = (work: DeferredDocumentWork) => work.files.every(file =>
    file.policyToken && policy.read(work.workspace, file.path)?.policyToken === file.policyToken)
    && Boolean(work.readPolicies?.every(file => policy.read(work.workspace, file.path)?.policyToken === file.policyToken))
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
  function complete(job: Effect, plan: DreamPlan): Outcome {
    if (!effects.holds(job)) return 'done'
    transaction(() => {
      for (const file of plan.files) {
        const waitingUnit = plan.units.some(item => item.workspace === file.workspace && item.unit.paths.includes(file.path) && item.state !== 'done')
        const waitingQuestion = documents.pending(file.workspace).some(item => item.status !== 'resolved' && item.status !== 'expired'
          && item.files.some(ref => ref.path === file.path && ref.revision === file.revision))
        if (!waitingUnit && !waitingQuestion && fileCurrent(file)) notes.markProcessed(file.key, file.checkpoint)
      }
      if (plan.retryExtraction) effects.amend(job, {})
      else { effects.finishGeneration(job); schedule() }
    })
    return plan.retryExtraction ? 'retry' : 'done'
  }
  async function extract(job: Effect): Promise<DreamPlan | undefined> {
    const today = todayAt(now(), timezone)
    const from = new Date(Date.parse(today) - (scanDays - 1) * DAY_MS).toISOString().slice(0, 10)
    const plan: DreamPlan = { version: 1, files: [], units: [], tags: [], retryExtraction: false }
    const changed = notes.changed(from, today).filter(note => {
      const refs = notes.references(note.key)
      return refsCurrent(refs) && !refs.some(ref => documentSourceRestricted(ref, documents.sourceRestrictions(note.workspace))) && refs.every(ref => { const original = source(ref.id); return original && eligible(original) })
        && materialAllowed(note.document, refs)
    })
    const allNotes = notes.list(null, null)
    const workspaces = unique(allNotes.map(note => note.workspace))
    const extracted: Array<{ workspace: string, unit: DreamUnit }> = []
    let count = 0
    for (const workspace of workspaces) {
      const pending = documents.pending(workspace).filter(work => {
        if (work.status === 'resolved' || work.status === 'expired') return false
        if (deferredPoliciesCurrent(work)) return true
        // A clarification answers the exact observed state, not a newer correction chain.
        documents.expire(workspace, work.operationId)
        return false
      })
      const scoped = changed.filter(note => note.workspace === workspace)
      // An unchanged ambiguous unit is dormant. A validated answer resumes that exact unit without another Extract.
      const dormant = pending.filter(work => work.status === 'pending_clarification' || work.status === 'ready')
      for (const work of dormant.filter(work => work.status === 'ready')) {
        if (count >= dreamUnits) break
        const files = work.files.map(ref => allNotes.find(note => note.workspace === workspace && note.path === ref.path && note.fileRevision === ref.revision))
        if (files.some(file => !file)) continue
        for (const note of files as Note[]) if (!plan.files.some(file => file.key === note.key)) {
          const ref = refOf(note)
          plan.files.push({ ...ref, sources: allSources([...ref.sources, ...work.sources]), reads: work.reads })
        }
        plan.units.push({ workspace, operationId: work.operationId, unit: work.unit, state: 'pending' }); count++
      }
      const candidates = scoped.filter(note => !dormant.some(work => work.files.some(ref => ref.path === note.path && ref.revision === note.fileRevision))
        && scopedDocuments(workspace).read(note.path)?.applicability?.state !== 'unavailable')
      const consume = async (batch: Note[]): Promise<void> => {
        if (count >= dreamUnits || !effects.holds(job)) return
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
        let units: DreamUnit[] | undefined
        let invalid = false
        for (let attempt = 0; attempt < 2 && !units; attempt++) {
          try {
            const result = await calculate({ job, stage: 'extract', system: DREAM_EXTRACT_SYSTEM,
              input: { maxUnits: dreamUnits - count, notes: batch.map((note, index) => {
                const snapshot = seen[index]!
                const name = parseMemoryDocument(snapshot.markdown).metadata.name
                const chars = [...snapshot.markdown]
                return { path: note.path, title: typeof name === 'string' ? name : '', markdown: chars.slice(0, defaults.dreamFileChars).join('') + (chars.length > defaults.dreamFileChars ? '\n\n[truncated]' : ''),
                  applicability: seen[index]!.applicability, replacements: seen[index]!.supporting.map(doc => ({ path: doc.path, revision: doc.revision, markdown: doc.markdown })) }
              }), ...(invalid ? { retry: 'The prior JSON had an invalid shape, budget or source path. Correct it using only the supplied inputs.' } : {}) },
              sourceIds: () => sources.map(ref => ref.id), current })
            if (result === undefined) { progress(job, 'unavailable', 'extract', attempt); plan.retryExtraction = true; return }
            if (!current()) { progress(job, 'source_changed', 'extract', attempt); plan.retryExtraction = true; return }
            try { units = parseDreamUnits(parse(result), new Set(batch.map(note => note.path)), dreamUnits - count) }
            catch { invalid = true; progress(job, 'validation_failed', 'extract', attempt) }
          } catch (error) {
            progress(job, safeDiagnosticReason(error), 'extract', attempt)
            if (!current() || error instanceof MemoryComputeError && ['dispatch-denied', 'aborted'].includes(error.reason)) { plan.retryExtraction = true; return }
            if (batch.length > 1) {
              const middle = Math.floor(batch.length / 2)
              await consume(batch.slice(0, middle)); await consume(batch.slice(middle))
            } else plan.retryExtraction = true
            return
          }
        }
        if (!units || !current()) { plan.retryExtraction = true; return }
        for (const file of refs) if (!plan.files.some(previous => previous.key === file.key)) plan.files.push(file)
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
    persist(job, plan)
    return plan
  }
  async function integrate(job: Effect, plan: DreamPlan, item: PlannedUnit): Promise<'done' | 'deferred' | 'retry' | 'wait'> {
    const committedReceipt = documents.receipt(item.workspace, item.operationId)
    if (committedReceipt) {
      advanceOwnReads(plan, item.workspace, committedReceipt)
      if (committedReceipt.revision && !plan.tags.some(tag => tag.workspace === item.workspace && tag.path === committedReceipt.path)) {
        plan.tags.push({ workspace: item.workspace, path: committedReceipt.path, revision: committedReceipt.revision, attempted: false })
      }
      documents.resolve(item.workspace, item.operationId)
      return 'done'
    }
    const files = plan.files.filter(file => file.workspace === item.workspace && item.unit.paths.includes(file.path))
    if (files.length !== unique(item.unit.paths).length || !files.every(fileCurrent)) throw new MemoryDreamStaleError()
    const previous = documents.deferred(item.workspace, item.operationId)
    if (previous && !deferredPoliciesCurrent(previous)) throw new MemoryDreamStaleError()
    if (previous?.status === 'pending_clarification') return 'deferred'
    // A foreground reply is durable before its user turn has completed. Retain
    // the pinned operation while its owning session still excludes Dream work.
    if (previous?.answer) {
      const answer = source(previous.answer.source.id)
      if (answer?.text && readable(answer.id) && !eligible(answer)) return 'wait'
    }
    function sourceQuestionContext(id: string) {
      if (source(id)?.outcome !== 'document-clarification') return notes.sourceQuestionContext(id)
      const refs = documents.answerDependencies(id)
      return { current: refs.length > 0 && readable(id) && refsCurrent(refs), refs }
    }
    const scope = scopedDocuments(item.workspace)
    const readSources = new Map(allSources([...files.flatMap(file => file.sources), ...previous?.answer ? [previous.answer.source] : []]).map(ref => [ref.id, ref]))
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
    const defer = (reason: string) => {
      if (!current()) throw new MemoryDreamStaleError()
      progress(job, 'deferred', 'integrate')
      const previousOperationId = previous?.status === 'ready' ? item.operationId : undefined
      const previousState = item.state
      try {
        transaction(() => {
          if (previousOperationId) item.operationId = `dream:${identity.newId()}`
          documents.defer({ operationId: item.operationId, workspace: item.workspace, unit: item.unit, reason,
            sources: refs(), reads: readDocuments(),
            readPolicies: toolReads().map(snapshot => ({ path: snapshot.path, policyToken: snapshot.policyToken })), files: files.map(file => ({ path: file.path, revision: file.revision, policyToken: file.policyToken })) }, previousOperationId)
          item.state = 'deferred'
          persist(job, plan)
        })
      } catch (error) {
        if (previousOperationId) item.operationId = previousOperationId
        item.state = previousState
        throw error
      }
      return 'deferred' as const
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
      const raw = await calculate({ job, stage: 'integrate', system: DREAM_INTEGRATE_SYSTEM,
        input: { unit: item.unit, ...(repair ? { repair } : {}), ...(previous?.answer ? { clarification: { text: project(projectDocumentSource(previous.answer.text, previous.answer.source, documents.sourceRestrictions(item.workspace))), sourceId: previous.answer.source.id } } : {}) },
        sourceIds: () => [...readSources.keys()], current, tools: { tools: tools.tools, executeTool: tools.executeTool } })
      if (raw === undefined) { progress(job, 'external_wake', 'integrate'); return 'wait' }
      if (!current()) throw new MemoryDreamStaleError()
      let output: unknown
      try { output = parse(raw) }
      catch (error) { progress(job, 'validation_failed', 'integrate', attempt); throw error }
      const deferred = deferredReply.safeParse(output)
      if (deferred.success) return defer(deferred.data.reason)
      let draft: ReturnType<typeof tools.finish>
      try { draft = tools.finish(output) }
      catch (error) { progress(job, 'validation_failed', 'integrate', attempt); throw error }
      // finish may add source reads; bind the expanded provenance before the independent review request.
      const canonicalSources: Array<{ sourceId: string, version: number, author: MemorySource['author'], text: string,
        question: string | null, questionUnavailable: boolean, at: number, timezone: string }> = []
      const inspected = new Set<string>()
      for (const [id, ref] of readSources) {
        if (inspected.has(id)) continue
        inspected.add(id)
        const original = source(id)
        if (!original?.text) throw new MemoryDreamStaleError()
        const restrictions = documents.sourceRestrictions(item.workspace)
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
        canonicalSources.push({ sourceId: original.id, version: original.version, author: original.author,
          text: project(projectDocumentSource(original.text, ref, restrictions)), question: questionAllowed ? project(original.question!) : null,
          questionUnavailable: (original.author === 'answer' || Boolean(original.question)) && !questionAllowed, at: original.at, timezone: original.timezone })
      }
      if (!materialAllowed(draft.markdown, refs()) || !current()) throw new MemoryDreamStaleError()
      const reviewed = await calculate({ job, stage: 'verify', system: DREAM_VERIFY_SYSTEM,
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
      if (review.verdict === 'deferred') { progress(job, 'deferred', 'verify'); return defer(review.reason) }
      if (review.verdict === 'rejected') {
        progress(job, 'validation_failed', 'verify', attempt)
        if (attempt === 1 || !materialAllowed(review.reason, refs())) return 'retry'
        repair = { reason: review.reason, rejected: { action: draft.receipt.action, target_path: draft.path, markdown: draft.markdown } }
        continue
      }
      const correctionSources = review.corrections.flatMap(correction => toolReads().find(snapshot => snapshot.path === correction.path
        && snapshot.revision === correction.revision)?.sourceTokens ?? [])
      const evidence = allSources([...(draft.before?.sourceTokens ?? []), ...review.sources, ...review.sources.flatMap(ref => questionContexts.get(ref.id) ?? []), ...correctionSources])
      if (!current()) throw new MemoryDreamStaleError()
      const receipt = await mutate(() => {
        if (!current()) throw new MemoryDreamStaleError()
        return documents.commit({ operationId: item.operationId, workspace: item.workspace, path: draft.path,
        expectedRevision: draft.before?.revision ?? null, markdown: draft.markdown, action: draft.receipt.action,
        sources: evidence, reads: readDocuments(), corrections: review.corrections,
          files: unique([...files.map(file => JSON.stringify({ path: file.path, revision: file.revision })),
            ...toolReads().filter(snapshot => snapshot.path.startsWith('daily/')).map(snapshot => JSON.stringify({ path: snapshot.path, revision: snapshot.revision }))])
            .map(value => JSON.parse(value) as { path: string, revision: string }) })
      })
      advanceOwnReads(plan, item.workspace, receipt)
      committed(receipt)
      documents.resolve(item.workspace, item.operationId)
      if (receipt.revision) {
        const tag = plan.tags.find(tag => tag.workspace === item.workspace && tag.path === receipt.path)
        if (tag) { tag.revision = receipt.revision; tag.attempted = false }
        else plan.tags.push({ workspace: item.workspace, path: receipt.path, revision: receipt.revision, attempted: false })
      }
      return 'done'
    }
    return 'retry'
  }
  async function tag(job: Effect, plan: DreamPlan) {
    for (const item of plan.tags) {
      if (item.attempted || !effects.holds(job)) continue
      // Attempt is durable before model IO. Auto Tag is best-effort and never turns a completed integration into a retry loop.
      item.attempted = true; persist(job, plan)
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
      try {
        const result = await calculate({ job, stage: 'tag', system: DREAM_TAG_SYSTEM,
          input: { path: target.path, markdown: targetView.markdown }, sourceIds: () => target.sources.map(ref => ref.id), current })
        if (result === undefined) { progress(job, 'unavailable', 'tag'); fail('unavailable'); continue }
        if (!current()) { progress(job, 'source_changed', 'tag'); fail('unavailable'); continue }
        let reply: ReturnType<typeof tagReply.parse>
        try { reply = tagReply.parse(parse(result)) }
        catch (error) { progress(job, 'validation_failed', 'tag'); throw error }
        const markdown = updateMemoryFrontmatter(target.markdown, { memory_tags: unique(reply.memory_tags) })
        if (!materialAllowed(markdown, target.sources)) { fail('rejected'); continue }
        if (markdown === target.markdown) { documents.recordTagAttempt({ ...attempt, state: 'completed' }); continue }
        const receipt = await mutate(() => {
          if (!current()) throw new MemoryDreamStaleError()
          return documents.commit({ operationId,
          workspace: item.workspace, path: target.path, expectedRevision: target.revision, markdown, action: 'TAG',
          sources: target.sources, reads: [target] })
        })
        advanceOwnReads(plan, item.workspace, receipt)
        committed(receipt)
        documents.recordTagAttempt({ ...attempt, state: 'completed' })
        persist(job, plan)
      } catch (error) { progress(job, error instanceof MemoryDreamStaleError ? 'source_changed' : safeDiagnosticReason(error), 'tag'); fail('failed') }
    }
  }
  async function runJob(job: Effect): Promise<Outcome> {
    await mutate(() => { notes.recover(); documents.recover() })
    let plan = planSchema.safeParse(job.payload).data
    if (!plan) plan = await extract(job)
    if (!plan) return 'done'
    // A journal receipt can precede the effect-plan write when the process stops. Only exact owned receipts
    // may advance these reads; unrelated later revisions never count as our continuation.
    const priorPlan = JSON.stringify(plan)
    for (const unit of plan.units) {
      const receipt = documents.receipt(unit.workspace, unit.operationId)
      if (receipt) advanceOwnReads(plan, unit.workspace, receipt)
    }
    for (const item of plan.tags) {
      const latest = documents.read(item.workspace, item.path)
      if (!latest) continue
      const receipt = documents.receipt(item.workspace, `tag:${identity.hash(JSON.stringify([item.workspace, latest.id, item.revision]))}`)
      if (receipt) advanceOwnReads(plan, item.workspace, receipt)
    }
    if (priorPlan !== JSON.stringify(plan)) persist(job, plan)
    if (plan.files.some(file => !fileCurrent(file))) {
      if (effects.holds(job)) effects.amend(job, {})
      return 'retry'
    }
    for (const item of plan.units) {
      const work = documents.deferred(item.workspace, item.operationId)
      if (work && (work.status === 'ready' || work.status === 'pending_clarification') && !deferredPoliciesCurrent(work)) {
        documents.expire(item.workspace, item.operationId)
        if (effects.holds(job)) effects.amend(job, {})
        return 'retry'
      }
    }
    let retry = false, wait = false
    for (const item of plan.units) {
      if (item.state === 'deferred') {
        const pending = documents.deferred(item.workspace, item.operationId)
        if (pending?.status === 'ready') item.state = 'pending'
        else if (!pending) { item.operationId = `dream:${identity.newId()}`; item.state = 'pending' }
      }
      if (item.state === 'done' || item.state === 'deferred') continue
      try {
        const outcome = await integrate(job, plan, item)
        if (outcome === 'done' || outcome === 'deferred') { item.state = outcome; persist(job, plan) }
        else if (outcome === 'wait') wait = true
        else retry = true
      } catch (error) {
        progress(job, error instanceof MemoryDreamStaleError ? 'source_changed' : safeDiagnosticReason(error), 'integrate')
        if (!effects.holds(job)) return 'done'
        if (error instanceof MemoryDreamStaleError) { effects.amend(job, {}); return 'retry' }
        retry = true
      }
    }
    await tag(job, plan)
    if (retry || wait) {
      // Successful paths can checkpoint independently; the durable plan still retains failed units for retries.
      for (const file of plan.files) if (fileCurrent(file) && !plan.units.some(item => item.workspace === file.workspace
        && item.unit.paths.includes(file.path) && item.state !== 'done')
        && !documents.pending(file.workspace).some(work => work.files.some(ref => ref.path === file.path && ref.revision === file.revision))) notes.markProcessed(file.key, file.checkpoint)
      return retry ? 'retry' : 'wait'
    }
    return complete(job, plan)
  }
  effects.runs(DREAM, async jobs => {
    const outcomes = new Map<string, Outcome>()
    for (const job of jobs) {
      try {
        const outcome = await runJob(job)
        outcomes.set(job.key, outcome)
        progress(job, outcome === 'retry' ? 'retry' : outcome === 'wait' ? 'external_wake' : 'normal')
      } catch (error) { progress(job, safeDiagnosticReason(error)); outcomes.set(job.key, 'retry') }
    }
    return outcomes
  }, attempts => Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** attempts))
  transaction(() => { if (!effects.get(DREAM, DAILY)) schedule() })
  return {
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
