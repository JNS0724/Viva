import { createMemoryReadPolicy, contextAllows, sourceCanRead, retained, visible } from './memory-read-policy.ts'
import { EXTRACT_SYSTEM, REVIEW_SYSTEM, QUESTION_SYSTEM, questionReview } from './memory-extraction.ts'
import { MemoryDomainError, defaultMemoryText } from './presentation.ts'
import type { MemoryPresentation } from './presentation.ts'
import type { MemoryDomainErrorCode } from '../contracts/domain-error.ts'
import type { MemoryRuntimeResources } from './ports/runtime.ts'
import { z } from 'zod'
import { PROFILE_KEYS, MAX_FIELD_CHARS } from '../contracts/profile.ts'
import { MEMORY_SEMANTIC_TIMEOUT_MS, memoryKind, memoryProposals, memoryReviews, memoryScope, operationId } from '../contracts/memory-contract.ts'
import type { MemoryCompute, MemoryProposal, MemoryRequest, MemoryReview, MemoryScope, MemorySpan } from '../contracts/memory-contract.ts'
import { looksSecret, MAX_MEMORY_CHARS } from './memory-sensitive.ts'
import { dateLine, packContext } from './memory-context.ts'
import type { ProfileContextItem } from './memory-context.ts'
import { recallCandidates, recallMatches } from './memory-match.ts'
import { memoryIdentifierTokens, memoryIndexMatches } from './search-tokens.ts'
import { expandMemoryRelations, memoryRelationQueryLabels } from './memory-relations.ts'
import type { MemoryRelationEntity, MemoryRelationProof } from './memory-relations.ts'
import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_MAX_CHARS } from '../contracts/embedding.ts'
import type { MemoryEmbedder } from '../contracts/embedding.ts'
import type { MemorySemanticReference } from './ports/semantic.ts'
import { createMemorySemanticMaintenance } from './memory-semantic-maintenance.ts'
import { MEMORY_PROFILE_INPUT_LIMIT, prepareMemoryProfileInput } from './memory-profile.ts'
import type { MemoryProfileInput, MemoryProfileRef, MemoryProfileScope } from './memory-profile.ts'
import { createMemoryProfileJobs } from './memory-profile-jobs.ts'
import type { MemoryProfileSnapshot } from './memory-profile-jobs.ts'
import { MemoryDispatchConflict, type MemoryDependency } from './memory-dispatch.ts'
import type { Effect, Outcome } from './ports/effects.ts'
import type { MemoryCandidate, MemoryChange, MemoryChangeKind, MemoryEntry, MemoryProvenance, MemorySource, MemoryStore } from './ports/store.ts'
import { compatibleTransitionTime, covers, factIdentity, groundedChange, groundedEventChange, groundedFact, localDay, nextDay, proposalSpans, rememberContent, resolveMemoryTime, sameRelation, sourceText, spanEnvelope, statementIsQuestion, todayAt, validChangeEvidence } from './memory-facts.ts'
import type { GroundedChange, MemoryFact } from './memory-facts.ts'
import { intersect, overlapWindows, sameWindows, subtract } from './memory-intervals.ts'
import type { MemoryInterval } from './memory-intervals.ts'
import { objectOf } from '../contracts/unknown-value.ts'
import { createMemoryClarifications } from './memory-clarification.ts'
import { connected, projectTimeline } from './memory-timeline.ts'
import { createMemoryNoteJobs } from './memory-note-jobs.ts'
import { dreamExtraction } from './memory-notes.ts'
import { createDailySemanticSearch, dailySearchLimit, markdownSearchChunks, rankDailyMemory } from './memory-daily-search.ts'
import type { DailySearchDocument, SearchChunk } from './memory-daily-search.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import type { DailyMemorySettings } from './memory-notes.ts'

type ConflictSide = Pick<MemoryEntry, 'id' | 'revision'>
type ConflictResolution = { kind: 'keep-first' | 'keep-both' | 'discard-both' } | { kind: 'replace', text: string }
type UndoResult = { status: 'applied' } | { status: 'conflict', current: ConflictSide[] }
type AffectedInterval = MemoryInterval & { windows?: MemoryInterval[] }

const EXTRACT = 'memory.extract'
const EXPIRE = 'memory.expire'
const READ_LIMIT = 200
// Bound the serialized tool response, including evidence, escaped characters and metadata.
export const MAX_RECALL_CHARS = 6000
export const MAX_DEEP_RECALL_CHARS = 12000
const INDEX_MATCH_LIMIT = 64
const KEYWORD_FALLBACK_LIMIT = 128
const RELATION_NEIGHBOR_LIMIT = 24
const PENDING_RECALL_LIMIT = 64
const USER = { kind: 'user' } as const
const CORRECT = /^(?:请\s*)?(?:更正|纠正|correct)\s*#(\d+)\s*(?:为|[:：]|to)\s*(.+)$/is
const INTENT = {
  forget: /^(?:请\s*)?(?:帮我\s*)?(?:忘掉|忘记|别再记|别再用|forget)\s*[:：]?\s*#(\d+)\s*[。.!！]?$/iu,
}

type Origin = { conversation: string | null, session: string | null, scope?: MemoryScope, context?: MemoryScope, project?: Extract<MemoryProfileScope, { kind: 'project' }>, foregroundTurn?: string, turn?: string }
type DisputeReference = {
  kind: 'dispute',
  id: number, revision: number, sides: readonly [ConflictSide, ConflictSide],
  scope?: MemoryScope, asOf?: string,
}
type PendingChangeReference = Pick<MemoryCandidate, 'sourceId' | 'start' | 'end'> & {
  kind: 'pending', sourceVersion: number, candidateHash: string, expiresAt: number, scope?: MemoryScope, asOf?: string,
}
type ClarificationReference = DisputeReference | PendingChangeReference
type AnswerSource = { question: string, requestId: string, questionId: string, custom?: true }
type Receipt = { sourceId: string, outcome: string }
const withdrawalPayload = z.object({ ids: z.array(z.string()), conversation: z.string(), onlySources: z.literal(true).optional() })
export type MemoryWithdrawal = z.infer<typeof withdrawalPayload>
const structureJob = z.object({ id: z.number().int().positive(), start: z.number().int().nonnegative(), end: z.number().int().positive() })
const pendingChangeData = z.object({ sourceVersion: z.number().int().positive(), scope: memoryScope, proposal: memoryProposals.shape.proposals.element,
  sameRelation: z.boolean(), conditions: z.enum(['equivalent', 'overlap']).optional(), event: z.boolean().optional() })
type Route = { provider: string, model: string }

function sourceSpans(text: string): Array<{ start: number, end: number }> {
  const trimmed = text.trim()
  const start = text.length - text.trimStart().length
  return trimmed ? [{ start, end: start + trimmed.length }] : []
}
function historySpans(text: string) {
  return [text, ...text.split(/(?:[。！!?！？；;，,]|\r?\n)+/u)]
}
const textOf = (result: object) => JSON.stringify(result)
const sameScope = (a: MemoryScope, b: MemoryScope) => a.kind === b.kind && (a.kind === 'user' || 'id' in b && a.id === b.id)
const automaticSource = (source: MemorySource) => source.author === 'user' || source.author === 'answer'

export function createMemoryRuntime({ store, resources, presentation = {}, compute, route, embedder, maintainSemanticIndex = false, profilesEnabled = false, profileDelayMs, profileBusy = () => false, projectionChanged, quiesce, changed, injected, dependencies, provisionalRead,
  dailyNotes = false, automaticFactProcessing = dailyNotes ? 'daily' : 'source', noteSourcesUsed,
  canCommit = () => true, validateDispatch = () => {}, now = Date.now, timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone }: {
  store: MemoryStore,
  resources: MemoryRuntimeResources,
  presentation?: MemoryPresentation,
  compute: (request: MemoryCompute, signal?: AbortSignal) => Promise<string> | null,
  route: () => Route | null,
  embedder?: Pick<MemoryEmbedder, 'fingerprint' | 'embedBatch' | 'close'>,
  maintainSemanticIndex?: boolean,
  profilesEnabled?: boolean,
  dailyNotes?: boolean | DailyMemorySettings,
  /** Long-term admission trigger; capturing daily notes does not itself choose the fact engine. */
  automaticFactProcessing?: 'source' | 'daily',
  noteSourcesUsed?: (session: string, sources: readonly string[]) => void,
  profileDelayMs?: number,
  profileBusy?: () => boolean,
  projectionChanged?: () => void,
  quiesce: () => Promise<void>,
  changed: (change: { revision: number, ids: number[], learned?: string[], invalidated?: number[] }) => void,
  now?: () => number,
  timezone?: () => string,
  injected?: (session: string, turn: number, pushed: Array<{ text: string, names: string[] }>) => void,
  dependencies?: (session: string, items: MemoryDependency[]) => void,
  provisionalRead?: (session: string) => void,
  canCommit?: (source: MemorySource) => boolean,
  validateDispatch?: () => void,
}) {
  const { effects, projectionStore, lexical, identity: { newId: randomUUID, hash: memoryHash } } = resources
  const presentMessage = presentation.text ?? defaultMemoryText
  const domainError = (code: MemoryDomainErrorCode) => new MemoryDomainError(code, presentMessage(code))
  function clean(input: string, max = MAX_MEMORY_CHARS): string {
    const value = input.trim()
    if (!value || value.length > max) throw domainError('invalid.text')
    if (looksSecret(value)) throw domainError('credentials')
    return value
  }
  let semantic = resources.openSemantic()
  let lexicalTimer: ReturnType<typeof setTimeout> | undefined
  const turnSources = new Map<string, string[]>()
  const clarifications = createMemoryClarifications<ClarificationReference, PendingChangeReference>()
  const blocked = new Set<string>()
  const blockedSources = new Set<string>()
  const sourceBlocked = (source: Pick<MemorySource, 'id' | 'conversation'>) => blockedSources.has(source.id)
    || (source.conversation !== null && blocked.has(source.conversation))
  const evidenceBlocked = (edge: { sourceId: string, conversationId: string | null }) =>
    sourceBlocked({ id: edge.sourceId, conversation: edge.conversationId })
  const { available, independentWindows, pendingRelationWindows, selection, recallInterval, classify, recallSelection, scopedEntries, valid, entriesWithPeers, readableSelection, dependenciesCurrent, dispatchDeadline, disputeBetween } = createMemoryReadPolicy({ store, now, timezone, evidenceBlocked, sourceBlocked })
  let mutation: Promise<unknown> | null = null
  let closed = false
  const runningComputations = new Map<string, { ready: () => boolean, current: () => boolean, deadline: number | null }>()
  const semanticControllers = new Map<AbortController, { current: () => boolean, reads: readonly IndexHit[] }>()
  const maintenance = maintainSemanticIndex && embedder ? createMemorySemanticMaintenance({
    index: () => semantic, embedder,
    busy: () => Boolean(mutation || semanticControllers.size || blocked.size || blockedSources.size),
    page(afterId, limit) {
      const refs = semantic?.missingAfter(embedder.fingerprint, afterId, limit) ?? []
      return { entries: refs.flatMap(ref => {
        const entry = indexableEntry(ref)
        return entry ? [{ ...ref, text: passageText(entry) }] : []
      }), nextId: refs.length === limit ? refs.at(-1)!.id : null }
    },
    current: ref => indexableEntry(ref) !== null,
  }) : null
  const profiles = profilesEnabled ? createMemoryProfileJobs({
    identity: resources.identity, effects, store: projectionStore, tx: store.tx, revision: store.revision, route, now, delayMs: profileDelayMs,
    ready: profileInputCurrent,
    busy: () => Boolean(mutation || blocked.size || blockedSources.size || profileBusy()),
    makeSnapshot(scope, at) {
      const choices = profileChoices(scope, at)
      const manual: MemoryProfileInput[] = scope.kind === 'user' ? Object.entries(store.profile()).flatMap(([field, data]) =>
        data ? [{ ref: { kind: 'manual', field, revision: data.revision }, text: data.value }] : []) : []
      const inputs = prepareMemoryProfileInput(scope, [...manual, ...choices])
      const ids = inputs.flatMap(({ ref }) => ref.kind === 'memory' ? [{ id: ref.id, revision: ref.revision }] : [])
      const deadline = Math.min(store.nextProfileBoundary(scope, at) ?? Infinity, dispatchDeadline(ids, [], at) ?? Infinity)
      return { inputs, validUntil: Number.isFinite(deadline) ? deadline : null }
    },
    dispatch(request, signal, admission) {
      runningComputations.set(request.id, admission)
      const drop = () => runningComputations.delete(request.id)
      try {
        const result = compute(request, signal)
        if (result) return result.finally(drop)
        drop()
        return null
      } catch (error) {
        drop()
        throw error
      }
    },
    changed: projectionChanged,
  }) : null
  const cleanup = resources.createCleanup({
    clearSemantic(ids, revision) {
      if (semantic?.purge(ids, revision)) return true
      if (resources.semanticCopiesCleared(ids, revision)) return true
      semantic = resources.openSemantic()
      return semantic?.purge(ids, revision) ?? resources.semanticCopiesCleared(ids, revision)
    },
    clearProfile(revision) {
      projectionStore.invalidate(revision)
      return true
    },
    onCleared: projectionChanged,
  })
  profiles?.observe({ kind: 'user' })
  function warmLexicalIndex() {
    if (closed || lexicalTimer !== undefined || !lexical.pending()) return
    lexicalTimer = setTimeout(() => {
      lexicalTimer = undefined
      if (!closed && lexical.refreshBatch()) warmLexicalIndex()
    }, 25)
    lexicalTimer.unref()
  }
  // The file pipeline owns full session text, including text not selected as a long-term fact.
  // Legacy fact/candidate compaction must not mutate that pipeline's versioned evidence.
  function retainSessionSource(id: string) {
    if (!dailyNotes || store.sourceExcluded(id)) return false
    const source = store.readSource(id)
    return Boolean(source?.session && source.conversation && !source.withdrawn)
  }
  store.expire(retainSessionSource)
  function scheduleExpiry() {
    const next = store.nextCandidateExpiry()
    if (next === null) effects.cancel(EXPIRE, 'candidates')
    else effects.queue(EXPIRE, 'candidates', null, next)
  }
  effects.runs(EXPIRE, async jobs => {
    if (jobs.some(effects.holds)) store.tx(() => {
      store.expire(retainSessionSource)
      scheduleExpiry()
    })
    return new Map(jobs.map(job => [job.key, 'done' as const]))
  })
  scheduleExpiry()
  warmLexicalIndex()
  maintenance?.schedule()

  function publish(revision: number, ids: number[], learned?: string[], invalidated?: number[]) {
    lexical?.refresh()
    warmLexicalIndex()
    maintenance?.schedule(true)
    profiles?.sync()
    try { changed({ revision, ids, learned, invalidated }) } catch { console.error('[memory] could not publish committed revision') }
  }

  function createSource(text: string, origin: Origin, operation: string, author: MemorySource['author'], answer?: AnswerSource, explicit = false, saved?: string, captured?: { at: number, timezone: string }) {
    const id = operationId.parse(operation)
    const secret = looksSecret(text) || (answer !== undefined && looksSecret(answer.question))
    const denied = secret || (author === 'answer' && !answer?.custom)
      || (!explicit && (excludedSourceText(text, origin.context ?? origin.scope) || origin.project && excludedSourceText(text, origin.project)))
    const hash = denied ? null : memoryHash(text)
    const existing = store.readSource(id)
    if (existing) {
      if (existing.author !== author || existing.conversation !== origin.conversation || (existing.hash !== null && existing.hash !== memoryHash(text))
        || existing.requestId !== (answer?.requestId ?? null) || existing.questionId !== (answer?.questionId ?? null)) throw domainError('operation.conflict')
      return existing
    }
    const source: MemorySource = {
      id, operation: id, version: 1, conversation: origin.conversation, session: origin.session,
      scope: origin.scope ?? USER, context: origin.context ?? null, project: origin.project ?? null, author, text: denied ? null : text, hash: denied ? null : hash,
      rememberedHash: saved && !denied ? memoryHash(saved) : null, length: denied ? 0 : text.length,
      question: answer && !denied && !store.excluded(answer.question, origin.context ?? origin.scope) ? answer.question.slice(0, 1000) : null,
      requestId: answer?.requestId ?? null, questionId: answer?.questionId ?? null,
      at: captured?.at ?? now(), timezone: captured?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      outcome: denied ? 'rejected' : 'pending', withdrawn: false,
    }
    store.insertSource(source)
    return source
  }

  function bindSource(id: string, session: string | null, conversation?: string | null) {
    if (!session) return
    const source = store.readSource(id)
    if (!source?.rememberedHash || (conversation !== undefined && source.conversation !== conversation) || source.withdrawn
      || store.sourceExcluded(id)) return
    turnSources.set(session, [...new Set([...(turnSources.get(session) ?? []), id])].slice(-24))
  }

  function accept(text: string, origin: Origin, operation: string = randomUUID(), answer?: AnswerSource, intake?: { deferAutomatic?: boolean, at: number, timezone: string }): Receipt {
    const source = store.tx(() => {
      const known = store.readSource(operation)
      const content = rememberContent(text)
      const explicit = content && content.length <= MAX_MEMORY_CHARS ? content : undefined
      const current = createSource(text, origin, operation, answer === undefined ? 'user' : 'answer', answer, Boolean(explicit), explicit, intake)
      if ((known && known.outcome !== 'received') || !current.text) return current
      if (intake?.deferAutomatic && !explicit) {
        store.outcome(current.id, 'received')
        return { ...current, outcome: 'received' }
      }
      if (explicit) {
        const start = text.lastIndexOf(explicit)
        const scope = current.scope.kind === 'user' && origin.conversation
          ? origin.context ?? { kind: 'conversation', id: origin.conversation } : current.scope
        // This holder remains outside every model read until the extraction transaction admits it.
        // Queue it without changing the visible collection or interrupting a request already sending it.
        savedText(current, { start, end: start + explicit.length }, scope, 'fact', 'agent', [], store.revision, new Set(), { separate: true })
        store.outcome(current.id, 'explicit-pending')
        return { ...current, outcome: 'explicit-pending' }
      }
      if (automaticFactProcessing === 'daily' && dailyNotes && origin.session && origin.conversation) {
        store.outcome(current.id, 'note-pending')
        return { ...current, outcome: 'note-pending' }
      }
      // Completion promotes a durably received original into the extraction queue exactly once.
      store.outcome(current.id, 'pending')
      effects.queue(EXTRACT, current.id, null)
      return { ...current, outcome: 'pending' as const }
    })
    if (source.outcome === 'pending' || source.outcome === 'explicit-pending') void effects.wake()
    return { sourceId: source.id, outcome: source.outcome === 'explicit-pending' ? 'pending'
      : source.outcome === 'explicit-accepted' ? 'accepted' : source.outcome }
  }

  function queueStructure(source: MemorySource, entry: MemoryEntry, start: number, end: number) {
    if (!entry.fact) effects.queue(EXTRACT, source.id, { id: entry.id, start, end })
  }

  const modelEligible = (entry: MemoryEntry) => store.modelEligible(entry.id)

  // A known source being withdrawn can narrow an assertion even when another source keeps it retained.
  const wholeEvidenceAvailable = (entry: MemoryEntry) => !entry.evidence.some(evidenceBlocked)

  function put(source: MemorySource, details: Pick<MemoryEntry, 'kind' | 'scope' | 'modality' | 'conditional' | 'keywords' | 'source'>,
    span: { start: number, end: number }, revision: () => number, ids: Set<number>, options: {
      fact?: MemoryFact | null, existing?: MemoryEntry, interval?: MemoryInterval, separate?: boolean, spans?: MemorySpan[],
    } = {}) {
    const { fact, existing, separate } = options
    const spans = options.spans ?? fact?.evidence.spans ?? [span]
    const text = sourceText(source.text!, spans)
    const timing = fact ?? resolveMemoryTime(undefined, source.at, source.timezone)
    const interval = options.interval ?? timing
    // Only identical assertions are deduplicated. A different atom or qualifier can change the meaning.
    const duplicate = existing || (!separate && store.sameText(text, details.scope).find(entry => retained(entry)
      && entry.kind === details.kind && entry.modality === details.modality && entry.conditional === details.conditional
      && entry.assertedTo === interval.to
      && ((!timing.dated && !entry.fact?.dated && entry.assertedTo === null && visible(entry, source.at)) || entry.assertedFrom === interval.from)
      && (fact ? entry.fact && entry.fact.subject === fact.subject && entry.fact.polarity === fact.polarity
        && sameRelation(entry.fact.relation, fact.relation) && factIdentity(entry.fact.object) === factIdentity(fact.object) : !entry.fact)))
    const rev = revision()
    const id = duplicate ? duplicate.id : store.insert({ ...details, text, conversationId: source.conversation }, rev, now(), interval)
    if (fact) store.recordFact(id, fact)
    const existingChange = existing?.evidence.find(edge => edge.sourceId === source.id)?.changeId ?? null
    if (existing) {
      for (const edge of existing.evidence) if (edge.sourceId === source.id && (edge.start !== span.start || edge.end !== span.end)) {
        store.removeEvidence(id, source.id, edge.start, edge.end)
      }
      store.setAssertion(id, interval, text, details)
    }
    store.evidence(id, source, span.start, span.end, fact?.evidence ?? null, existingChange, interval, spans, !fact?.dated || fact.uncertain)
    store.touch(id, rev)
    ids.add(id)
    return store.get(id)!
  }

  function timelineRows(members: ReadonlySet<number>) {
    return [...members].flatMap(id => {
      const entry = store.get(id)
      if (!entry) return []
      const supports = entry.evidence.flatMap(edge => {
        const source = store.readSource(edge.sourceId)
        const text = source?.text && sourceText(source.text, edge.spans)
        return text?.trim() ? [{ ...edge, text }] : []
      })
      return [{ entry, supports }]
    })
  }

  function reproject(ids: Set<number>, revision: number) {
    const history = store.listChanges()
    const members = connected(ids, history)
    const applied = store.appliedChanges().filter(change => members.has(change.targetId))
    const { entries, byId, projected, competing, transitions, unresolvedEnds } = projectTimeline(timelineRows(members), history, applied)
    const derived = history.filter(change => change.kind === 'possible_conflict' && change.derivedFrom !== null && members.has(change.targetId))
    const stillDisputed = new Set<number>()
    for (const [change, peers] of competing) {
      const replacement = change.replacementId && byId.get(change.replacementId)
      if (!replacement || replacement.entry.retention !== 'retained') continue
      for (const peerId of peers) {
        const peer = byId.get(peerId)
        if (!peer || peer.entry.retention !== 'retained') continue
        const previous = derived.filter(dispute => dispute.derivedFrom === change.id && dispute.targetId === peerId
          && dispute.replacementId === change.replacementId)
        const windows = overlapWindows(peer.windows, replacement.windows, { from: change.intentFrom, to: change.intentTo })
        const unresolved = previous.filter(dispute => dispute.status === 'resolved')
          .reduce((rest, resolution) => rest.flatMap(part => subtract(part, resolution)), windows)
        for (const part of unresolved) {
          const saved = previous.find(dispute => dispute.status === 'applied' && dispute.from === part.from && dispute.to === part.to)
          if (saved) { stillDisputed.add(saved.id); continue }
          store.recordChange({ kind: 'possible_conflict', targetId: peerId, replacementId: change.replacementId,
            sourceId: change.sourceId, sourceVersion: change.sourceVersion, spans: change.spans, ...part,
            intentFrom: part.from, intentTo: part.to, derivedFrom: change.id, effectiveAt: null, automatic: false, createdAt: now(), revision })
          ids.add(peerId)
          ids.add(replacement.entry.id)
        }
      }
    }
    for (const dispute of derived) if (dispute.status === 'applied' && !stillDisputed.has(dispute.id)) {
      store.setChangeStatus(dispute.id, 'withdrawn', revision)
      ids.add(dispute.targetId)
      if (dispute.replacementId) ids.add(dispute.replacementId)
    }
    for (const change of transitions) {
      const effect = projected.get(change.id)
      const needsConfirmation = unresolvedEnds.has(change.id)
      const interval = effect ?? { from: change.from, to: change.to }
      if (interval.from !== change.from || interval.to !== change.to || needsConfirmation !== change.needsConfirmation) {
        store.projectChange(change.id, interval, needsConfirmation, revision)
        ids.add(change.targetId)
        if (change.replacementId) ids.add(change.replacementId)
      }
    }
    for (const { entry, supports, windows, ended } of entries) {
      const state = !windows.length ? 'retracted' : ended ? 'superseded' : 'active'
      const text = supports[0]?.text ?? entry.text
      if (!ids.has(entry.id) && state === entry.state && text === entry.text && sameWindows(windows, entry.windows)) continue
      ids.add(entry.id)
      store.project(entry.id, { text, windows, state, invalidAt: state === 'active' ? null : entry.invalidAt ?? now(),
        invalidatedBy: state === 'active' ? null : 'user' }, revision)
    }
  }

  function oldValueMentions(source: MemorySource, target: MemoryEntry, replacement: MemoryFact['evidence'] | null,
    supplied: readonly MemorySpan[], offer: readonly MemorySpan[]) {
    // Source spans confirmed as old values are authoritative. Literal matching is limited to
    // uncovered tokens and cannot erase any independently grounded part of the replacement.
    if (supplied.length) return [...supplied]
    const protectedSpans = replacement && [replacement.subject, replacement.relation, replacement.object,
      ...replacement.qualifiers, ...replacement.temporal, ...replacement.conditions]
    const value = target.fact?.object ?? target.text
    const literal = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    // Latin identifiers have token boundaries. Adjacent Han characters often belong to the
    // surrounding sentence without spaces, so their structure is decided by the evidence spans.
    const identifier = /[\p{Script=Latin}\p{N}\p{M}_]/u
    const first = [...value][0] ?? ''
    const last = [...value].at(-1) ?? ''
    const original = source.text!
    const endsAtBoundary = (span: MemorySpan) => !(
      identifier.test(first) && identifier.test(original.slice(Math.max(0, span.start - 1), span.start))
      || identifier.test(last) && identifier.test(original.slice(span.end, span.end + 1)))
    const found = offer.flatMap(({ start, end }) => [...source.text!.slice(start, end).matchAll(literal)]
      .map(match => ({ start: start + match.index, end: start + match.index + match[0].length })))
    return found.filter(span => endsAtBoundary(span)
      && !protectedSpans?.some(part => part && part.start < span.end && span.start < part.end))
  }

  function recordChange(kind: MemoryChangeKind, target: MemoryEntry, replacement: MemoryEntry | null, source: MemorySource | null,
    spans: MemoryChange['spans'], interval: AffectedInterval, effectiveAt: number | null, revision: number, ids: Set<number>,
    replacementEvidence?: { source: MemorySource, span: { start: number, end: number }, parts: MemoryFact['evidence'] | null },
    intent = interval, intentWindows = interval.windows, deferProjection = false,
    oldValueEvidence?: { reviewed?: readonly MemorySpan[], offer: readonly MemorySpan[] }) {
    const oldValueSpans = source?.text && oldValueEvidence
      ? oldValueMentions(source, target, replacementEvidence?.parts ?? null, oldValueEvidence.reviewed ?? [], oldValueEvidence.offer) : []
    const id = store.recordChange({ kind, targetId: target.id, replacementId: replacement?.id ?? null,
      sourceId: source?.id ?? null, sourceVersion: source?.version ?? null, spans, oldValueSpans, ...interval, effectiveAt,
      intentFrom: intent.from, intentTo: intent.to, intentWindows,
      automatic: Boolean(source && automaticSource(source) && kind !== 'possible_conflict'),
      createdAt: now(), revision })
    ids.add(target.id)
    if (replacement) ids.add(replacement.id)
    if (replacement && replacementEvidence && kind !== 'possible_conflict') {
      const { source: support, span, parts } = replacementEvidence
      store.bindEvidenceChange(replacement.id, support.id, span.start, span.end, id, parts)
    }
    if (!deferProjection) reproject(ids, revision)
    return id
  }

  function affectedInterval(change: GroundedChange, target: MemoryEntry, fact: MemoryFact | null): AffectedInterval | null {
    if (change.kind === 'correct') {
      const requested = { from: change.affectedFrom === undefined ? target.validFrom : change.affectedFrom,
        to: change.affectedTo === undefined ? target.validTo : change.affectedTo }
      const overlaps = target.windows.flatMap(window => intersect(window, requested) ?? [])
      if (overlaps.length < 2) return overlaps[0] ?? null
      return { from: overlaps[0].from, to: overlaps[overlaps.length - 1].to, windows: overlaps }
    }
    if (change.kind === 'possible_conflict') {
      const interval = { from: change.affectedFrom ?? null, to: change.affectedTo ?? null }
      const common = fact && intersect(interval, fact)
      const overlap = common && intersect({ from: target.validFrom, to: target.validTo }, common)
      return overlap && target.windows.some(window => intersect(window, overlap)) ? overlap : null
    }
    const boundary = change.effectiveAt
    if (boundary === null) return null
    const window = target.windows.find(interval => covers(interval.from, interval.to, boundary - 1))
    return window ? intersect(window, { from: boundary, to: change.affectedTo ?? null }) : null
  }

  function conditionText(source: string, spans: readonly MemorySpan[]) {
    return [...new Set(spans.map(span => factIdentity(sourceText(source, [span]))))].sort()
  }

  function conditionsOf(target: MemoryEntry) {
    const conditions = new Set<string>()
    for (const edge of target.evidence) {
      const source = store.readSource(edge.sourceId)
      if (!source?.text || source.withdrawn || sourceBlocked(source)) continue
      for (const part of conditionText(source.text, edge.parts?.conditions ?? [])) conditions.add(part)
    }
    return [...conditions].sort()
  }

  function conditionGate(oldConditions: readonly string[], newConditions: readonly string[], target: MemoryEntry) {
    if (target.modality !== 'asserted' || target.conditional !== Boolean(oldConditions.length)) return 'unverified'
    if (newConditions.length === oldConditions.length && newConditions.every((condition, index) => condition === oldConditions[index])) return 'exact'
    return 'review'
  }

  function pendingWindows(source: MemorySource, proposal: MemoryProposal, target: MemoryEntry, fact: MemoryFact, offered: readonly MemorySpan[],
    relatedByReview = false, reviewedConditions?: 'equivalent' | 'overlap') {
    const proposed = proposal.change
    const conditions = conditionGate(conditionsOf(target), conditionText(source.text!, proposal.conditionSpans ?? []), target)
    if (!proposed || proposed.kind === 'end' || !target.fact || proposal.modality !== 'asserted'
      || (conditions !== 'exact' && !(conditions === 'review' && reviewedConditions)) || fact.uncertain || fact.polarity === 'uncertain'
      || fact.subject !== target.fact.subject || (!relatedByReview && !sameRelation(fact.relation, target.fact.relation))
      || (fact.polarity === target.fact.polarity && factIdentity(fact.object) === factIdentity(target.fact.object))) return []
    const change = groundedChange(source.text!, proposal, target, source.at, source.timezone, offered)
    const applicable = change && affectedInterval(change, target, fact)
    if (!applicable) return []
    return overlapWindows(target.windows, proposed.kind === 'correct' && !fact.dated ? [applicable] : [fact], applicable)
  }

  function scopeOfProposal(source: MemorySource, proposal: MemoryProposal, existing?: MemoryEntry) {
    const context = source.context?.kind === 'conversation' ? source.context
      : source.conversation ? { kind: 'conversation' as const, id: source.conversation } : undefined
    if (source.author === 'manual' && existing) return existing.scope
    if (source.author === 'answer' && existing) return existing.scope
    if (proposal.scope === 'user') return proposal.attribution === 'self' && source.scope.kind === 'user' ? source.scope : undefined
    if (proposal.scope === 'conversation') return context
    return [source.scope, source.context ?? undefined, source.project ?? undefined].find(granted => granted?.kind === proposal.scope)
  }

  function hasDurableIntentSpan(source: MemorySource, proposal: MemoryProposal) {
    if (source.rememberedHash) return true
    const intent = proposal.durableIntent
    if (!intent) return false
    const overlaps = (span: MemorySpan) => span.start < intent.end && intent.start < span.end
    if (proposal.fact) return !overlaps(proposal.fact.object)
    return proposal.spans.some(span => [source.text!.slice(span.start, Math.min(span.end, intent.start)),
      source.text!.slice(Math.max(span.start, intent.end), span.end)].some(part => /[\p{L}\p{N}]/u.test(part)))
  }

  function prepareDraft(source: MemorySource, proposal: MemoryProposal, spans: readonly MemorySpan[], target: MemoryEntry, existing?: MemoryEntry) {
    if (!modelEligible(target) || !retained(target) || !available(target) || target.id === existing?.id || source.author === 'manual'
      || (source.author === 'answer' && !hasDurableIntentSpan(source, proposal))) return null
    const scope = scopeOfProposal(source, proposal, existing)
    if (!scope || !sameScope(scope, target.scope) || (source.scope.kind !== 'user' && !sameScope(source.scope, scope))
      || (proposal.attribution === 'third_party' && !target.fact?.subject.startsWith('named:'))) return null
    const oldConditions = conditionsOf(target)
    const newConditions = conditionText(source.text!, proposal.conditionSpans ?? [])
    const fact = groundedFact(source.text!, proposal, source.at, source.timezone, spans)
    const event = groundedEventChange(source.text!, proposal, target, source.at, source.timezone, spans)
    const change = event ?? groundedChange(source.text!, proposal, target, source.at, source.timezone, spans)
    const affected = change && (event ? { from: target.validFrom, to: target.validTo, windows: target.windows } : affectedInterval(change, target, fact))
    if (!change || !affected || (!event && fact?.uncertain && change.kind !== 'correct')) return null
    const newWindow = fact ? { from: fact.from, to: fact.to, dated: fact.dated, uncertain: fact.uncertain } : null
    const changeWindow = { from: affected.from, to: affected.to, windows: affected.windows }
    const oldFact = target.fact && { subject: target.fact.subject, relation: target.fact.relation,
      object: target.fact.object, polarity: target.fact.polarity }
    const draftDetails = { target: { id: target.id, revision: target.revision }, oldScope: target.scope, oldConditions, newConditions,
      oldWindows: target.windows, oldModality: target.modality, oldFact, newWindow, changeWindow,
      event: event ? sourceText(source.text!, event.eventSpans) : null,
      mustConfirmAnswerIntent: source.author === 'answer' && !source.rememberedHash }
    const id = memoryHash(JSON.stringify([source.id, source.version, source.hash, proposal, target.id, target.revision, target.modality, draftDetails]))
    const conditions = conditionGate(oldConditions, newConditions, target)
    const compatibleTime = !event && compatibleTransitionTime(change, fact)
    return { draft: { id, ...draftDetails }, target, change, affected, conditions, compatibleTime }
  }

  function reviewApplies(prepared: NonNullable<ReturnType<typeof prepareDraft>>, review?: MemoryReview) {
    return review?.draftId === prepared.draft.id && review.verdict === 'confirmed' && prepared.compatibleTime
      && review.conditions !== 'disjoint' && review.conditions !== 'overlap' && (prepared.conditions === 'exact' || (prepared.conditions === 'review'
        && prepared.draft.oldConditions.length > 0 && prepared.draft.newConditions.length > 0 && review.conditions === 'equivalent'))
  }

  function qualify(source: MemorySource, proposal: MemoryProposal, allowed: readonly MemorySpan[], revision: () => number,
    ids: Set<number>, invalidated: Set<number>, prepared: ReturnType<typeof prepareDraft>, review?: MemoryReview, existing?: MemoryEntry) {
    const raw = source.text!
    const offered = proposalSpans(raw, proposal, allowed)
    if (!offered) return
    const original = sourceText(raw, offered)
    if (!original || looksSecret(original) || original.length > 2_000) return
    const candidateSpan = spanEnvelope(offered)
    const candidate = (reason: string, proposed: object = { ...proposal, spans: offered }) => {
      if (existing && source.author === 'manual') return
      if (proposal.change && !store.exists(proposal.change.target.id)) return
      store.candidate(source.id, candidateSpan.start, candidateSpan.end, proposed, reason)
      return 'candidate' as const
    }

    const fact = proposal.fact && !looksSecret(proposal.fact.predicate)
      ? groundedFact(raw, proposal, source.at, source.timezone, allowed) : null
    if (proposal.fact && !fact) return candidate('invalid-fact-evidence')
    const durable = hasDurableIntentSpan(source, proposal)
      && (source.author !== 'answer' || Boolean(source.rememberedHash) || review?.verdict === 'confirmed')
    const savedPlan = proposal.modality === 'planned' && durable
    if (proposal.attribution === 'uncertain' || (source.author === 'answer' && !durable)) return candidate('unverified-attribution')
    if (proposal.modality !== 'asserted' && !existing && !savedPlan) return candidate('unverified-modality')

    const scope = scopeOfProposal(source, proposal, existing)
    if (!scope || (source.scope.kind !== 'user' && !sameScope(source.scope, scope))) return candidate('unverified-scope')
    const spans = fact?.evidence.spans ?? offered
    const span = spanEnvelope(spans)
    const text = sourceText(raw, spans)
    if (looksSecret(text) || store.excluded(text, scope, existing?.authorizedRevision)) return
    const timing = fact ?? resolveMemoryTime(proposal.temporal, source.at, source.timezone)
    if (!existing && !savedPlan && ((timing.uncertain && !proposal.change) || fact?.polarity === 'uncertain')) return candidate('unverified-time-or-polarity')

    const details = {
      kind: existing?.kind ?? proposal.kind, scope, modality: proposal.modality,
      conditional: Boolean(proposal.conditionSpans?.length || timing.uncertain || fact?.polarity === 'uncertain'),
      keywords: [...new Set([...(existing?.keywords ?? []), ...proposal.keywords, ...(fact?.relation ? [fact.relation] : [])])]
        .filter(word => word.length <= 20 && !looksSecret(word) && text.includes(word)).slice(0, 6),
      source: existing?.source ?? 'agent' as const,
    }
    const proposed = proposal.change
    const bound = prepared && review?.draftId === prepared.draft.id ? prepared : null
    const applied = bound && reviewApplies(bound, review) ? bound : null
    if (proposed && !applied) {
      // A dependent new value cannot silently become active if its transition was not approved.
      const relationConfirmed = review?.verdict === 'uncertain' && review.sameRelation === true
      const reviewedConditions = (review?.verdict === 'confirmed' || review?.verdict === 'uncertain') && review.conditions !== 'disjoint'
        ? review.conditions : undefined
      const eventConfirmed = bound?.draft.event && review?.verdict === 'confirmed'
        && (bound.conditions === 'exact' || (bound.conditions === 'review' && reviewedConditions === 'equivalent'))
      if (eventConfirmed || (review?.verdict === 'uncertain' && review.conditions !== 'disjoint' && bound && fact
        && pendingWindows(source, proposal, bound.target, fact, offered, relationConfirmed, reviewedConditions).length)) {
        candidate('uncertain-change', { sourceVersion: source.version, scope, proposal: { ...proposal, spans: offered },
          sameRelation: relationConfirmed, conditions: reviewedConditions, event: Boolean(eventConfirmed) })
      } else candidate('unverified-change')
      if (!proposal.independent || !fact || timing.uncertain || spans.some(part => part.start < proposed.evidence.action.end
        && proposed.evidence.action.start < part.end)) return 'candidate'
    }
    if (!fact && !proposed && existing && source.author === 'manual' && proposal.modality === 'asserted'
      && !proposal.conditionSpans?.length && !proposal.temporal) return
    const inherited = existing && (!timing.dated || timing.uncertain) ? { from: existing.assertedFrom, to: existing.assertedTo } : undefined
    const interval = applied?.change.kind === 'correct' && (!fact?.dated || fact.uncertain) ? applied.affected
      : applied?.change.kind === 'supersede'
        ? { from: applied.change.effectiveAt, to: fact?.dated ? fact.to : applied.change.affectedTo ?? null }
        : proposal.modality === 'planned' ? { from: source.at, to: timing.to !== null && timing.to > source.at ? timing.to : null } : inherited ?? timing
    if (applied?.change.kind === 'correct' && fact?.uncertain) details.conditional = Boolean(proposal.conditionSpans?.length)
    const replacement = (fact && applied?.change.kind !== 'end') || (!proposed && !fact)
      ? put(source, details, span, revision, ids, { fact, existing, interval, spans,
        separate: Boolean(applied && applied.change.kind !== 'possible_conflict') })
      : null
    if (applied && applied.target.id !== replacement?.id) {
      const { change, target, affected } = applied
      const evidence = [change.evidence.action, change.evidence.target, ...(change.evidence.effective ? [change.evidence.effective] : []),
        ...change.temporalSpans.filter(part => part.start !== change.evidence.effective?.start || part.end !== change.evidence.effective.end)]
      const intent = change.kind === 'supersede' || change.kind === 'end'
        ? { from: change.effectiveAt, to: change.affectedTo ?? null } : affected
      recordChange(change.kind, target, replacement, source, evidence, affected, change.effectiveAt, revision(), ids,
        replacement ? { source, span, parts: fact?.evidence ?? null } : undefined, intent, intent.windows, true,
        { reviewed: change.evidence.oldValues, offer: offered })
      if (change.kind === 'end' && existing && source.outcome === 'explicit-pending') {
        store.remove(existing.id)
        ids.add(existing.id)
      }
      for (const id of ids) invalidated.add(id)
      return replacement ?? true
    }
    if (replacement && existing) invalidated.add(replacement.id)
    return replacement
  }

  function computeAdmission(id: string) {
    const job = runningComputations.get(id)
    return job?.ready() && (job.deadline === null || now() < job.deadline) ? job : null
  }
  const computeCurrent = (id: string) => Boolean(computeAdmission(id))

  function currentExtractionSource(source: MemorySource, job: Effect, contextSources: readonly string[], at: number, historical = false) {
    if (closed || sourceBlocked(source) || !effects.holds(job) || store.sourceExcluded(source.id)) return false
    const current = store.readSource(source.id)
    return Boolean(current?.text && current.text === source.text && !current.withdrawn && current.version === source.version && current.hash === source.hash
      && current.question === source.question
      && contextSources.every(id => sourceCurrent(id, at, historical)))
  }

  function currentExtraction(source: MemorySource, job: Effect, snapshotRevision: number, contextSources: readonly string[]) {
    return !mutation && store.revision() === snapshotRevision && currentExtractionSource(source, job, contextSources, now())
  }

  async function calculate(source: MemorySource, job: Effect, snapshotRevision: number, model: Route,
    stage: MemoryCompute['stage'], input: object, contextSources: readonly string[], shown: readonly MemoryEntry[],
    system = stage === 'extract' ? EXTRACT_SYSTEM : REVIEW_SYSTEM, stillCurrent = () => true) {
    const id = randomUUID()
    const at = now()
    const deadline = dispatchDeadline(shown, [source.id, ...contextSources], at)
    const historical = stage === 'note' || stage === 'dream'
    runningComputations.set(id, {
      ready: () => stillCurrent() && !mutation && store.revision() === snapshotRevision
        && currentExtractionSource(source, job, contextSources, now(), historical),
      current: () => stillCurrent() && currentExtractionSource(source, job, contextSources, at, historical) && shown.every(entry => {
        const current = store.get(entry.id)
        return current?.revision === entry.revision && retained(current) && available(current)
      }),
      deadline,
    })
    try {
      const result = compute({ id, sourceId: source.id, generation: job.generation, stage, ...model, system, input: JSON.stringify(input) })
      if (!result) return
      return JSON.parse((await result).trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')) as unknown
    } finally {
      runningComputations.delete(id)
    }
  }

  const notes = dailyNotes ? createMemoryNoteJobs({
    store, effects, now, openNotes: resources.openNotes, settings: typeof dailyNotes === 'object' ? dailyNotes : undefined,
    readable: id => sourceCurrent(id, now(), true),
    eligible: source => !closed && !mutation && !sourceBlocked(source) && canCommit(source),
    assistantContextCurrent: context => !context.turnOnly && context.epoch === store.epoch()
      && dependenciesCurrent(context.dependencies) && context.sources.every(id => sourceCurrent(id)),
    allowsText: (text, source) => !looksSecret(text) && !excludedSourceText(text)
      && !excludedSourceText(text, source.context ?? source.scope)
      && (!source.project || !excludedSourceText(text, source.project)),
    async calculate(job, source, stage, system, input, sources, current) {
      const model = route()
      if (model) return calculate(source, job, store.revision(), model, stage, input, sources, [], system, current)
    },
    queueExtraction(id, note, focuses, supporting) {
      if (store.readSource(id)?.outcome !== 'note-ready' || effects.get(EXTRACT, id)) return false
      store.outcome(id, 'pending')
      effects.queue(EXTRACT, id, { noteKey: note.key, noteRevision: note.revision, focuses, supporting })
      return true
    },
    extractionPending: id => Boolean(effects.get(EXTRACT, id)),
  }) : null

  effects.runs(EXTRACT, async jobs => {
    const outcomes = new Map<string, Outcome>()
    for (const job of jobs) {
      if (closed) break
      const source = store.readSource(job.key)
      const structure = structureJob.safeParse(job.payload).data
      const fromNote = dreamExtraction.safeParse(job.payload).data
      const existing = structure && store.get(structure.id)
      if (!source?.text || source.withdrawn || store.sourceExcluded(job.key)
        || (structure ? !existing || existing.fact || !retained(existing) || !available(existing) : source.outcome !== 'pending')) {
        outcomes.set(job.key, 'done')
        continue
      }
      const noteCurrent = () => !fromNote || Boolean(notes &&
        [{ key: fromNote.noteKey, revision: fromNote.noteRevision }, ...fromNote.supporting ?? []].every(ref =>
          notes.read(ref.key)?.revision === ref.revision && notes.sources(ref.key).every(id => sourceCurrent(id, now(), true))))
      if (!noteCurrent()) {
        store.tx(() => {
          if (!effects.holds(job)) return
          store.outcome(source.id, 'note-ready')
          effects.finishGeneration(job)
        })
        continue
      }
      if (looksSecret(source.text) || (!structure && (excludedSourceText(source.text, source.context ?? source.scope) || source.project && excludedSourceText(source.text, source.project)))) {
        store.tx(() => {
          if (!effects.holds(job)) return
          store.outcome(source.id, 'rejected')
          store.discardUnused(source.id)
          effects.finishGeneration(job)
        })
        continue
      }
      if (mutation || sourceBlocked(source) || !canCommit(source)) continue
      const model = route()
      if (!model) continue
      const snapshotRevision = store.revision()
      try {
        const spans = structure ? [{ start: structure.start, end: structure.end }] : sourceSpans(source.text)
        const nearby = store.priorSources(source).filter(row => {
          const prior = store.readSource(row.id)
          return row.text && prior && sourceCanRead(prior.scope, source)
            && (!prior.context || sourceCanRead(prior.context, source)) && (!prior.project || sourceCanRead(prior.project, source)) && !looksSecret(row.text)
            && sourceCurrent(row.id) && !excludedSourceText(row.text, source.context ?? source.scope)
        })
        const relatedEntries = store.list().filter(entry => entry.id !== existing?.id && modelEligible(entry) && retained(entry) && available(entry)
          && sourceCanRead(entry.scope, source)).map(entry => {
          const text = modelText(entry)
          const safe = [text, entry.fact?.subject, entry.fact?.predicate, entry.fact?.relation, entry.fact?.object]
            .every(part => !part || !looksSecret(part))
          return { entry, text, safe, keywords: entry.keywords.filter(word => text.includes(word)), updatedAt: entry.updatedAt }
        }).filter(({ safe }) => safe)
        const relevant = relatedEntries.map(({ entry }) => entry)
        const rendered = new Map(relatedEntries.map(({ entry, text }) => [entry.id, text]))
        const matched = recallCandidates(relatedEntries, source.text, 20).found.map(({ entry }) => entry)
        const mentionedIds = new Set([...source.text.matchAll(/[#＃](\d+)\b/gu)].map(match => Number(match[1])))
        const ranked = [...new Map([...relevant.filter(entry => mentionedIds.has(entry.id)), ...matched, ...relevant]
          .map(entry => [entry.id, entry])).values()]
        const contextSources = nearby.map(({ id }) => id)
        const makeSnapshot = (entries: readonly MemoryEntry[]) => {
          const shown: MemoryEntry[] = []
          const related = []
          const dependencies = new Set(contextSources)
          let remaining = 24_000
          for (const entry of entries) {
            const { id, revision, fact, scope, validFrom, validTo, conditional, windows } = entry
            const snapshot = { id, revision, text: rendered.get(id), subject: fact?.subject, predicate: fact?.predicate, relation: fact?.relation,
              object: fact?.object, polarity: fact?.polarity, scope: scope.kind, validFrom, validTo, conditional, windows }
            const size = JSON.stringify(snapshot).length
            if (size > remaining || shown.length >= 48) break
            remaining -= size
            shown.push(entry)
            related.push(snapshot)
            for (const edge of entry.evidence) if (sourceCurrent(edge.sourceId)) dependencies.add(edge.sourceId)
          }
          return { shown, related, dependencies: [...dependencies], complete: shown.length === entries.length }
        }
        const extraction = makeSnapshot(ranked)
        const question = source.question && !looksSecret(source.question)
          && !excludedSourceText(source.question, source.context ?? source.scope) ? source.question : null
        const input = { sourceId: source.id, sourceVersion: source.version, author: source.author,
          user: source.text, spans, ...(structure ? { explicitlySaved: true } : {}), ...(question ? { question } : {}),
          ...(fromNote ? { noteFocuses: fromNote.focuses } : {}),
          nearby: nearby.map(({ id, text }) => ({ id, text })), related: extraction.related, relatedComplete: extraction.complete,
          assertedAt: source.at, timezone: source.timezone, assertedLocalDate: todayAt(source.at, source.timezone) }
        const system = fromNote ? EXTRACT_SYSTEM + '\n本轮由日记整理选出 noteFocuses。只提出这些条目中由 user 原文支持的长期记忆。' : EXTRACT_SYSTEM
        const result = await calculate(source, job, snapshotRevision, model, 'extract', input, extraction.dependencies, extraction.shown, system, noteCurrent)
        if (result === undefined) continue
        const parsed = memoryProposals.parse(result)
        if (!noteCurrent() || !currentExtraction(source, job, snapshotRevision, extraction.dependencies)) { outcomes.set(job.key, 'retry'); continue }
        const selected = parsed.proposals.flatMap((proposal, index) => {
          const evidence = proposalSpans(source.text!, proposal, spans)
          return evidence ? [{ index, proposal, evidence }] : []
        })
        if (structure && source.author === 'manual') selected.splice(1)
        const changes = selected.flatMap(({ proposal, index }) => {
          const target = extraction.shown.find(entry => entry.id === proposal.change?.target.id && entry.revision === proposal.change.target.revision)
          const prepared = target && prepareDraft(source, proposal, spans, target, existing || undefined)
          return prepared ? [{ index, proposal, prepared }] : []
        })
        const drafts = new Map(changes.map(({ index, prepared }) => [index, prepared]))
        const answerDrafts = source.author === 'answer' && !source.rememberedHash
          ? selected.filter(({ index, proposal }) => !proposal.change && !drafts.has(index) && hasDurableIntentSpan(source, proposal)).map(({ index, proposal }) => ({
            index, proposal, draft: { purpose: 'answer-intent',
              id: memoryHash(JSON.stringify([source.id, source.version, source.hash, source.requestId, source.questionId, proposal])) },
          })) : []
        const reviewDrafts = [...changes.map(({ index, proposal, prepared: { draft } }) => ({ index, proposal, draft })), ...answerDrafts]
        const draftIds = new Map(reviewDrafts.map(({ index, draft }) => [index, draft.id]))
        const reviews = new Map<number, MemoryReview>()
        let dependencies = extraction.dependencies
        if (reviewDrafts.length) {
          const plausible = new Map<number, MemoryEntry>()
          for (const { proposal, prepared: { target } } of changes) {
            const change = proposal.change!
            const fact = groundedFact(source.text, proposal, source.at, source.timezone, spans)
            const targetWords = sourceText(source.text, [change.evidence.target])
            const scoped = relevant.filter(entry => sameScope(entry.scope, target.scope))
            const search = [targetWords, target.fact?.relation, fact?.relation].filter((word): word is string => Boolean(word))
            const scopedText = relatedEntries.filter(({ entry }) => sameScope(entry.scope, target.scope))
            const textualMatches = search.flatMap(query => recallCandidates(scopedText, query, scopedText.length).found.map(({ entry }) => entry))
            const possiblePeers = scoped.filter(({ fact: peer }) => peer && [target.fact, fact].some(claim => claim && peer.subject === claim.subject
              && (peer.predicate === claim.predicate || sameRelation(peer.relation, claim.relation)
                || factIdentity(peer.object) === factIdentity(claim.object))))
            for (const entry of [target, ...possiblePeers, ...textualMatches]) plausible.set(entry.id, entry)
          }
          const reviewInput = makeSnapshot([...plausible.values()])
          dependencies = [...new Set([...dependencies, ...reviewInput.dependencies])]
          if (reviewInput.complete) {
            const result = await calculate(source, job, snapshotRevision, model, 'review',
              { ...input, related: reviewInput.related, relatedComplete: true,
                proposals: reviewDrafts }, dependencies, reviewInput.shown, REVIEW_SYSTEM, noteCurrent)
            if (result === undefined) continue
            const { reviews: reported } = memoryReviews.parse(result)
            for (const review of reported) {
              if (reviews.has(review.index) || draftIds.get(review.index) !== review.draftId) throw new Error('memory review draft mismatch')
              reviews.set(review.index, review)
            }
            if (reviews.size !== reviewDrafts.length) throw new Error('memory review did not complete every draft')
            const confirmed = changes.filter(({ index, prepared }) => reviewApplies(prepared, reviews.get(index)))
            for (const { index, prepared } of confirmed) {
              const competes = confirmed.some(({ index: otherIndex, prepared: other }) => {
                if (otherIndex === index) return false
                if (other.target.id === prepared.target.id) {
                  return overlapWindows(other.affected.windows ?? [other.affected], prepared.affected.windows ?? [prepared.affected],
                    { from: null, to: null }).length > 0
                }
                const first = prepared.change.evidence.action
                const second = other.change.evidence.action
                return first.start < second.end && second.start < first.end
              })
              if (competes) reviews.delete(index)
            }
          }
        }
        if (!noteCurrent() || !currentExtraction(source, job, snapshotRevision, dependencies)) { outcomes.set(job.key, 'retry'); continue }
        if (!canCommit(source)) continue
        const changedIds = new Set<number>()
        const invalidated = new Set<number>()
        const entries = store.tx(() => {
          if (!noteCurrent() || !currentExtraction(source, job, snapshotRevision, dependencies)) { outcomes.set(job.key, 'retry'); return [] }
          const before = store.revision()
          let revision: number | undefined
          // All plans were checked against the same pre-write revision. Earlier
          // plans in this batch must not change the target used by later plans.
          const proposals = selected.map(({ proposal, index }, position) => qualify(source, proposal, spans, () => revision ??= store.nextRevision(),
            changedIds, invalidated, drafts.get(index) ?? null, reviews.get(index), position === 0 ? existing || undefined : undefined))
          if (revision !== undefined && invalidated.size) {
            reproject(changedIds, revision)
            for (const id of changedIds) invalidated.add(id)
          }
          const accepted = proposals.some(item => item && item !== 'candidate')
          const explicit = source.outcome === 'explicit-pending'
          if (existing && explicit && !changedIds.has(existing.id)) store.remove(existing.id)
          if (!structure || explicit || accepted) store.outcome(source.id, accepted ? (explicit ? 'explicit-accepted' : 'accepted')
            : proposals.includes('candidate') ? 'candidate' : 'skipped')
          if (!retainSessionSource(source.id)) store.compactSource(source.id)
          scheduleExpiry()
          validateDispatch()
          effects.finishGeneration(job)
          return proposals.filter((item): item is MemoryEntry => Boolean(item && typeof item === 'object' && item.revision > before))
        })
        if (changedIds.size) {
          const current = new Set(valid(source.context ?? source.scope).map(entry => entry.id))
          const learned = !structure || source.outcome === 'explicit-pending'
            ? entries.filter(entry => current.has(entry.id)).map(entry => entry.text) : []
          publish(store.revision(), [...changedIds], learned, [...invalidated])
        }
      } catch (error) {
        if (!closed && !(error instanceof MemoryDispatchConflict)) outcomes.set(job.key, 'retry')
      }
    }
    if (!closed && jobs.some(job => dreamExtraction.safeParse(job.payload).success &&
      (!effects.holds(job) || outcomes.get(job.key) === 'done'))) void effects.wake()
    return outcomes
  })

  function mutate<T>(work: () => T, stopSessions = false): Promise<T> {
    if (mutation) throw domainError('change.pending')
    if (dailySemantic) resetSemanticJobs()
    const running = Promise.resolve().then(() => stopSessions ? quiesce() : undefined).then(() => {
      if (closed) throw new Error('memory runtime closed')
      return work()
    })
    mutation = running
    return running.finally(() => {
      if (mutation === running) mutation = null
      if (!closed) void effects.wake()
    })
  }

  function entryAt(id: number, revision: number) {
    const entry = store.get(id)
    if (!entry) throw domainError('not.found')
    if (entry.revision !== revision) throw domainError('revision.conflict')
    return entry
  }

  function command<T>(key: string, kind: string, payload: unknown, work: () => { result: number | null, value: T }, previous: (result: number | null) => T) {
    operationId.parse(key)
    const fingerprint = memoryHash(JSON.stringify(payload))
    return store.tx(() => {
      const existing = store.command(key)
      if (existing) {
        if (existing.kind !== kind || existing.payload !== fingerprint) throw domainError('operation.conflict')
        return previous(existing.result)
      }
      const { result, value } = work()
      validateDispatch()
      store.recordCommand(key, kind, fingerprint, result)
      return value
    })
  }
  const recalledResult = (id: number | null) => id ? store.get(id) : null

  function savedText(source: MemorySource, span: { start: number, end: number }, scope: MemoryScope, kind: MemoryEntry['kind'],
    author: MemoryEntry['source'], keywords: string[], revision: () => number, ids: Set<number>, options: Parameters<typeof put>[5] = {}) {
    const text = source.text!.slice(span.start, span.end)
    const entry = put(source, { kind, scope, source: author, modality: source.author === 'manual' ? 'asserted' : 'reported', conditional: source.author !== 'manual',
      keywords: keywords.filter(word => text.includes(word) && !looksSecret(word)),
    }, span, revision, ids, options)
    store.authorize(entry.id, entry.revision)
    store.outcome(source.id, 'accepted')
    queueStructure(source, entry, span.start, span.end)
    return store.get(entry.id)!
  }

  function stopUsing(entry: MemoryEntry, revision: number, mode: 'forget' | 'delete', operation: string) {
    store.exclude(entry.text, entry.scope)
    const affected = new Set<number>([entry.id])
    const removals = new Map<string, MemorySpan[]>()
    const discard = new Map<number, ReturnType<typeof captureRemovedChange>>()
    const redact = (sourceId: string, spans: readonly MemorySpan[]) => removals.set(sourceId, [...removals.get(sourceId) ?? [], ...spans])
    const disableChange = (change: MemoryChange) => {
      if (change.status !== 'applied' || discard.has(change.id)) return
      discard.set(change.id, captureRemovedChange(change))
      store.setChangeStatus(change.id, 'withdrawn', revision)
      affected.add(change.targetId)
      if (change.replacementId !== null) affected.add(change.replacementId)
    }
    for (const edge of store.storedEvidence(entry.id)) {
      const source = store.readSource(edge.sourceId)
      if (!source?.text) continue
      const fragment = sourceText(source.text, edge.spans)
      store.exclude(fragment, entry.scope)
      store.excludeSource(edge.sourceId)
      store.clearCandidates(edge.sourceId)
      effects.cancel(EXTRACT, edge.sourceId)
      notes?.withdraw(edge.sourceId)
      if (mode === 'delete') redact(source.id, edge.spans)
    }
    for (const change of store.changesReferencing(entry.id)) {
      if (change.targetId === entry.id && change.replacementId) affected.add(change.replacementId)
      if (change.targetId !== entry.id) affected.add(change.targetId)
      if (mode !== 'delete') continue
      if (change.kind === 'possible_conflict' || change.kind === 'pending_relation' || change.replacementId === entry.id) disableChange(change)
      if (change.targetId !== entry.id || !change.sourceId) continue
      const source = store.readSource(change.sourceId)
      if (!source?.text) continue
      if (change.oldValueSpans.length) redact(source.id, change.oldValueSpans)
    }
    if (mode === 'delete') {
      const compact = new Set<string>()
      for (const candidate of store.candidatesReferencing(entry.id)) {
        store.removeCandidate(candidate)
        compact.add(candidate.sourceId)
        const source = store.readSource(candidate.sourceId)
        if (!source?.text || !sourceCanRead(entry.scope, source)) continue
        const record = objectOf(JSON.parse(candidate.proposal))
        const parsed = memoryProposals.shape.proposals.element.safeParse(record?.proposal ?? record)
        if (!parsed.success || !parsed.data.change) continue
        const scope = scopeOfProposal(source, parsed.data)
        if (!scope || !sameScope(entry.scope, scope)) continue
        const offered = proposalSpans(source.text, parsed.data, sourceSpans(source.text))
        if (!offered || !validChangeEvidence(source.text, parsed.data.change, offered)) continue
        const replacement = groundedFact(source.text, parsed.data, source.at, source.timezone, offered)
        // Candidate text has not been confirmed by the user. Only redact a literal value from validated spans.
        // When there are no matching spans, compaction still drops text retained only by the candidate.
        const spans = oldValueMentions(source, entry, replacement?.evidence ?? null, [], offered)
        if (spans.length) redact(candidate.sourceId, spans)
      }
      const redactedPeers = new Set<number>()
      for (const [id, spans] of removals) {
        const source = store.readSource(id)
        store.excludeSource(id)
        store.clearCandidates(id)
        effects.cancel(EXTRACT, id)
        notes?.withdraw(id)
        if (!source?.text || !spans.length) continue
        const cuts = spans.map(span => ({ from: span.start, to: span.end }))
        const overlapsCut = (span: MemorySpan) => cuts.some(cut => intersect(cut, { from: span.start, to: span.end }))
        for (const memoryId of store.memoriesFrom(id)) {
          if (memoryId === entry.id) continue
          for (const edge of store.storedEvidence(memoryId)) {
            if (edge.sourceId !== id || !edge.spans.some(overlapsCut)) continue
            const parts = edge.parts
            const assertion = parts && [parts.subject, parts.relation, parts.object, ...parts.qualifiers, ...parts.conditions, ...parts.temporal]
            if (assertion && assertion.every(part => !part || !overlapsCut(part))) {
              const surviving = edge.spans.flatMap(span => cuts.reduce((rest, cut) => rest.flatMap(piece => subtract(piece, cut)),
                [{ from: span.start, to: span.end }] as MemoryInterval[])).map(piece => ({ start: piece.from!, end: piece.to! }))
              store.updateEvidenceSpans(memoryId, edge, surviving)
            } else store.removeEvidence(memoryId, id, edge.start, edge.end)
            affected.add(memoryId)
            redactedPeers.add(memoryId)
          }
        }
        for (const change of store.changesFrom(id)) {
          if (!change.spans.some(overlapsCut)) continue
          if (change.targetId === entry.id && change.replacementId !== entry.id && change.kind !== 'possible_conflict') {
            store.touchChange(change.id, revision)
          } else disableChange(change)
        }
        const redacted = spans.reduce((text, span) => text.slice(0, span.start) + ' '.repeat(span.end - span.start) + text.slice(span.end), source.text)
        store.redactSource(id, redacted)
      }
      store.remove(entry.id)
      // A withdrawn edge may remain for history and cannot justify retaining the peer's old projection.
      for (const { entry: peer, supports } of timelineRows(redactedPeers)) if (!supports.length) store.remove(peer.id)
      for (const id of affected) if (store.get(id) && store.storedEvidence(id).length === 0) store.remove(id)
      for (const id of new Set([...compact, ...removals.keys()])) if (!retainSessionSource(id)) store.compactSource(id)
      scheduleExpiry()
    } else store.forgetEntry(entry.id, revision)
    reproject(affected, revision)
    for (const change of discard.values()) retainIndependentDisputes(change, revision, affected)
    if (mode === 'delete') for (const id of affected) {
      const surviving = store.get(id)
      if (surviving) store.setKeywords(id, surviving.keywords.filter(word => surviving.text.includes(word)))
    }
    if (mode === 'delete') cleanup.queue(operation, entry.id, [...affected], revision,
      [...removals].map(([sourceId, spans]) => ({ sourceId, spans })), store.clearSourceQuestions())
    return [...affected]
  }

  function addMemory(text: string, kind = 'fact', key: string = randomUUID()) {
    const value = clean(text)
    const kindValue = memoryKind.parse(kind)
    if (mutation) throw domainError('change.pending')
    const before = store.revision()
    const saved = command(key, 'add', [value, kind], () => {
      const source = createSource(value, { conversation: null, session: null }, key, 'manual', undefined, true)
      const entry = savedText(source, { start: 0, end: value.length }, USER, kindValue, 'user', [], store.nextRevision, new Set())
      return { result: entry.id, value: entry }
    }, recalledResult)
    if (saved && store.revision() !== before) publish(store.revision(), [saved.id])
    void effects.wake()
    return saved
  }

  function editMemory(id: number, text: string, revision: number, key: string = randomUUID()) {
    const value = clean(text)
    return mutate(() => {
      const before = store.revision()
      const ids = new Set<number>()
      const saved = command(key, `edit:${id}`, [revision, value], () => {
        const entry = entryAt(id, revision)
        if (!retained(entry)) throw domainError('not.found')
        if (value === entry.text) return { result: id, value: entry }
        if (store.excluded(value, entry.scope)) throw domainError('restore.explicit')
        const source = createSource(value, { conversation: null, session: null, scope: entry.scope }, key, 'manual')
        const next = store.nextRevision()
        const affected = entry.windows
        const interval = { from: entry.validFrom, to: entry.validTo }
        const span = { start: 0, end: value.length }
        const replacement = savedText(source, span, entry.scope, entry.kind, 'user', [], () => next, ids,
          { interval, separate: true })
        recordChange('correct', entry, replacement, source, [span], interval, null, next, ids, { source, span, parts: null }, interval, affected)
        return { result: replacement.id, value: store.get(replacement.id) }
      }, recalledResult)
      if (saved && before !== store.revision()) publish(store.revision(), [...ids], undefined, [id])
      return saved
    })
  }

  function forget(id: number, revision: number, mode: 'forget' | 'delete', key: string = randomUUID()) {
    return mutate(() => {
      const before = store.revision()
      let affected: number[] = []
      const result = command(key, `${mode}:${id}`, revision, () => {
        const entry = entryAt(id, revision)
        const next = store.nextRevision()
        affected = stopUsing(entry, next, mode, key)
        return { result: id, value: true }
      }, previous => previous === id)
      if (before !== store.revision()) {
        if (mode === 'delete') {
          resetSemanticJobs()
          maintenance?.pause()
          profiles?.resetLive()
        }
        publish(store.revision(), affected, undefined, affected)
      }
      if (mode === 'delete' && result) cleanup.attempt(key)
      return result
    })
  }

  function resolveConflictPair(first: ConflictSide, second: ConflictSide, resolution: ConflictResolution, key: string = randomUUID(), changeId?: number,
    selected?: MemoryInterval) {
    if (first.id === second.id) return Promise.reject(domainError('revision.conflict'))
    return mutate(() => {
      const before = store.revision()
      const ids = new Set<number>([first.id, second.id])
      const result = command(key, 'resolve-conflict', [first, second, resolution, changeId, selected], () => {
        const a = entryAt(first.id, first.revision)
        const b = entryAt(second.id, second.revision)
        const conflict = disputeBetween(a, b, changeId)
        if (!conflict) throw domainError('revision.conflict')
        const interval = selected ? conflict.windows.find(window => window.from === selected.from && window.to === selected.to)
          : conflict.windows.length === 1 ? conflict.windows[0] : null
        if (!interval) throw domainError('revision.conflict')
        const next = store.nextRevision()
        const remaining = subtract(conflict, interval)
        store.reviseDispute(conflict.id, interval, next)
        store.setChangeStatus(conflict.id, 'resolved', next)
        for (const rest of remaining) {
          const { id: _id, status: _status, windows: _windows, ...original } = conflict
          store.recordChange({ ...original, ...rest, intentFrom: rest.from, intentTo: rest.to, revision: next })
        }
        if (resolution.kind === 'keep-first') recordChange('correct', b, a, null, [], interval, null, next, ids)
        else if (resolution.kind === 'discard-both' || resolution.kind === 'replace') {
          let replacement: MemoryEntry | null = null
          let source: MemorySource | null = null
          if (resolution.kind === 'replace') {
            const value = clean(resolution.text)
            source = createSource(value, { conversation: null, session: null, scope: a.scope }, key, 'manual', undefined, true)
            replacement = savedText(source, { start: 0, end: value.length }, a.scope, a.kind, 'user', [], () => next, ids, { interval, separate: true })
          }
          const spans = source?.text ? [{ start: 0, end: source.text.length }] : []
          recordChange('correct', a, replacement, source, spans, interval, null, next, ids)
          recordChange('correct', b, replacement, source, spans, interval, null, next, ids)
        }
        reproject(ids, next)
        return { result: conflict.id, value: true }
      }, prior => prior !== null)
      if (before !== store.revision()) publish(store.revision(), [...ids], undefined, [...ids])
      return result
    })
  }

  function resolveConflict(id: number, revision: number, key: string = randomUUID()) {
    return Promise.resolve().then(() => {
      const selected = entryAt(id, revision)
      const other = selected.links.flatMap(link => {
        const entry = link.kind === 'conflict' && store.get(link.id)
        return entry && disputeBetween(selected, entry, link.changeId) ? [{ entry, changeId: link.changeId }] : []
      })
      if (other.length !== 1) throw domainError('revision.conflict')
      return resolveConflictPair({ id, revision }, { id: other[0].entry.id, revision: other[0].entry.revision }, { kind: 'keep-first' }, key, other[0].changeId)
        .then(() => store.get(id))
    })
  }

  function independentPeers(change: MemoryChange, replacement = change.replacementId === null ? null : store.get(change.replacementId)) {
    const fact = replacement?.fact
    if (!replacement || !fact) return []
    const target = store.get(change.targetId)
    // The reviewed replacement already links the old and new wording of this relation. A predicate
    // can locate another possible wording, but only a known relation and conditions can classify it.
    const relations = [fact.relation, target?.fact?.relation].filter(relation => relation !== undefined)
    const conditions = conditionsOf(replacement)
    return store.list().flatMap(entry => {
      const peer = entry.fact
      if (entry.id === change.targetId || entry.id === replacement.id || !peer || !retained(entry) || !available(entry)
        || !sameScope(replacement.scope, entry.scope) || peer.subject !== fact.subject || peer.polarity !== fact.polarity
        || factIdentity(peer.object) !== factIdentity(fact.object) || !independentWindows(entry).length) return []
      const same = relations.some(relation => sameRelation(peer.relation, relation))
      if (!same && peer.predicate !== fact.predicate) return []
      const peerConditions = conditionsOf(entry)
      const verified = same && replacement.conditional === entry.conditional && conditions.length === peerConditions.length
        && conditions.every((condition, index) => condition === peerConditions[index])
      return [{ entry, verified }]
    })
  }

  function undoRefs(change: MemoryChange | null): ConflictSide[] {
    if (!change) return []
    const seeds = [change.targetId, ...(change.replacementId ? [change.replacementId] : []), ...independentPeers(change).map(({ entry }) => entry.id)]
    return [...connected(seeds, store.listChanges())].sort((a, b) => a - b).flatMap(id => {
      const entry = store.get(id)
      return entry ? [{ id, revision: entry.revision }] : []
    })
  }

  function captureRemovedChange(change: MemoryChange) {
    const replacement = change.replacementId === null ? null : store.get(change.replacementId)
    return { change, replacement, prior: store.get(change.targetId)?.windows ?? [] }
  }

  function retainIndependentDisputes({ change, replacement, prior }: ReturnType<typeof captureRemovedChange>, revision: number, ids: Set<number>) {
    if (change.kind === 'possible_conflict' || change.kind === 'pending_relation') return
    const restored = store.get(change.targetId)
    if (!restored?.fact || !replacement?.fact || !retained(restored) || !available(restored)) return
    const restoredWindows = prior.reduce((windows, previous) => windows.flatMap(window => subtract(window, previous)), restored.windows)
    const peers = independentPeers(change, replacement)
    const surviving = store.get(replacement.id)
    if (surviving && retained(surviving) && available(surviving)) peers.push({ entry: surviving, verified: true })
    for (const { entry: peer, verified } of peers) {
      const interval = { from: change.intentFrom, to: change.intentTo }
      const existing = store.changesFor(restored.id).filter(edge =>
        (edge.targetId === restored.id && edge.replacementId === peer.id)
        && (edge.kind === 'possible_conflict' || edge.kind === 'pending_relation'))
      const overlaps = overlapWindows(restoredWindows, independentWindows(peer), interval)
      const remaining = existing.reduce((rest, window) => rest.flatMap(part => subtract(part, window)), overlaps)
      for (const affected of remaining) {
        if (verified) recordChange('possible_conflict', restored, peer, null, [], affected, null, revision, ids)
        else {
          store.recordChange({ kind: 'pending_relation', targetId: restored.id, replacementId: peer.id,
            sourceId: null, sourceVersion: null, spans: [], ...affected, effectiveAt: null, automatic: false,
            intentFrom: affected.from, intentTo: affected.to, derivedFrom: change.id, createdAt: now(), revision })
          ids.add(restored.id)
          ids.add(peer.id)
          store.touch(restored.id, revision)
          store.touch(peer.id, revision)
        }
      }
    }
  }

  function undoChange(id: number, revision: number, key: string = randomUUID(), expectedRevisions: readonly ConflictSide[]): Promise<UndoResult> {
    return mutate(() => {
      const before = store.revision()
      const ids = new Set<number>()
      const expected = expectedRevisions.slice().sort((a, b) => a.id - b.id)
      const result = command<UndoResult>(key, `undo:${id}`, [revision, expected], () => {
        const change = store.getChange(id)
        const current = change ? undoRefs(change) : []
        const target = change && store.get(change.targetId)
        if (!change || change.revision !== revision || !change.automatic || change.status !== 'applied' || change.needsConfirmation || !target
          || target.retention !== 'retained' || !available(target) || expected.length !== current.length
          || expected.some((entry, index) => entry.id !== current[index].id || entry.revision !== current[index].revision)) {
          return { result: null, value: { status: 'conflict', current } }
        }
        const removed = captureRemovedChange(change)
        const { replacement } = removed
        ids.add(target.id)
        if (replacement) ids.add(replacement.id)
        const history = store.listChanges()
        const members = connected(ids, history)
        const applied = store.appliedChanges().filter(link => members.has(link.targetId))
        const rows = timelineRows(members)
        const beforeUndo = projectTimeline(rows, history, applied)
        const afterUndo = projectTimeline(rows, history, applied.filter(link => link.id !== change.id))
        const original = beforeUndo.byId.get(target.id)?.windows ?? []
        const restored = (afterUndo.byId.get(target.id)?.windows ?? []).flatMap(window =>
          original.reduce((parts, prior) => parts.flatMap(part => subtract(part, prior)), [window]))
        const hasAmbiguousPeer = independentPeers(change, replacement).some(({ entry, verified }) => !verified
          && overlapWindows(restored, independentWindows(entry, afterUndo.byId.get(entry.id)?.windows), { from: change.intentFrom, to: change.intentTo }).length > 0)
        if (hasAmbiguousPeer || [...afterUndo.unresolvedEnds].some(link => !beforeUndo.unresolvedEnds.has(link))) {
          return { result: null, value: { status: 'conflict', current } }
        }
        const next = store.nextRevision()
        store.setChangeStatus(id, 'undone', next)
        reproject(ids, next)
        // An independent assertion can keep the new value alive. Keep both facts
        // when undo removes the evidence that previously settled their order.
        retainIndependentDisputes(removed, next, ids)
        return { result: id, value: { status: 'applied' } }
      }, prior => prior === id ? { status: 'applied' } : { status: 'conflict', current: undoRefs(store.getChange(id)) })
      if (before !== store.revision()) publish(store.revision(), [...ids], undefined, [...ids])
      return result
    })
  }

  function listChanges() {
    return store.listChanges().flatMap(change => {
      if (!change.automatic || change.kind === 'possible_conflict' || change.kind === 'pending_relation' || change.status === 'resolved') return []
      const source = change.sourceId && store.readSource(change.sourceId)
      const evidence = source ? change.spans.map(span => ({ ...span, sourceId: source.id, conversationId: source.conversation,
        text: source.withdrawn || source.version !== change.sourceVersion ? null : source.text?.slice(span.start, span.end).trim() || null })) : []
      const target = store.get(change.targetId)
      return [{ id: change.id, revision: change.revision, targetId: change.targetId, replacementId: change.replacementId,
        expectedRevisions: change.status === 'applied' && !change.needsConfirmation ? undoRefs(change) : [],
        kind: change.kind, status: change.status === 'applied' && change.needsConfirmation ? 'pending' as const : change.status,
        before: target?.text ?? null, scope: target?.scope ?? null,
        after: change.replacementId ? store.get(change.replacementId)?.text ?? null : null, evidence,
        from: change.from, to: change.to, effectiveAt: change.effectiveAt, createdAt: change.createdAt }]
    })
  }

  function restore(id: number, revision: number, key: string = randomUUID()) {
    if (mutation) throw domainError('change.pending')
    const before = store.revision()
    const entry = command(key, `restore:${id}`, revision, () => {
      const old = entryAt(id, revision)
      if (old.retention !== 'forgotten' || !retained({ ...old, retention: 'retained' })) throw domainError('not.found')
      const next = store.nextRevision()
      store.restoreEntry(id, next)
      return { result: id, value: store.get(id) }
    }, recalledResult)
    if (entry && before !== store.revision()) publish(store.revision(), [id], undefined, [id, ...entry.links.map(link => link.id)])
    return entry
  }

  function setProfile(changes: Record<string, unknown>, operation: string = randomUUID()) {
    const fields = Object.fromEntries(Object.entries(changes).map(([key, value]) => {
      if (!PROFILE_KEYS.includes(key) || typeof value !== 'string') throw domainError('invalid.text')
      return [key, value.trim() ? clean(value, MAX_FIELD_CHARS) : '']
    }))
    const previous = store.profile()
    const invalidates = Object.keys(fields).some(key => previous[key]?.value && previous[key].value !== fields[key])
    const write = () => {
      const before = store.revision()
      const result = command(operation, 'profile', Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)), () => {
        if (Object.entries(fields).some(([key, value]) => (previous[key]?.value ?? '') !== value)) {
          store.nextRevision(invalidates)
          const value = store.setProfile(fields)
          return { result: null, value }
        }
        return { result: null, value: previous }
      }, () => store.profile())
      if (before !== store.revision()) publish(store.revision(), [])
      return result
    }
    if (invalidates) return mutate(write, true)
    if (mutation) throw domainError('change.pending')
    return write()
  }

  function relatedSourceIds(ids: readonly string[]) {
    const related = new Set(ids)
    for (const id of ids) {
      const source = store.readSource(id)
      if (source?.author !== 'answer' || !source.conversation || !source.requestId) continue
      for (const answer of store.answerSourceIds(source.conversation, source.requestId)) related.add(answer)
    }
    return related
  }

  function holdWithdrawal(conversation: string, ids?: readonly string[]) {
    maintenance?.pause()
    profiles?.resetLive()
    if (ids) for (const id of relatedSourceIds(ids)) blockedSources.add(id)
    else blocked.add(conversation)
    for (const [controller, { reads }] of semanticControllers) {
      if (reads.some(ref => !indexableEntry(ref))) controller.abort()
    }
  }

  function releaseWithdrawal(conversation: string, ids?: readonly string[]) {
    if (ids) for (const id of relatedSourceIds(ids)) blockedSources.delete(id)
    else blocked.delete(conversation)
    maintenance?.schedule(true)
    profiles?.sync()
    void effects.wake()
  }

  function withdraw(payload: MemoryWithdrawal) {
    const before = store.revision()
    const touched = new Set<number>()
    store.tx(() => {
      const ids = payload.onlySources ? relatedSourceIds(payload.ids) : new Set([
        ...payload.ids, ...store.sourceIds(payload.conversation), ...store.deliveredSourceIds(payload.conversation),
      ])
      const sources = [...ids].flatMap(id => {
        const source = store.readSource(id)
        // A copied branch shares the original's stable source ID. Whole-segment deletion still
        // applies to sources owned by that segment only.
        return source && !source.withdrawn && (payload.onlySources || source.conversation === payload.conversation) ? [source] : []
      })
      const delivered = [...ids].filter(id => {
        const conversation = store.deliveredSource(id)?.conversation
        return conversation && (payload.onlySources || conversation === payload.conversation) && !store.sourceExcluded(id)
      })
      if (!sources.length && !delivered.length && (payload.onlySources || store.meta(`withdrawn:${payload.conversation}`))) return
      const rev = store.nextRevision()
      const removedChanges = sources.flatMap(source => store.changesFrom(source.id).map(captureRemovedChange))
      for (const id of delivered) store.excludeSource(id)
      for (const source of sources) {
        store.excludeSource(source.id)
        store.clearCandidates(source.id)
        effects.cancel(EXTRACT, source.id)
        notes?.withdraw(source.id)
        for (const id of store.memoriesFrom(source.id)) touched.add(id)
        for (const change of store.changesFrom(source.id)) {
          store.setChangeStatus(change.id, 'withdrawn', rev)
          touched.add(change.targetId)
          if (change.replacementId) touched.add(change.replacementId)
        }
        store.withdrawSource(source.id)
      }
      if (!payload.onlySources) store.setMeta(`withdrawn:${payload.conversation}`, '1')
      reproject(touched, rev)
      for (const change of removedChanges) retainIndependentDisputes(change, rev, touched)
      validateDispatch()
    })
    if (before !== store.revision()) publish(store.revision(), [...touched], undefined, [...touched])
  }

  function sourceCurrent(id: string, at = now(), historical = false) {
    const source = store.readSource(id)
    if (!source?.hash || source.withdrawn || store.sourceExcluded(id) || sourceBlocked(source)) return false
    if (!historical && store.hasChangeSource(id)) return false
    return store.memoriesFrom(id).every(memoryId => {
      const entry = store.get(memoryId)
      if (!entry?.evidence.some(edge => edge.sourceId === id)) return false
      if (!historical && !visible(entry, at)) return false
      return store.changesFor(memoryId).every(change => {
        if (change.kind === 'correct') return change.targetId !== memoryId
        if (historical || !covers(change.from, change.to, at)) return true
        if (change.kind === 'pending_relation') {
          const peer = change.targetId === memoryId && change.replacementId ? store.get(change.replacementId) : null
          return !peer || !retained(peer) || !available(peer) || !independentWindows(peer).some(window => covers(window.from, window.to, at))
        }
        if (change.kind !== 'possible_conflict') return change.targetId !== memoryId
        const other = change.targetId === memoryId ? change.replacementId : change.targetId
        const counterpart = other && store.get(other)
        return !counterpart || !visible(counterpart, at) || !available(counterpart)
      })
    })
  }

  /** Delivery and memory admission have separate receipts. The raw receipt stores only identity and ownership. */
  function recordDeliveredSource(id: string, conversation: string, derived = false) {
    operationId.parse(id)
    const prior = store.deliveredSource(id)
    const owner = prior?.conversation ?? store.readSource(id)?.conversation
    if ((owner && owner !== conversation) || (prior && Boolean(prior.derived) !== derived) || store.sourceExcluded(id)) {
      throw domainError('operation.conflict')
    }
    store.recordDeliveredSource(id, conversation, derived)
  }

  function dispatchSourceCurrent(id: string, at = now()) {
    const source = store.readSource(id)
    if (source?.hash) return sourceCurrent(id, at)
    const conversation = store.deliveredSource(id)?.conversation
    return Boolean(conversation && !source?.withdrawn && !store.sourceExcluded(id) && !sourceBlocked({ id, conversation }))
  }

  function allowedHistory({ segmentId, sourceId, role, text }: { segmentId: string, sourceId?: string | null, role: string, text: string }) {
    if (blocked.has(segmentId) || looksSecret(text) || excludedSourceText(text)) return false
    if (sourceId && !sourceCurrent(sourceId, now(), true)) return false
    const source = sourceId && store.readSource(sourceId)
    return role !== 'user' || !source || source.hash === memoryHash(text)
  }

  function excludedSourceText(text: string, scope?: MemoryScope) {
    return historySpans(text).some(part => store.excluded(part, scope))
  }

  function stillAvailable(entry: MemoryEntry, scope?: MemoryScope) {
    return retained(entry) && contextAllows(entry.scope, scope) && available(entry)
  }

  function modelText(entry: MemoryEntry) {
    const fact = entry.fact
    if (!fact || !entry.evidence.some(edge => edge.changeId !== null)) return entry.text
    const subject = fact.subject === 'user' ? '用户' : fact.subject.replace(/^named:/, '')
    const assertion = fact.polarity === 'negative'
      ? `${subject} · ${fact.relation} · 否定值：${fact.object}`
      : `${subject} · ${fact.relation}：${fact.object}`
    const qualifiers = new Set<string>()
    for (const edge of entry.evidence) {
      if (!edge.parts) continue
      const source = store.readSource(edge.sourceId)
      if (!source?.text || sourceBlocked(source)) continue
      const change = edge.changeId === null ? null : store.getChange(edge.changeId)
      const [action, target] = change?.spans ?? []
      for (const span of [...edge.parts.qualifiers, ...edge.parts.conditions, ...edge.parts.temporal]) {
        if ([action, target].some(part => part && part.start < span.end && span.start < part.end)) continue
        const text = source.text.slice(span.start, span.end).trim()
        if (text && !looksSecret(text) && !excludedSourceText(text, entry.scope)) qualifiers.add(text)
      }
    }
    return qualifiers.size ? `${assertion}（${[...qualifiers].join('；')}）` : assertion
  }

  function summarize(entry: MemoryEntry) {
    const { id, revision, kind, conditional, modality, scope, validFrom, validTo, windows, fact } = entry
    const evidence = entry.evidence.filter(edge => !evidenceBlocked(edge))
    const intendedTime = fact && (fact.intendedFrom !== null || fact.intendedTo !== null)
      ? { from: fact.intendedFrom, to: fact.intendedTo } : null
    return { id, revision, text: modelText(entry), kind, conditional, modality, scope, evidence, validFrom, validTo, windows, intendedTime }
  }

  function evidenceExcerpt(sourceId: string, version: number, span: { start: number, end: number }, scope?: MemoryScope) {
    const source = store.readSource(sourceId)
    if (!source?.text || source.version !== version || source.withdrawn
      || sourceBlocked(source)
      || span.start < 0 || span.start >= span.end || span.end > source.text.length) return []
    const text = source.text.slice(span.start, span.end)
    if (!text.trim() || looksSecret(text) || excludedSourceText(text, scope)) return []
    return [{ ...span, sourceId, conversationId: source.conversation, sourceVersion: version, text }]
  }

  function spansForEdge(edge: MemoryEntry['evidence'][number], complete: boolean) {
    if (edge.changeId === null) return edge.spans
    const parts = edge.parts
    const change = store.getChange(edge.changeId)
    if (!parts || !change) return []
    const [action, target] = change.spans
    const spans = [parts.subject, parts.relation, parts.object, ...parts.qualifiers, ...parts.conditions, ...parts.temporal]
      .filter(span => span !== undefined)
    const safe = spans.filter(span => ![action, target].some(piece => piece && piece.start < span.end && span.start < piece.end))
    return complete && safe.length !== spans.length ? [] : safe
  }

  function excerptsForEdge(entry: MemoryEntry, edge: MemoryEntry['evidence'][number], complete = false) {
    const spans = spansForEdge(edge, complete)
    const excerpts = spans.flatMap(span => evidenceExcerpt(edge.sourceId, edge.sourceVersion, span, entry.scope))
    return complete && (excerpts.length !== spans.length || !excerpts.length) ? null : excerpts
  }

  function summarizeSide(entry: MemoryEntry) {
    return { ...summarize(entry), evidence: entry.evidence.flatMap(edge => excerptsForEdge(entry, edge) ?? []).slice(0, 8) }
  }

  function currentDispute(reference: DisputeReference) {
    const [firstRef, secondRef] = reference.sides
    const first = store.get(firstRef.id)
    const second = store.get(secondRef.id)
    if (!first || !second || !wholeEvidenceAvailable(first) || !wholeEvidenceAvailable(second)
      || first.revision !== firstRef.revision || second.revision !== secondRef.revision
      || !contextAllows(first.scope, reference.scope) || !contextAllows(second.scope, reference.scope)) return null
    return recallSelection([first, second], reference.asOf)?.disputes.find(dispute =>
      dispute.id === reference.id && dispute.revision === reference.revision) ?? null
  }

  function pendingAlternative(candidate: MemoryCandidate, scope: MemoryScope | undefined, asOf: string | undefined, at: number,
    selected = recallInterval(asOf, at)) {
    const data = pendingChangeData.safeParse(JSON.parse(candidate.proposal))
    if (!data.success || !contextAllows(data.data.scope, scope)) return null
    const { proposal, sourceVersion, sameRelation, conditions, event: pendingEvent } = data.data
    const source = store.readSource(candidate.sourceId)
    const change = proposal.change
    if (!change || !source?.text || source.version !== sourceVersion || source.author === 'manual' || source.withdrawn
      || store.sourceExcluded(source.id) || sourceBlocked(source)) return null
    const target = store.get(change.target.id)
    if (!target || !wholeEvidenceAvailable(target) || target.revision !== change.target.revision || !sameScope(target.scope, data.data.scope)
      || !sourceCanRead(target.scope, source) || !retained(target) || !available(target)) return null
    if (!selected) return null
    const offered = proposalSpans(source.text, proposal, sourceSpans(source.text))
    const fact = offered && groundedFact(source.text, proposal, source.at, source.timezone, offered)
    if (!offered) return null
    const event = pendingEvent ? groundedEventChange(source.text, proposal, target, source.at, source.timezone, offered) : null
    const windows = (event ? target.windows : fact ? pendingWindows(source, proposal, target, fact, offered, sameRelation, conditions) : [])
      .filter(window => intersect(window, selected))
    if (!windows.length) return null
    const original = sourceText(source.text, offered)
    if (looksSecret(original) || excludedSourceText(original, target.scope)) return null
    const evidence = offered.flatMap(span => evidenceExcerpt(source.id, sourceVersion, span, target.scope))
    if (evidence.length !== offered.length) return null
    const reference: PendingChangeReference = {
      kind: 'pending', sourceId: source.id, start: candidate.start, end: candidate.end,
      sourceVersion, candidateHash: memoryHash(candidate.proposal), expiresAt: candidate.expiresAt, scope, asOf,
    }
    const alternative = { text: fact ? sourceText(source.text, fact.evidence.spans) : original, value: fact?.object,
      polarity: fact?.polarity, evidence }
    const qualifiers = fact ? sourceText(source.text, [...fact.evidence.qualifiers, ...fact.evidence.conditions]) : ''
    return { reference, target, kind: change.kind, windows, alternative, qualifiers, keywords: proposal.keywords, updatedAt: source.at,
      event: event ? sourceText(source.text, event.eventSpans) : null }
  }

  function currentPending(reference: PendingChangeReference, at = now()) {
    const candidate = store.pendingChange(at, reference)
    if (!candidate || candidate.expiresAt !== reference.expiresAt || memoryHash(candidate.proposal) !== reference.candidateHash) return null
    const pending = pendingAlternative(candidate, reference.scope, reference.asOf, at)
    if (!pending || pending.reference.sourceVersion !== reference.sourceVersion) return null
    const entries = [...entriesWithPeers(new Set([pending.target.id])).values()]
      .filter(entry => contextAllows(entry.scope, reference.scope))
    const target = recallSelection(entries, reference.asOf, at)?.current.find(entry => entry.id === pending.target.id)
    return target ? withCurrentTarget(pending, target, recallInterval(reference.asOf, at)) : null
  }

  function withCurrentTarget(pending: NonNullable<ReturnType<typeof pendingAlternative>>, target: MemoryEntry, selected: MemoryInterval | null) {
    if (!selected) return null
    const windows = overlapWindows(pending.windows, target.windows, { from: null, to: null })
    return windows.some(window => intersect(window, selected)) ? { ...pending, target, windows } : null
  }

  function availablePending(scope: MemoryScope | undefined, asOf: string | undefined, at: number,
    current: readonly MemoryEntry[] | undefined, candidates = store.pendingChanges(at)) {
    const selected = recallInterval(asOf, at)
    const targets = current && new Map(current.map(entry => [entry.id, entry]))
    const reader = selected && !targets ? createRecallReader(scope, selected) : null
    return candidates.flatMap(candidate => {
      const pending = pendingAlternative(candidate, scope, asOf, at, selected)
      const target = pending && (targets ? targets.get(pending.target.id) : reader?.select([pending.target]).current[0])
      const applicable = pending && target && withCurrentTarget(pending, target, selected)
      return applicable ? [{ ...applicable, text: `${modelText(applicable.target)}\n${applicable.alternative.text}` }] : []
    })
  }

  function disputeReference(dispute: ReturnType<typeof selection>['disputes'][number], scope?: MemoryScope, asOf?: string): DisputeReference {
    const [first, second] = dispute.sides
    return { kind: 'dispute', id: dispute.id, revision: dispute.revision, scope, asOf,
      sides: [{ id: first.id, revision: first.revision }, { id: second.id, revision: second.revision }] }
  }

  type CardQuestion = { question: string, header?: string, options: readonly { label: string, description?: string }[] }
  function authorizeGeneralQuestion(origin: Origin & { session: string, turn: string }, cards: readonly CardQuestion[], stillWaiting = () => true) {
    const scope = origin.context ?? origin.scope
    const scopes = [scope, ...(origin.project ? [origin.project] : [])]
    const questions = cards.map(({ question, header, options }) => ({ question, header, options }))
    const wording = questions.flatMap(card => [card.question, card.header ?? '', ...card.options.flatMap(option => [option.label, option.description ?? ''])])
    if (wording.some(part => looksSecret(part) || scopes.some(scope => excludedSourceText(part, scope)))) return false
    const incomplete = () => (clarifications.incompleteDates(origin.session, origin.turn)?.size ?? 0) > 8
    if (incomplete()) return false
    const inspect = () => {
      const at = now()
      const references = new Map<string, ClarificationReference>()
      const track = (reference: ClarificationReference) => references.set(JSON.stringify(reference), reference)
      for (const scope of scopes) {
        const entries = scopedEntries(scope)
        const selected = selection(entries, at)
        for (const dispute of selected.disputes) track(disputeReference(dispute, scope))
        for (const pending of availablePending(scope, undefined, at, selected.current)) track(pending.reference)
        for (const asOf of clarifications.incompleteDates(origin.session, origin.turn) ?? []) {
          const historical = recallSelection(entries, asOf, at)
          if (!historical) continue
          for (const dispute of historical.disputes) track(disputeReference(dispute, scope, asOf))
          for (const pending of availablePending(scope, asOf, at, historical.current)) track(pending.reference)
        }
      }
      for (const observed of clarifications.observed(origin.session, origin.turn)) track(observed)
      const related: { relations: string[], choices: string[][], reference: ClarificationReference }[] = []
      const relationOf = (relation: string | undefined) => relation && relation.length <= 100 && !looksSecret(relation)
        && !excludedSourceText(relation, scope) ? relation : undefined
      const add = (reference: ClarificationReference, sides: readonly { id?: number, relation?: string, value?: string }[]) => {
        const relations = [...new Set(sides.flatMap(side => relationOf(side.relation) ?? []))]
        const choices = sides.map(side => [side.id === undefined ? '' : `#${side.id}`, side.value ?? ''].filter(Boolean).map(factIdentity))
        related.push({ relations, choices, reference })
      }
      for (const reference of references.values()) {
        if (reference.kind === 'dispute') {
          const dispute = currentDispute(reference)
          if (dispute) add(reference, dispute.sides.map(({ fact, id }) => ({ id, relation: fact?.relation, value: fact?.object })))
        } else {
          const pending = currentPending(reference, at)
          if (pending) add(reference, [{ id: pending.target.id, relation: pending.target.fact?.relation, value: pending.target.fact?.object },
            { value: pending.alternative.value }])
        }
      }
      return related
    }
    const related = inspect()
    if (!related.length) return () => stillWaiting() && !closed && !incomplete() && !inspect().length
    const exactPair = questions.some(card => {
      const options = new Set(card.options.map(option => factIdentity(option.label)))
      return related.some(({ choices: [first, second] }) => first.some(a => options.has(a) && second.some(b => b !== a && options.has(b))))
    })
    if (exactPair) return false
    const model = route()
    const descriptions = related.flatMap(({ relations, reference }) => relations.length ? [{ relations, asOf: reference.asOf }] : [])
    const disputes = [...new Map(descriptions.map(item => [JSON.stringify(item), item])).values()]
    const unknownRelations = related.length - descriptions.length
    const fingerprint = () => memoryHash(JSON.stringify([origin.session, origin.turn, questions, inspect()]))
    const snapshotId = fingerprint()
    const input = JSON.stringify({ snapshotId, questions, disputes, unknownRelations })
    // Any unreviewed pair may be the one the card asks about. Refuse partial input.
    if (!model || input.length > 24_000) return false
    const current = () => stillWaiting() && !closed && !incomplete() && fingerprint() === snapshotId
    const valid = () => !mutation && current()
    const deadline = atNextQuestionBoundary(related.map(item => item.reference), now())
    const id = randomUUID()
    runningComputations.set(id, { ready: valid, current, deadline })
    const controller = new AbortController()
    let result: ReturnType<typeof compute>
    try { result = compute({ id, sourceId: id, generation: 1, stage: 'question', ...model, input, system: QUESTION_SYSTEM }, controller.signal) }
    catch { result = null }
    if (!result) { runningComputations.delete(id); return false }
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null) }, 8000)
      timer.unref()
    })
    return Promise.race([result, timeout]).then(reply => {
      if (reply === null) return false
      const review = questionReview.parse(JSON.parse(reply))
      return review.snapshotId === snapshotId && review.verdict === 'unrelated' ? valid : false
    }).catch(() => false).finally(() => { clearTimeout(timer); runningComputations.delete(id) })
  }

  function atNextQuestionBoundary(references: readonly ClarificationReference[], at: number) {
    const sides = references.flatMap(ref => {
      if (ref.kind === 'dispute') return ref.sides.map(side => ({ ...side, asOf: ref.asOf }))
      const pending = currentPending(ref, at)
      return pending ? [{ id: pending.target.id, revision: pending.target.revision, asOf: ref.asOf }] : []
    })
    let deadline = dispatchDeadline(sides, [], at) ?? Infinity
    for (const reference of references) if (reference.kind === 'pending') {
      deadline = Math.min(deadline, reference.expiresAt)
      if (!reference.asOf) for (const { to } of currentPending(reference, at)?.windows ?? []) {
        if (to !== null && to > at) deadline = Math.min(deadline, to)
      }
    }
    return Number.isFinite(deadline) ? deadline : null
  }

  function provisionalReadsCurrent(session: string, at = now()) {
    return [...clarifications.pending(session)].every(reference => currentPending(reference, at) !== null)
  }

  function provisionalDeadline(session: string, at: number) {
    let deadline = Infinity
    for (const reference of clarifications.pending(session)) {
      const pending = currentPending(reference, at)
      if (!pending) return at
      deadline = Math.min(deadline, reference.expiresAt)
      if (!reference.asOf) for (const { to } of pending.windows) {
        if (to !== null && to > at) deadline = Math.min(deadline, to)
      }
    }
    return Number.isFinite(deadline) ? deadline : undefined
  }

  function clarify(session: string, ref: string, origin: Origin) {
    if (!origin.foregroundTurn || origin.session !== session) return { status: 'rejected', reason: 'foreground-only' }
    const scopes = [origin.context ?? origin.scope, ...(origin.project ? [origin.project] : [])]
    return clarifications.issue(session, origin.foregroundTurn, ref, (id, reference) => {
      const matchingScope = scopes.some(scope => scope && reference.scope ? sameScope(scope, reference.scope) : scope === reference.scope)
      return matchingScope && !mutation ? questionForReference(id, reference) : null
    })
  }

  function questionForReference(id: string, reference: ClarificationReference) {
    const option = (label: string, description = label) => ({ label: label.slice(0, 200), description: description.slice(0, 1000) })
    if (reference.kind === 'pending') {
      const pending = currentPending(reference)
      if (!pending) return null
      const old = modelText(pending.target)
      const { value, polarity, text } = pending.alternative
      const valueLabel = value === undefined ? presentMessage('clarify.pending.ended')
        : polarity === 'negative' ? presentMessage('clarify.negative', { value }) : value
      const proposed = pending.qualifiers ? `${valueLabel} (${pending.qualifiers})` : valueLabel
      const question = pending.event ? presentMessage('clarify.pending.event.question', { event: pending.event.slice(0, 500) })
        : reference.asOf ? presentMessage('clarify.pending.dated.question', { date: reference.asOf })
        : presentMessage('clarify.pending.question')
      return { id, question, options: [
        option(presentMessage('clarify.pending.current', { value: old }), old),
        option(presentMessage('clarify.pending.alternative', { value: proposed }), text),
      ] }
    }
    const dispute = currentDispute(reference)
    if (!dispute) return null
    const question = reference.asOf ? presentMessage('clarify.dated.question', { date: reference.asOf }) : presentMessage('clarify.question')
    return { id, question, options: dispute.sides.map(side => option(`#${side.id} ${modelText(side)}`, modelText(side))) }
  }

  function clarificationQuestion(session: string, foregroundTurn: string, id: string, phase: 'show' | 'check') {
    return mutation ? null : clarifications.question(session, foregroundTurn, id, phase, questionForReference)
  }

  function modelEntry(entry: MemoryEntry) {
    const text = modelText(entry)
    return { ...entry, text, keywords: entry.keywords.filter(word => text.includes(word)) }
  }

  type RecallRequest = Extract<MemoryRequest, { op: 'recall' }>
  type IndexHit = Pick<MemoryEntry, 'id' | 'revision'>
  type SemanticRecall = { hits: readonly IndexHit[], reasons: string[], scores?: ReadonlyMap<string, number> }

  function hasIdentifiers(text: string, identifiers: readonly string[]) {
    if (!identifiers.length) return true
    const stated = new Set(memoryIdentifierTokens(text))
    return identifiers.some(value => stated.has(value))
  }

  function mergeMatches(entries: readonly MemoryEntry[], query: string, indexed: ReturnType<typeof lexical.search>, limit: number) {
    const identifiers = memoryIdentifierTokens(query)
    const projected = entries.map(modelEntry).filter(row => hasIdentifiers(row.text, identifiers))
    const byId = new Map(projected.map(entry => [entry.id, entry]))
    const verified = indexed?.hits.flatMap(({ id, revision }) => {
      const row = byId.get(id)
      return row?.revision === revision && memoryIndexMatches(row.text, query, row.keywords) ? [row] : []
    }) ?? []
    const keyword = recallCandidates(projected, query, limit)
    const all = new Map([...verified, ...keyword.found].map(row => [row.id, row]))
    return { found: [...all.values()].slice(0, limit), verified: new Set(verified.map(row => row.id)), partial: !verified.length && keyword.partial }
  }

  function createRecallReader(scope: MemoryScope | undefined, interval: MemoryInterval) {
    const cache = new Map<number, MemoryEntry | null>()
    function get(id: number) {
      if (!cache.has(id)) {
        const entry = store.get(id)
        cache.set(id, entry && contextAllows(entry.scope, scope) && modelEligible(entry) ? entry : null)
      }
      return cache.get(id) ?? null
    }
    function select(refs: readonly IndexHit[]) {
      const entries = new Map<number, MemoryEntry>()
      for (const ref of refs) {
        const entry = get(ref.id)
        if (entry?.revision === ref.revision) entries.set(entry.id, entry)
      }
      const requested = new Set(entries.keys())
      for (const entry of [...entries.values()]) for (const link of entry.links) {
        if (link.kind !== 'conflict' && link.kind !== 'pending-relation') continue
        const peer = get(link.id)
        if (peer) entries.set(peer.id, peer)
      }
      const selected = readableSelection([...entries.values()], interval)
      return {
        ...selected,
        current: selected.current.filter(entry => requested.has(entry.id)),
        conflicts: selected.conflicts.filter(entry => requested.has(entry.id)),
        disputes: selected.disputes.filter(dispute => dispute.sides.some(side => requested.has(side.id))),
        pendingRelations: selected.pendingRelations.filter(entry => requested.has(entry.id)),
      }
    }
    return { get, select }
  }

  function indexedSelection(query: string, scope: MemoryScope | undefined, interval: MemoryInterval, reader: ReturnType<typeof createRecallReader>,
    contextOnly = false) {
    const index = lexical.search(query, scope, INDEX_MATCH_LIMIT, interval, contextOnly ? 'context' : 'recall')
    function rank(refs: readonly IndexHit[]) {
      const selected = reader.select(refs)
      const current = contextOnly ? selected.current.filter(entry => !entry.conditional && entry.modality === 'asserted') : selected.current
      const limit = contextOnly ? 3 : 6
      return { selected, found: mergeMatches(current, query, index, limit), related: mergeMatches(selected.conflicts, query, index, limit) }
    }
    const hits = index?.hits ?? []
    const first = rank(hits)
    if (first.found.verified.size || first.related.verified.size || !query.trim()) return { index, ...first, fallbackLimited: false }
    const recent = store.recentRecallRefs(scope, interval, KEYWORD_FALLBACK_LIMIT + 1, contextOnly)
    const refs = [...new Map([...hits, ...recent.slice(0, KEYWORD_FALLBACK_LIMIT)].map(ref => [ref.id, ref])).values()]
    return { index, ...rank(refs), fallbackLimited: recent.length > KEYWORD_FALLBACK_LIMIT }
  }

  type NotePassage = SearchChunk & { title: string, day: string, sourceIds: string[] }
  type DailyDocument = DailySearchDocument & ({ memory: MemoryEntry } | { passage: NotePassage })
  const dailySemantic = notes && embedder ? createDailySemanticSearch(embedder, resources.identity.hash) : null
  const dailyMemoryKey = ({ id, revision }: IndexHit) => `memory:${id}:${revision}`

  function dailyDocuments(request: RecallRequest, origin: Origin, entries: MemoryEntry[], interval: MemoryInterval, at: number) {
    const scope = recallScope(request, origin)
    const identifiers = memoryIdentifierTokens(request.query)
    const zone = typeof dailyNotes === 'object' ? dailyNotes.timezone ?? defaults.timezone : defaults.timezone
    const cutoff = request.asOf ? todayAt(interval.to! - 1, zone) : null
    const through = request.end_date && cutoff ? (request.end_date < cutoff ? request.end_date : cutoff) : request.end_date ?? cutoff
    const from = request.start_date ?? null
    const docs: DailyDocument[] = []
    for (const memory of entries) {
      const text = modelText(memory)
      // Date bounds apply to dated notes. As in ReMe's non-strict mode, include undated documents.
      if (!hasIdentifiers(text, identifiers) || looksSecret(text) || excludedSourceText(text, memory.scope)) continue
      docs.push({ key: dailyMemoryKey(memory), memory, text, keywords: memory.keywords.filter(word => text.includes(word)) })
    }
    for (const note of notes?.list(from, through) ?? []) {
      if (request.asOf && note.updatedAt >= interval.to!) continue
      const sourceIds = notes?.sources(note.key) ?? []
      const body = `${note.title}
${note.markdown}`
      if (!sourceIds.length || looksSecret(body) || !sourceIds.every(id => {
        const source = store.readSource(id)
        return source && sourceCurrent(id, at) && (contextAllows(source.scope, scope) || contextAllows(source.scope, origin.project))
          && (!source.project || Boolean(origin.project && sameScope(source.project, origin.project)))
          && (!source.context || contextAllows(source.context, origin.context ?? origin.scope))
          && !excludedSourceText(body, source.context ?? source.scope)
          && !excludedSourceText(body, source.scope) && !excludedSourceText(body, origin.project)
      })) continue
      for (const chunk of markdownSearchChunks(note.markdown)) {
        const text = `${note.title}
${chunk.text}`
        if (hasIdentifiers(text, identifiers)) {
          const key = `note:${note.key}:${note.revision}:${chunk.startLine}`
          docs.push({ key, text, passage: { title: note.title, day: note.day, ...chunk, sourceIds } })
        }
      }
    }
    return docs
  }

  function recallSnapshot(request: RecallRequest, scope: MemoryScope | undefined, at: number) {
    const interval = recallInterval(request.asOf, at)
    if (!interval) return null
    const reader = createRecallReader(scope, interval)
    if (notes) {
      const selected = readableSelection(scopedEntries(scope), interval)
      const found = mergeMatches([], request.query, null, 0)
      const related = mergeMatches(selected.conflicts, request.query, null, dailySearchLimit(request.limit))
      return { reader, interval, selected, found, related, index: undefined, fallbackLimited: false }
    }
    const candidates = indexedSelection(request.query, scope, interval, reader)
    return { reader, interval, ...candidates }
  }

  function indexableEntry({ id, revision }: MemorySemanticReference) {
    const entry = store.get(id)
    return entry?.revision === revision && retained(entry) && modelEligible(entry) && wholeEvidenceAvailable(entry) && available(entry) ? entry : null
  }

  function passageText(entry: MemoryEntry) {
    const text = modelText(entry)
    return text.trim() && text.length <= MEMORY_EMBEDDING_MAX_CHARS && !looksSecret(text) && !excludedSourceText(text, entry.scope) ? text : null
  }

  function resetSemanticJobs() {
    dailySemantic?.clear()
    for (const controller of semanticControllers.keys()) controller.abort()
    semanticControllers.clear()
  }

  function profileChoices(scope: MemoryProfileScope, at: number): MemoryProfileInput[] {
    const reader = createRecallReader(scope, { from: at, to: at + 1 })
    const refs = store.profileCandidates(scope, at, MEMORY_PROFILE_INPUT_LIMIT * 2)
    const selected = reader.select(refs)
    const pending = new Set(selected.pendingRelations.map(row => row.id))
    return selected.current.flatMap(entry => {
      if (!sameScope(entry.scope, scope) || entry.conditional || entry.modality !== 'asserted' || pending.has(entry.id)) return []
      const text = passageText(entry)
      return text ? [{ ref: { kind: 'memory' as const, id: entry.id, revision: entry.revision }, text }] : []
    })
  }

  function readProfileItems(scope: MemoryProfileScope, refs: readonly MemoryProfileRef[], at: number): MemoryProfileInput[] | null {
    const reader = createRecallReader(scope, { from: at, to: at + 1 })
    const selected = reader.select(refs.flatMap(ref => ref.kind === 'memory' ? [ref] : []))
    const pending = new Set(selected.pendingRelations.map(row => row.id))
    const byId = new Map(selected.current.map(entry => [entry.id, entry]))
    const manual = scope.kind === 'user' ? store.profile() : {}
    const items = refs.flatMap<MemoryProfileInput>(ref => {
      if (ref.kind === 'manual') {
        const field = manual[ref.field]
        return field?.revision === ref.revision ? [{ ref, text: field.value }] : []
      }
      const entry = byId.get(ref.id)
      if (!entry || !sameScope(entry.scope, scope) || entry.conditional || entry.modality !== 'asserted' || pending.has(entry.id)) return []
      const text = passageText(entry)
      return text ? [{ ref, text }] : []
    })
    const safe = prepareMemoryProfileInput(scope, items)
    return safe.length === refs.length ? safe : null
  }

  function profileInputCurrent(snapshot: MemoryProfileSnapshot) {
    if (closed || blocked.size || blockedSources.size) return false
    const values = readProfileItems(snapshot.scope, snapshot.inputs.map(({ ref }) => ref), now())
    return values !== null && values.every(({ text }, index) => text === snapshot.inputs[index].text)
  }

  function profileSummary(scope: MemoryProfileScope = { kind: 'user' }, at = now()) {
    const result = profiles?.read(scope)
    if (!result || blocked.size || blockedSources.size) return null
    const items = readProfileItems(scope, result.refs, at)
    return items ? { revision: result.revision, validUntil: result.validUntil, items } : null
  }

  function profileView(scope: MemoryProfileScope, at = now()) {
    profiles?.observe(scope)
    const projection = profileSummary(scope, at)
    const rows = projection?.items ?? (profilesEnabled ? prepareMemoryProfileInput(scope, profileChoices(scope, at)).slice(0, 4) : [])
    const items = rows.flatMap(({ ref, text }) => {
      if (ref.kind !== 'memory') return []
      const entry = store.get(ref.id)
      if (!entry) return []
      const dependency: MemoryDependency = { id: ref.id, revision: ref.revision }
      const deadline = projection?.validUntil ?? dispatchDeadline([dependency], [], at)
      if (deadline !== null) dependency.expiresAt = deadline
      if (projection) dependency.collectionRevision = projection.revision
      return [{ text, dependency, evidence: entry.evidence.flatMap(edge => excerptsForEdge(entry, edge) ?? [])[0] }]
    })
    return { generated: projection !== null, items }
  }

  async function semanticRecall(request: RecallRequest, origin: Origin, stillCurrent: () => boolean, interval: MemoryInterval, lexicalHits: readonly IndexHit[], signal?: AbortSignal): Promise<SemanticRecall> {
    const failure = (reason: string) => ({ hits: [], reasons: [reason] })
    const scope = recallScope(request, origin)
    const index = semantic
    if (!index || !embedder || mutation || closed || signal?.aborted || !stillCurrent()) return failure('semantic-unavailable')
    if (looksSecret(request.query) || excludedSourceText(request.query, scope)) return failure('semantic-unavailable')
    if (semanticControllers.size) return failure('semantic-busy')
    maintenance?.pause()
    const { fingerprint } = embedder
    const controller = new AbortController()
    const work = { current: stillCurrent, reads: [] as IndexHit[] }
    semanticControllers.set(controller, work)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const deadline = performance.now() + MEMORY_SEMANTIC_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      index.configure(fingerprint)
      const version = index.version(fingerprint)
      if (version === null) return failure('semantic-unavailable')
      const reader = createRecallReader(scope, interval)
      const identifiers = memoryIdentifierTokens(request.query)
      const matchesIdentifier = (entry: MemoryEntry) => !identifiers.length || hasIdentifiers(modelText(entry), identifiers)
      const preferred = index.missing(fingerprint, lexicalHits)
      const missing = [...new Map([...preferred, ...index.missingScoped(fingerprint, scope, interval)].map(ref => [ref.id, ref])).values()]
      const rows = reader.select(missing)
      const eligible = new Map([...rows.current, ...rows.conflicts].map(entry => [entry.id, entry]))
      const projections = missing.flatMap(ref => {
        const entry = eligible.get(ref.id)
        return entry && matchesIdentifier(entry) ? [{ ...ref, text: passageText(entry) }] : []
      }).slice(0, MEMORY_EMBEDDING_BATCH)
      work.reads = projections
      const inputs = [{ kind: 'query' as const, text: request.query }, ...projections.flatMap(({ text }) =>
        text === null ? [] : [{ kind: 'passage' as const, text }])]
      const ready = () => !closed && !mutation && stillCurrent() && semantic === index && index.version(fingerprint) === version
        && !excludedSourceText(request.query, scope)
      const timeout = new Promise<null>(resolve => {
        if (controller.signal.aborted) { resolve(null); return }
        controller.signal.addEventListener('abort', () => resolve(null), { once: true })
        timer = setTimeout(() => controller.abort(), MEMORY_SEMANTIC_TIMEOUT_MS)
        timer.unref()
      })
      const output = await Promise.race([embedder.embedBatch(inputs, controller.signal), timeout])
      if (!output || output.length !== inputs.length || !output[0] || controller.signal.aborted) return failure('semantic-unavailable')
      if (!ready()) return failure('semantic-changed')
      const fresh = createRecallReader(scope, interval)
      const selection = fresh.select(projections)
      const currentIds = new Set([...selection.current, ...selection.conflicts].map(entry => entry.id))
      let position = 1
      index.put(fingerprint, projections.flatMap(({ id, revision, text }) => {
        const vector = text === null ? null : output[position++]
        return currentIds.has(id) && indexableEntry({ id, revision }) ? [{ id, revision, vector }] : []
      }), version)
      const scanReader = createRecallReader(scope, interval)
      const { hits, partial, skipped, incomplete } = await index.searchScoped(fingerprint, output[0], scope, 50, {
        interval, signal: controller.signal, deadline,
        accept(ref) {
          const selected = scanReader.select([ref])
          return [...selected.current, ...selected.conflicts].some(matchesIdentifier)
        },
      })
      if (controller.signal.aborted || !ready()) return failure('semantic-changed')
      return { hits, reasons: [
        ...(incomplete ? ['semantic-index-incomplete'] : []),
        ...(skipped ? ['semantic-unindexed-input'] : []),
        ...(partial ? ['semantic-limit'] : []),
        ...(rows.held || selection.held ? ['source-withdrawal-pending'] : []),
      ] }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      semanticControllers.delete(controller)
      maintenance?.schedule()
    }
  }

  function recallScope(request: RecallRequest, origin: Origin) {
    return request.scope === 'project' ? origin.project : origin.context ?? origin.scope
  }

  function handleModelRequest(request: MemoryRequest, origin: Origin, stillCurrent: () => boolean, signal?: AbortSignal) {
    if (request.op !== 'recall') return handle(request, origin)
    if (request.scope === 'project' && !origin.project) return textOf({ status: 'rejected', reason: 'project-unavailable' })
    const scope = recallScope(request, origin)
    const at = now()
    const snapshot = recallSnapshot(request, scope, at)
    if (!snapshot) return textOf({ status: 'rejected', reason: 'invalid-date' })
    if (notes) {
      if (!dailySemantic || mutation || closed || signal?.aborted || !stillCurrent() || semanticControllers.size ||
        looksSecret(request.query) || excludedSourceText(request.query, scope)) return recallPacket(request, origin, snapshot, at)
      const documents = dailyDocuments(request, origin, snapshot.selected.current, snapshot.interval, at)
      if (!documents.length) return recallPacket(request, origin, snapshot, at)
      maintenance?.pause()
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      const refs = documents.flatMap(doc => 'memory' in doc ? [{ id: doc.memory.id, revision: doc.memory.revision }] : [])
      semanticControllers.set(controller, { current: stillCurrent, reads: refs })
      const timer = setTimeout(abort, defaults.requestTimeoutMs)
      timer.unref()
      const aborted = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }))
      const scores = new Map<string, number>()
      function indexed(query: Float32Array) {
        if (!embedder || !semantic) return new Map<string, number>()
        try {
          const hits = semantic.similarities(embedder.fingerprint, query, refs)
          return new Map(hits.map(hit => [dailyMemoryKey(hit), hit.similarity]))
        } catch {
          return new Map<string, number>()
        }
      }
      const ranking = dailySemantic.rank(documents, request.query, controller.signal, { scores, indexed })
      return Promise.race([ranking, aborted]).catch(() => null).then(result => {
        if (closed || signal?.aborted || !stillCurrent() || mutation) return textOf({ status: 'unavailable' })
        const currentAt = now()
        const current = recallSnapshot(request, scope, currentAt)
        if (!current) return textOf({ status: 'rejected', reason: 'invalid-date' })
        return recallPacket(request, origin, current, currentAt, {
          hits: [], scores, reasons: result?.incomplete === false ? [] : ['semantic-index-incomplete'],
        })
      }).finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        semanticControllers.delete(controller)
        maintenance?.schedule()
      })
    }
    if (!request.deep && (snapshot.found.verified.size || snapshot.related.verified.size)) return recallPacket(request, origin, snapshot, at)
    if (snapshot.index && !snapshot.index.truncated && !snapshot.index.hits.length && memoryIdentifierTokens(request.query).length) {
      return recallPacket(request, origin, snapshot, at)
    }
    if (!store.recentRecallRefs(scope, snapshot.interval, 1).length) return recallPacket(request, origin, snapshot, at)
    return semanticRecall(request, origin, stillCurrent, snapshot.interval, snapshot.index?.hits ?? [], signal).catch(() => ({ hits: [], reasons: ['semantic-unavailable'] })).then(result => {
      if (closed || signal?.aborted || !stillCurrent()) return textOf({ status: 'unavailable' })
      const currentAt = now()
      const current = recallSnapshot(request, scope, currentAt)
      if (!current) return textOf({ status: 'rejected', reason: 'invalid-date' })
      if (request.asOf && !sameWindows([snapshot.interval], [current.interval])) {
        return recallPacket(request, origin, current, currentAt, { hits: [], reasons: ['semantic-changed'] })
      }
      return recallPacket(request, origin, current, currentAt, result)
    })
  }

  function rebuildIndexes() {
    maintenance?.reset()
    resetSemanticJobs()
    semantic = resources.openSemantic()
    let resetSemantic = false
    try { if (semantic) { semantic.clear(); resetSemantic = true } } catch { /* Keyword and full-text recall remain available. */ }
    if (resetSemantic) maintenance?.schedule()
    const fullText = lexical.rebuild()
    if (fullText) warmLexicalIndex()
    return { fullText, semantic: resetSemantic }
  }

  function recallsPendingEnding(request: RecallRequest, scope: MemoryScope | undefined, snapshot: NonNullable<ReturnType<typeof recallSnapshot>>) {
    if (!store.hasPendingEnding(snapshot.interval)) return false
    const index = lexical.search(request.query, scope, INDEX_MATCH_LIMIT, undefined, 'recall')
    const fallback = !index || index.truncated || !index.hits.length
      ? store.inactiveRecallRefs(scope, snapshot.interval, KEYWORD_FALLBACK_LIMIT) : []
    const candidates = new Map([...(index?.hits ?? []), ...fallback].map(ref => [ref.id, ref]))
    const affected = [...candidates.values()].flatMap(({ id, revision }) => {
      const entry = snapshot.reader.get(id)
      return entry?.revision === revision && retained(entry) && wholeEvidenceAvailable(entry) && available(entry)
        && !entry.windows.some(window => intersect(window, snapshot.interval)) ? [modelEntry(entry)] : []
    })
    const matched = recallCandidates(affected, request.query, 6).found
    if (!matched.length) return false
    return store.pendingEndingsFor(matched.map(entry => entry.id)).some(change => {
      if (!intersect(snapshot.interval, { from: change.intentFrom, to: change.intentTo })) return false
      const source = change.sourceId && store.readSource(change.sourceId)
      return source && !source.withdrawn && !sourceBlocked(source)
    })
  }

  function recallPacket(request: RecallRequest, origin: Origin, snapshot: NonNullable<ReturnType<typeof recallSnapshot>>, at: number,
    semanticResult?: SemanticRecall) {
    const scope = recallScope(request, origin)
    const { reader, interval, selected, found, related, index, fallbackLimited } = snapshot
    const semanticRefs = semanticResult?.hits ?? []
    const semanticRows = reader.select(semanticRefs)
    const rankedSemantic = (rows: MemoryEntry[]) => {
      const byId = new Map(rows.map(entry => [entry.id, entry]))
      return semanticRefs.flatMap(({ id }) => byId.get(id) ?? [])
    }
    const { asOf } = request
    const dated = asOf ? { asOf, asOfZone: timezone() } : { asOf }
    const { disputes, pendingRelations, held } = selected
    const keywordIds = new Set(found.found.map(entry => entry.id))
    const keywordConflictIds = new Set(related.found.map(entry => entry.id))
    const standardDirect = [...new Map([...found.found, ...rankedSemantic(semanticRows.current)].map(entry => [entry.id, entry])).values()]
    const relatedEntries = [...new Map([...related.found, ...rankedSemantic(semanticRows.conflicts)].map(entry => [entry.id, entry])).values()]
    const allDisputes = [...new Map([...disputes, ...semanticRows.disputes].map(dispute => [dispute.id, dispute])).values()]
    const rank = new Map(relatedEntries.map((entry, index) => [entry.id, index]))
    const position = (dispute: typeof disputes[number]) => Math.min(...dispute.sides.map(side => rank.get(side.id) ?? Infinity))
    const matches = allDisputes.filter(dispute => Number.isFinite(position(dispute))).sort((a, b) => position(a) - position(b))
    const pending = store.recallPendingChanges(at, scope, PENDING_RECALL_LIMIT + 1)
    const pendingMatches = recallCandidates(availablePending(scope, asOf, at, undefined, pending.slice(0, PENDING_RECALL_LIMIT)), request.query, 6)
    const limit = notes ? dailySearchLimit(request.limit) : 5
    const dailyRanks = notes ? rankDailyMemory(dailyDocuments(request, origin, selected.current, interval, at), request.query,
      limit, request.min_score ?? defaults.searchMinScore, semanticResult?.scores) : undefined
    const hits = dailyRanks?.hits ?? standardDirect.map(memory => ({ document: { memory }, semantic: !keywordIds.has(memory.id) }))
    const direct = hits.flatMap(({ document }) => 'memory' in document ? [document.memory] : [])
    const orderedHits = hits.slice(0, limit).values()
    const stopRelationsAt = performance.now() + 40
    const relationScopes = scope && scope.kind !== 'user' ? [scope, USER] : [USER]
    const roots = memoryRelationQueryLabels(request.query).flatMap(label => relationScopes.map(scope => ({ scope, label })))
    const relations = expandMemoryRelations({ roots, neighbors: ({ scope, label }: MemoryRelationEntity) => {
      const refs = store.relationRecallRefs(scope, label, interval, RELATION_NEIGHBOR_LIMIT + 1)
      const selected = reader.select(refs.slice(0, RELATION_NEIGHBOR_LIMIT))
      return { entries: selected.current, partial: refs.length > RELATION_NEIGHBOR_LIMIT || selected.held }
    }, seeds: direct, interval, deep: request.deep, limit, retainWindows: !asOf,
    evidenceAvailable: edge => !evidenceBlocked(edge),
    shouldStop: () => performance.now() >= stopRelationsAt })
    const operation = origin.turn ?? origin.foregroundTurn
    const currentTurn = operation && origin.session === request.session ? clarifications.track(request.session, operation) : undefined
    const turn = origin.foregroundTurn ? currentTurn : undefined
    if (asOf && currentTurn && currentTurn.incompleteDates.size <= 8) {
      currentTurn.incompleteDates.add(asOf)
    }
    const nextRef = () => turn && turn.refs.size < 50 ? randomUUID() : undefined
    const observe = (reference: ClarificationReference) => {
      currentTurn?.observed.set(JSON.stringify(reference), reference)
    }
    const identifiers = memoryIdentifierTokens(request.query)
    const matchedIdentifiers = new Set([...direct, ...relatedEntries].flatMap(entry => memoryIdentifierTokens(modelText(entry))))
    const reasons = [
      ...(identifiers.length > 1 && identifiers.some(id => !matchedIdentifiers.has(id)) ? ['identifier-coverage'] : []),
      ...((held || semanticRows.held) && !semanticResult?.reasons.includes('source-withdrawal-pending') ? ['source-withdrawal-pending'] : []),
      ...(index?.truncated ? ['full-text-limit'] : index === null ? ['full-text-unavailable'] : []),
      ...semanticResult?.reasons ?? [],
      ...(fallbackLimited ? ['keyword-fallback-limit'] : []),
      ...(found.partial || related.partial || pendingMatches.partial ? ['partial-keyword-match'] : []),
      ...((dailyRanks?.partial ?? hits.length > limit) ? ['memory-limit'] : []),
      ...(matches.length > limit || relatedEntries.length > limit ? ['dispute-limit'] : []),
      ...(pendingMatches.found.length > limit || pending.length > PENDING_RECALL_LIMIT ? ['pending-change-limit'] : []),
      ...(relations.partial ? ['relation-limit'] : []),
      ...(recallsPendingEnding(request, scope, snapshot) ? ['pending-end'] : []),
      ...(recallCandidates(pendingRelations.map(modelEntry), request.query, 1).found.length ? ['pending-relation'] : []),
    ]
    const packet = { status: 'ok', partial: false, reasons, asOf,
      memories: [] as Array<ReturnType<typeof summarize> & { match?: 'semantic' }>, conflicts: [] as ReturnType<typeof conflictPacket>[],
      pendingChanges: [] as ReturnType<typeof pendingPacket>[], relations: [] as NonNullable<ReturnType<typeof relationPacket>>[],
      ...(notes ? { notes: [] as Array<Omit<NotePassage, 'text'> & { markdown: string, score?: number }> } : {}),
    }
    const reads: MemoryDependency[] = []
    // Reserve both reasons before packing. Every item, including a dispute with both sides, travels whole.
    reasons.push('output-budget', 'pending-change', 'relation-evidence-unavailable')
    let room = (request.deep ? MAX_DEEP_RECALL_CHARS : MAX_RECALL_CHARS) - textOf(packet).length
    let limited = false, pendingUnavailable = false, relationUnavailable = false
    function include<T extends object>(items: T[], item: T) {
      const size = textOf(item).length + Number(items.length > 0)
      if (size > room) { limited = true; return false }
      room -= size
      items.push(item)
      return true
    }
    function conflictPacket(dispute: typeof disputes[number], ref: string | undefined) {
      const { sourceId, sourceVersion } = dispute
      const match = dispute.sides.some(side => keywordConflictIds.has(side.id)) ? undefined : 'semantic' as const
      return { ref, match, scope: dispute.sides[0].scope, windows: dispute.windows, sides: dispute.sides.map(summarizeSide),
        evidence: sourceId && sourceVersion !== null ? dispute.spans.flatMap(span => evidenceExcerpt(sourceId, sourceVersion, span, scope)) : [] }
    }
    function pendingPacket(candidate: typeof pendingMatches.found[number], ref: string) {
      return { ref, status: 'provisional', kind: candidate.kind, scope: candidate.target.scope,
        windows: candidate.windows, current: summarizeSide(candidate.target), alternative: candidate.alternative, event: candidate.event }
    }
    function relationPacket(hit: typeof relations.found[number], boundary: number | null) {
      const windows = boundary === null ? hit.windows : hit.windows.flatMap(window => intersect(window, { from: null, to: boundary }) ?? [])
      if (!windows.length) return null
      function side(entry: MemoryEntry) {
        const evidence = []
        for (const { edge, windows: supported } of hit.proofs.get(entry.id) ?? []) {
          const applies = overlapWindows(windows, supported, { from: null, to: null })
          if (!applies.length) continue
          const excerpts = excerptsForEdge(entry, edge, true)
          if (!excerpts) return null
          evidence.push(...excerpts.map(excerpt => ({ ...excerpt, windows: applies })))
        }
        return evidence.length ? { ...summarize(entry), evidence } : null
      }
      const path = hit.path.map(side)
      const evidence = hit.dependencies.filter(entry => !hit.path.some(step => step.id === entry.id)).map(side)
      if (path.some(item => item === null) || evidence.some(item => item === null)) return null
      return { hops: hit.hops, windows, match: hit.entry.id, path, evidence }

    }
    function includeConflict(dispute: typeof disputes[number]) {
      const reference = disputeReference(dispute, scope, asOf)
      observe(reference)
      const ref = nextRef()
      if (!include(packet.conflicts, conflictPacket(dispute, ref))) return
      if (ref) turn?.refs.set(ref, reference)
      for (const { id, revision } of dispute.sides) reads.push({ id, revision, ...dated, disputed: true })
    }
    function includePending(candidate: typeof pendingMatches.found[number]) {
      const { reference } = candidate
      observe(reference)
      const ref = nextRef()
      if (!turn || !ref) {
        pendingUnavailable = true
        return
      }
      if (!include(packet.pendingChanges, pendingPacket(candidate, ref))) return
      turn.refs.set(ref, reference)
      turn.pending.set(JSON.stringify([reference.sourceId, reference.start, reference.end, asOf]), reference)
    }
    function includeNextHit() {
      const hit = orderedHits.next().value
      if (!hit) return
      const score = 'score' in hit ? hit.score : undefined
      if ('memory' in hit.document) {
        const { memory } = hit.document
        const item = { ...summarize(memory), score, match: hit.semantic ? 'semantic' as const : undefined }
        if (notes) packet.memories.push(item)
        if (notes || include(packet.memories, item)) reads.push({ id: memory.id, revision: memory.revision, ...dated })
      } else if (packet.notes && 'passage' in hit.document) {
        const { text: markdown, sourceIds, ...passage } = hit.document.passage
        packet.notes.push({ ...passage, markdown, sourceIds, score })
        noteSourcesUsed?.(request.session, sourceIds)
      }
    }
    for (let index = 0; index < limit; index++) {
      const dispute = matches[index], pending = pendingMatches.found[index], relation = relations.found[index]
      if (dispute) includeConflict(dispute)
      includeNextHit()
      if (pending) includePending(pending)
      if (relation) {
        const revisions = relation.dependencies.map(({ id, revision }) => ({ id, revision, ...dated }))
        const boundary = asOf ? null : dispatchDeadline(revisions, [], at)
        const item = relationPacket(relation, boundary)
        if (!item) { relationUnavailable = true; continue }
        if (!include(packet.relations, item)) continue
        const expires = relation.windows.find(window => covers(window.from, window.to, at))?.to ?? Infinity
        const next = Math.min(boundary ?? Infinity, expires)
        const expiry = !asOf && Number.isFinite(next) ? next : null
        for (const ref of revisions) reads.push(expiry === null ? ref : { ...ref, expiresAt: expiry })
      }
    }
    if (turn && (packet.pendingChanges.length || packet.conflicts.length)) provisionalRead?.(request.session)
    dependencies?.(request.session, reads)
    const finalReasons = reasons.filter(reason => {
      if (reason === 'output-budget') return limited
      if (reason === 'pending-change') return pendingUnavailable
      if (reason === 'relation-evidence-unavailable') return relationUnavailable
      return true
    })
    return textOf({ ...packet, partial: finalReasons.length > 0, reasons: finalReasons })
  }

  function handle(request: MemoryRequest, origin: Origin) {
    if (request.op === 'forget') return textOf({ status: 'rejected', reason: 'Ask the user to use About You or explicitly say “forget #ID”.' })
    const scope = origin.context ?? origin.scope
    if (request.op === 'clarify') return textOf(clarify(request.session, request.ref, origin))
    if (request.op === 'recall') {
      if (request.scope === 'project' && !origin.project) return textOf({ status: 'rejected', reason: 'project-unavailable' })
      const at = now()
      const snapshot = recallSnapshot(request, recallScope(request, origin), at)
      return snapshot ? recallPacket(request, origin, snapshot, at) : textOf({ status: 'rejected', reason: 'invalid-date' })
    }
    if (request.op === 'context') {
      const at = now()
      const interval = { from: at, to: at + 1 }
      const reader = createRecallReader(scope, interval)
      const { found, related } = indexedSelection(request.question, scope, interval, reader, true)
      const activeProject = origin.project && indexedSelection(request.question, origin.project, interval, createRecallReader(origin.project, interval), true)
      const merge = (primary: MemoryEntry[], project: MemoryEntry[] = []) => [...new Map([...primary, ...project].map(entry => [entry.id, entry])).values()]
      const profile = store.profile()
      const pushed = merge(found.found, activeProject?.found.found).map(entry => ({
        memory: entry, names: entry.keywords.filter(name => request.question.includes(name)),
      }))
      const disputed = merge(related.found, activeProject?.related.found)
      const fixed = { profile, user: profileView(USER, at), project: origin.project ? profileView(origin.project, at) : undefined }
      const pulledIds = new Set(pushed.map(({ memory }) => memory.id))
      const separate = (block: ReturnType<typeof profileView>): { generated: boolean, items: ProfileContextItem[] } =>
        ({ ...block, items: block.items.filter(item => !pulledIds.has(item.dependency.id)) })
      const packed = packContext({
        fixed: { profile, user: separate(fixed.user), project: fixed.project && separate(fixed.project) },
        pushed, today: dateLine(new Date(at)), disputed: disputed.length > 0,
        profileLabels: presentation.profileLabels?.(),
      })
      injected?.(request.session, request.turn, packed.pushed.map(({ memory, names }) => ({ text: memory.text, names })))
      dependencies?.(request.session, [
        ...packed.pushed.map(({ memory: { id, revision } }) => ({ id, revision })),
        ...packed.profile.map(({ dependency }) => dependency),
        ...disputed.map(({ id, revision }) => ({ id, revision, disputed: true })),
      ])
      return packed.text
    }
    if (mutation) return textOf({ status: 'rejected', reason: 'memory-change-in-progress' })
    const text = clean(request.text)
    if (statementIsQuestion(text)) return textOf({ status: 'rejected', reason: 'not-an-assertion' })
    const sources = [...(turnSources.get(request.session) ?? [])].reverse().map(store.readSource)
    for (const source of sources) {
      if (!source?.text || source.withdrawn || store.sourceExcluded(source.id)) continue
      if (source.rememberedHash !== memoryHash(text)) continue
      const entry = store.memoriesFrom(source.id).map(store.get).find(item => item && retained(item) && available(item))
      if (source.outcome === 'explicit-pending') return textOf({ status: 'pending' })
      if (source.outcome === 'candidate') return textOf({ status: 'candidate' })
      if (!entry || source.outcome !== 'explicit-accepted') continue
      dependencies?.(request.session, [{ id: entry.id, revision: entry.revision }])
      return textOf({ status: 'accepted', id: entry.id, revision: entry.revision })
    }
    return textOf({ status: 'rejected', reason: 'no-explicit-user-source' })
  }

  function forgetIntent(text: string, scope?: MemoryScope, project?: Origin['project']) {
    const id = INTENT.forget.exec(text)?.[1]
    if (!id) return null
    const entry = store.get(Number(id))
    return entry && (stillAvailable(entry, scope) || project && stillAvailable(entry, project)) ? entry : false
  }
  function finishTurn(session: string | null, _completed = false) {
    if (session) {
      turnSources.delete(session)
      clarifications.finish(session)
    }
    for (const [controller, { current }] of semanticControllers) if (!current()) controller.abort()
    void effects.wake()
  }

  function replaySources(ids: readonly string[], text: string) {
    if (!ids.length || new Set(ids).size !== ids.length) return false
    let offset = 0
    for (const [index, id] of ids.entries()) {
      const source = store.readSource(id)
      if (!source || !sourceCurrent(id)) return false
      if (index > 0) {
        if (!text.startsWith('\n\n', offset)) return false
        offset += 2
      }
      const end = offset + source.length
      if (end > text.length || source.hash !== memoryHash(text.slice(offset, end))) return false
      offset = end
    }
    return offset === text.length
  }

  return {
    accept, bindSource, recordNoteTurn: notes?.record, flushNoteTurns: notes?.flush, handle, handleModelRequest, rebuildIndexes, forgetIntent, clarificationQuestion, computeCurrent, computeAdmission, provisionalReadsCurrent, provisionalDeadline,
    authorizeGeneralQuestion,
    correctionIntent(text: string, scope?: MemoryScope, project?: Origin['project']) {
      const match = CORRECT.exec(text)
      if (!match) return null
      const entry = store.get(Number(match[1]))
      return entry && (stillAvailable(entry, scope) || project && stillAvailable(entry, project)) ? { entry, text: match[2] } : false
    },
    addMemory, editMemory, forget, restore, resolveConflict, resolveConflictPair, listChanges, undoChange, setProfile, dependenciesCurrent, sourceCurrent,
    recordDeliveredSource, isDerivedDelivery: (id: string) => Boolean(store.deliveredSource(id)?.derived), dispatchSourceCurrent, dispatchDeadline,
    replaySource: (id: string, text: string) => replaySources([id], text),
    replaySources,
    async deleteMemory(id: number, revision: number, operation: string = randomUUID()) {
      await forget(id, revision, 'delete', operation)
      return cleanup.status(operation)
    },
    cleanupPending: cleanup.pending,
    projectAllows(evidence: Pick<MemoryProvenance, 'dependencies' | 'sources' | 'projects'>, project?: Origin['project']) {
      const allowed = (scope?: MemoryScope | null) => scope?.kind !== 'project' || Boolean(project && sameScope(scope, project))
      return (evidence.projects ?? []).every(id => id === project?.id) && evidence.dependencies.every(item => {
        const scope = store.get(item.id)?.scope
        if (scope?.kind === 'conversation' && scope.id.includes('@')) return scope.id.split('@').at(-1) === project?.id
        return allowed(scope)
      })
        && evidence.sources.every(id => allowed(store.readSource(id)?.project))
    },
    profile: store.profile, profileView, refreshProfiles: () => profiles?.sync(), revision: store.revision, epoch: store.epoch, recordSession: store.recordSession,
    sessionProject: store.sessionProject,
    recordSessionProject: store.recordSessionProject,
    staleSession: (id: string | null | undefined) => Boolean(id && store.sessionEpoch(id) < store.epoch()),
    finishTurn,
    resetLive() {
      resetSemanticJobs()
      profiles?.resetLive()
      turnSources.clear()
      clarifications.clear()
    },
    busy: () => Boolean(mutation), wake: () => effects.wake(), allowedHistory,
    holdWithdrawal,
    releaseWithdrawal,
    withdraw: (payload: unknown) => withdraw(withdrawalPayload.parse(payload)),
    // Trusted local management adapter only; model tools use their scoped read paths.
    readManagementEntry: store.get,
    listMemories(query = '') {
      const entries = store.list().filter(modelEligible)
      const { current: active } = selection(entries, now())
      return { items: active.filter(entry => entry.text.toLowerCase().includes(query.toLowerCase())).slice(0, READ_LIMIT), total: active.length, invalid: entries.length - active.length }
    },
    listInvalid() {
      const entries = store.list().filter(modelEligible)
      const { current, pendingRelations } = selection(entries, now())
      const active = new Set(current.map(entry => entry.id))
      const pending = new Set(pendingRelations.map(entry => entry.id))
      const byId = new Map(entries.map(entry => [entry.id, entry]))
      const disputed = entries.flatMap(entry => {
        const links = entry.links.flatMap(link => {
          if (link.kind !== 'conflict') return [link]
          const other = byId.get(link.id)
          const dispute = other && disputeBetween(entry, other, link.changeId)
          return dispute ? [{ ...link, revision: other.revision, windows: dispute.windows }] : []
        })
        return links.some(link => link.kind === 'conflict') ? [{ ...entry, links, state: 'disputed' as const }] : []
      })
      const disputeIds = new Set(disputed.map(entry => entry.id))
      return [...disputed, ...entries.filter(entry => !active.has(entry.id) && !disputeIds.has(entry.id)).slice(0, READ_LIMIT)
        .map(entry => pending.has(entry.id) ? { ...entry, pendingRelation: true } : entry)]
    },
    onboarding: () => store.meta('onboarding') ?? 'pending',
    setOnboarding(status: string) {
      if (!['pending', 'done', 'skipped'].includes(status)) throw new Error('invalid onboarding state')
      store.setMeta('onboarding', status)
      return status
    },
    close() { closed = true; profiles?.close(); resetSemanticJobs(); maintenance?.close(); embedder?.close(); clearTimeout(lexicalTimer); effects.close(); store.close() },
  }
}
export type MemoryRuntime = ReturnType<typeof createMemoryRuntime>
