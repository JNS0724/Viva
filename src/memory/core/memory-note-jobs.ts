import type { MemoryRuntimeResources } from './ports/runtime.ts'
import type { ReadSessionRange } from './ports/notes.ts'
import { beginDiagnosticOperation } from '../../diagnostics/operation.ts'
import { guardDiagnosticPort, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort } from '../../diagnostics/contracts.ts'
import { MemoryComputeError } from '../contracts/compute.ts'
import type { Effect, Effects, Outcome } from './ports/effects.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { assembleNoteMarkdown, compareWatermark, NOTE_SYSTEM, noteReply, parseNoteSections, rangeWatermarkKey, WRITE_NOTE } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import type { MemorySessionKind } from '../contracts/records.ts'
import type { MemorySource, MemoryStore } from './ports/store.ts'
import { previousDay, todayAt } from './memory-calendar.ts'
import type { DocumentSourceRef } from './ports/documents.ts'

type Calculate = (job: Effect, source: MemorySource, stage: 'note' | 'dream', system: string, input: object,
  sources: string[], current: () => boolean) => Promise<unknown>

/** Completed-turn daily capture. Document dream is independently orchestrated by memory-dream. */
export function createMemoryNoteJobs({ store, effects, now, openNotes, settings, capture = true, readable, eligible, allowsText, calculate, hash, readSessionRange, diagnostics: providedDiagnostics }: {
  store: MemoryStore, effects: Effects, now: () => number, settings?: DailyMemorySettings, capture?: boolean,
  openNotes: MemoryRuntimeResources['openNotes'],
  readable: (id: string) => boolean,
  eligible: (source: MemorySource) => boolean,
  allowsText: (text: string, source: MemorySource) => boolean,
  calculate: Calculate,
  hash: (text: string) => string,
  readSessionRange?: ReadSessionRange,
  diagnostics?: DiagnosticPort,
}) {
  const diagnostics = guardDiagnosticPort(providedDiagnostics)
  const { timezone, noteInterval } = { ...defaults, ...settings }
  if (!Number.isSafeInteger(noteInterval) || noteInterval < 1) throw new Error('invalid-note-interval')
  const notes = openNotes(readable, (key, generation) => effects.holds({ kind: WRITE_NOTE, key, generation }))
  const sourceOf = (id: string) => {
    const source = store.readSource(id)
    return source?.text && readable(id) && allowsText(source.text, source) ? source : undefined
  }
  const materialAllowed = (texts: readonly (string | null | undefined)[], ids: readonly string[]) => {
    const materialSources = ids.map(sourceOf)
    return materialSources.every((source): source is MemorySource => source !== undefined)
      && texts.every(text => text == null || materialSources.every(source => allowsText(text, source)))
  }
  const schedule = (key: string, flush = false) => {
    const current = effects.get(WRITE_NOTE, key)
    if (!current) effects.queue(WRITE_NOTE, key, flush ? { flush } : null)
    else if (flush && !current.payload) effects.amend(current, { flush })
  }
  const wake = () => { void effects.wake() }

  /**
   * Register a completed turn's persisted DSH range [fromSeq, toSeq) inside the caller's atomic
   * SQLite CAS transaction (never writing session/dialog/*.jsonl).
   */
  function recordRangeInTx(input: {
    session: string
    groupKey?: string
    sessionKind?: MemorySessionKind
    turnAt?: number
    hostDay?: string | null
    fromSeq: number
    toSeq: number
    turn: number
    ids: readonly string[]
    assistant: string
    sourceEventSeqs?: Readonly<Record<string, number>>
    flush?: boolean
  }) {
    if (!capture) return null
    const { session, fromSeq, toSeq, turn, ids, assistant, sourceEventSeqs, flush = false } = input
    const sources = [...new Set(ids)].flatMap(id => {
      const source = sourceOf(id)
      return source?.session === session ? [source] : []
    })
    const source = sources[0]
    if (!source) return null
    const turnAt = input.turnAt ?? sources.at(-1)!.at
    const completionDay = todayAt(turnAt, timezone)
    const effectiveGroupKey = input.groupKey ?? session
    const workspace = hash(JSON.stringify([source.scope, source.context, source.project ?? null]))
    const day = input.sessionKind === 'task'
      && typeof input.hostDay === 'string'
      && input.hostDay === previousDay(completionDay)
      && notes.canAttachHostDay?.(effectiveGroupKey, input.hostDay, workspace) === true
      ? input.hostDay
      : completionDay
    const dependencies = notes.contextSources(session, source, new Set(sources.map(item => item.id)))
    const contextCurrent = dependencies !== null && dependencies.every(id => readable(id))
    const safeAssistant = contextCurrent && assistant && sources.every(item => allowsText(assistant, item)) ? assistant : ''
    const key = notes.addRange({
      session,
      groupKey: effectiveGroupKey,
      sessionKind: input.sessionKind,
      day,
      fromSeq,
      toSeq,
      turn,
      turnAt,
      sources,
      assistantDigest: safeAssistant ? hash(safeAssistant) : null,
      assistantSources: safeAssistant && dependencies ? dependencies : [],
      questionSources: dependencies ?? [],
      questionCurrent: dependencies !== null,
      ...(sourceEventSeqs ? { sourceEventSeqs } : {}),
    })
    if (!key) return null
    const groups = notes.pendingGroups()
    const pendingCount = groups.reduce((sum, group) => sum + group.count, 0)
    const ownGroup = groups.find(group => group.note === key)
    if (flush || (ownGroup?.count ?? 0) >= noteInterval) {
      schedule(key, flush)
    }
    for (const item of notes.pendingKeysForSession?.(session) ?? []) {
      if (item.note !== key && item.day !== day) {
        schedule(item.note, flush)
      }
    }
    diagnostics.emit({ event: 'state.changed', operation: 'memory.daily', stage: 'received',
      identities: { sessionId: session, jobId: key, methodId: timezone }, metrics: { count: sources.length, pendingCount, mark: Date.parse(`${day}T00:00:00Z`) } })
    return key
  }

  function record(session: string, ids: readonly string[], assistant: string) {
    if (!capture) return
    const sources = [...new Set(ids)].flatMap(id => {
      const source = sourceOf(id)
      return source?.session === session ? [source] : []
    })
    const source = sources[0]
    if (!source) return
    const day = todayAt(sources.at(-1)!.at, timezone)
    const dependencies = notes.contextSources(session, source, new Set(sources.map(item => item.id)))
    const contextCurrent = dependencies !== null && dependencies.every(id => readable(id))
    // A generated response may contain protected material or opaque tool
    // metadata. Suppress that copy without discarding independent human input.
    const safeAssistant = contextCurrent && sources.every(item => allowsText(assistant, item)) ? assistant : ''
    const key = notes.add(session, day, sources, safeAssistant, ids[0]!, safeAssistant && dependencies ? dependencies : [], assistant,
      { questionSources: dependencies ?? [], questionCurrent: dependencies !== null })
    if (!key) return
    let pendingCount = 0
    store.tx(() => {
      const groups = notes.pendingGroups()
      pendingCount = groups.reduce((sum, group) => sum + group.count, 0)
      const ownGroup = groups.find(group => group.note === key)
      if ((ownGroup?.count ?? 0) >= noteInterval) schedule(key)
      for (const item of notes.pendingKeysForSession?.(session) ?? []) {
        if (item.note !== key && item.day !== day) schedule(item.note)
      }
    })
    diagnostics.emit({ event: 'state.changed', operation: 'memory.daily', stage: 'received',
      identities: { sessionId: session, jobId: key, methodId: timezone }, metrics: { count: sources.length, pendingCount, mark: Date.parse(`${day}T00:00:00Z`) } })
    wake()
  }

  async function resolveRangeAssistant(
    row: ReturnType<typeof notes.pending>[number],
    verifyRange: boolean,
  ): Promise<{ status: 'ok', text: string } | { status: 'deleted' } | { status: 'unavailable' }> {
    const wantsAssistant = Boolean(row.assistantValid && row.assistantDigest && row.assistantSourceIds.every(readable))
    if (wantsAssistant && row.assistant && hash(row.assistant) === row.assistantDigest) {
      return { status: 'ok', text: row.assistant }
    }
    if (row.fromSeq >= row.toSeq || !readSessionRange) {
      return { status: 'ok', text: '' }
    }
    if (!verifyRange && !wantsAssistant) {
      return { status: 'ok', text: '' }
    }
    const fetched = await readSessionRange({
      sessionId: row.session,
      fromSeq: row.fromSeq,
      toSeq: row.toSeq,
      sessionKind: row.sessionKind,
    })
    if (fetched.status === 'deleted' || fetched.status === 'unavailable') return fetched
    if (!wantsAssistant) return { status: 'ok', text: '' }
    const verified = fetched.assistant && hash(fetched.assistant) === row.assistantDigest ? fetched.assistant : ''
    return { status: 'ok', text: verified }
  }

  async function write(job: Effect): Promise<Outcome> {
    if (notes.needsRecovery()) notes.recover()
    if (notes.jobState(job.key, job.generation) === 'done') {
      // The durable receipt/checkpoint may have committed just before the process died.
      // Remaining turns belong to a NEW operation, never reuse the completed generation.
      store.tx(() => {
        effects.finishGeneration(job)
        const remaining = notes.pendingGroups().find(group => group.note === job.key)
        const flush = Boolean(job.payload) || Boolean(remaining && remaining.day !== todayAt(now(), timezone))
        if (remaining && (flush || remaining.count >= noteInterval)) schedule(job.key, flush)
      })
      wake()
      return 'done'
    }
    if (notes.jobState(job.key, job.generation) === 'cancelled') {
      store.tx(() => {
        if (!effects.holds(job)) return
        effects.finishGeneration(job)
        schedule(job.key, true)
      })
      wake()
      return 'done'
    }
    if (notes.jobState(job.key, job.generation) === 'conflict') return 'wait'
    if (notes.blocked(job.key)) return 'wait'
    const existing = notes.read(job.key)
    if (existing?.enabled === false) return 'wait'
    // A registered but unavailable file awaits external verification; it is not a new empty card.
    if (!existing && notes.registered().some(note => note.key === job.key)) return 'wait'
    const rawRows = notes.pending(job.key, noteInterval)
    if (!rawRows.length) return 'done'
    const priorRefs = existing ? notes.references(job.key) : []
    const priorSources = priorRefs.map(ref => ref.id)
    if (priorSources.some(id => !readable(id))) return 'wait'
    const readablePrefix: typeof rawRows = []
    let blockedOnReadable = false
    for (const row of rawRows) {
      if (!row.sourceIds.every(readable)) {
        blockedOnReadable = true
        break
      }
      readablePrefix.push(row)
    }
    if (!readablePrefix.length) return blockedOnReadable ? 'wait' : 'done'

    // Resolve persisted assistant text on demand via readSessionRange with per-range fault isolation (§4.1.4):
    // - confirmed `deleted` ranges are retired immediately in an independent transaction;
    // - transient `unavailable` stops the batch without starving healthy ranges sorted before it.
    const deletedRows: typeof rawRows = []
    const activeRows: typeof rawRows = []
    const assistantByRange = new Map<string, string>()
    let hitUnavailable = false
    for (const row of readablePrefix) {
      const fetched = await resolveRangeAssistant(row, true)
      if (fetched.status === 'deleted') {
        deletedRows.push(row)
        continue
      }
      if (fetched.status === 'unavailable') {
        hitUnavailable = true
        break
      }
      assistantByRange.set(row.id, fetched.text)
      activeRows.push(row)
    }
    if (deletedRows.length > 0) {
      store.tx(() => {
        notes.finish(deletedRows, false)
      })
    }
    let rows = activeRows
    if (!rows.length) {
      if (hitUnavailable) return 'retry'
      if (blockedOnReadable) return 'wait'
      store.tx(() => {
        effects.finishGeneration(job)
        if (notes.pending(job.key, noteInterval).length) schedule(job.key, Boolean(job.payload))
      })
      wake()
      return 'done'
    }

    // Split mixed batches crossing `watermark` into two steps (§4.1.3):
    // late out-of-order rows (`pos <= watermark`) run first with `freezeState = true`,
    // while newer rows remain pending for the immediately scheduled follow-up generation.
    const existingWatermarkAt = existing?.stateWatermarkAt ?? 0
    const existingWatermarkKey = existing?.stateWatermarkKey ?? ''
    const hasWatermark = Boolean(existing && (existingWatermarkAt > 0 || existingWatermarkKey !== ''))
    let lateCount = 0
    if (hasWatermark && existing) {
      while (
        lateCount < rows.length
        && compareWatermark(
          rows[lateCount]!.turnAt,
          rangeWatermarkKey(rows[lateCount]!.session, rows[lateCount]!.toSeq),
          existingWatermarkAt,
          existingWatermarkKey,
        ) <= 0
      ) {
        lateCount++
      }
      if (lateCount > 0 && lateCount < rows.length) {
        rows = rows.slice(0, lateCount)
      }
    }
    const freezeState = lateCount > 0
    const partialBatch = (hasWatermark && lateCount > 0 && lateCount < activeRows.length)
      || hitUnavailable
      || blockedOnReadable

    const projectTurns = (inputRows: typeof rows) => inputRows.map(row => {
      const sources = row.sourceIds.flatMap(id => sourceOf(id) ?? [])
      const assistantAllowed = row.assistantSourceIds.every(readable)
      const fetchedAssistant = assistantByRange.get(row.id) ?? ''
      const hasDirectQuestionMeta = typeof store.updateSourceQuestionContext === 'function'
      const user = sources.flatMap(source => {
        const ref = notes.snapshot([source.id])[0]!
        const directRefs = hasDirectQuestionMeta ? (source.questionSources ?? []) : undefined
        const questionDepIds = directRefs ? directRefs.map(dep => dep.id) : row.questionSourceIds
        const questionBaseValid = directRefs ? Boolean(source.questionValid) : row.questionCurrent
        const questionAllowed = Boolean(source.question) && questionBaseValid && questionDepIds.every(id => {
          if (!readable(id)) return false
          if (!directRefs) return true
          const expected = directRefs.find(dep => dep.id === id)
          if (!expected) return true
          try {
            return notes.snapshot([id])[0]?.token === expected.token
          } catch {
            return false
          }
        })
        // Separate validation for human answer text vs. revocable question text (§5.3 item 3):
        // revoking a question-only prerequisite withholds ONLY `question` without discarding a valid custom answer.
        if (!source.text?.trim()) return []
        return [{ source, ref, text: source.text, question: questionAllowed ? source.question : null, questionDepIds: questionAllowed ? questionDepIds : [] }]
      })
      return { row, user, assistant: assistantAllowed && user.length && fetchedAssistant && sources.every(source => allowsText(fetchedAssistant, source)) ? fetchedAssistant : '' }
    })
    const turns = projectTurns(rows)
    const sources = turns.flatMap(turn => turn.user.map(item => item.source))
    if (!sources.length) {
      store.tx(() => {
        const flush = Boolean(effects.get(WRITE_NOTE, job.key)?.payload) || partialBatch
        notes.finish(rows, false)
        effects.finishGeneration(job)
        const remainder = notes.pending(job.key, noteInterval)
        if (remainder.length && (flush || remainder.length >= noteInterval)) schedule(job.key, flush)
      })
      wake()
      return 'done'
    }
    if (sources.some(source => !eligible(source))) return 'wait'
    const previousAssistantByRange = new Map<string, string | null>()
    const previousDeps: string[] = []
    const previousContributedIds: string[] = []
    const seenSessionInBatch = new Set<string>()
    for (const turn of turns) {
      if (seenSessionInBatch.has(turn.row.session)) {
        previousAssistantByRange.set(turn.row.id, null)
        continue
      }
      seenSessionInBatch.add(turn.row.session)
      const lastTurn = notes.previous(job.key, turn.row.id)
      let prevText: string | null = null
      if (lastTurn && [...lastTurn.sourceIds, ...lastTurn.assistantSourceIds].every(readable)) {
        const fetchedPrev = await resolveRangeAssistant(lastTurn, false)
        if (fetchedPrev.status === 'unavailable') return 'retry'
        if (fetchedPrev.status === 'ok' && fetchedPrev.text && sources.every(source => allowsText(fetchedPrev.text, source))) {
          prevText = fetchedPrev.text
          previousContributedIds.push(...lastTurn.sourceIds)
          previousDeps.push(...lastTurn.sourceIds, ...lastTurn.assistantSourceIds)
        }
      }
      previousAssistantByRange.set(turn.row.id, prevText)
    }
    const assistantIds = [...new Set([
      ...turns.flatMap(turn => [
        ...(turn.assistant ? [...turn.row.sourceIds, ...turn.row.assistantSourceIds] : []),
        ...turn.user.flatMap(item => item.question ? item.questionDepIds : []),
      ]),
      ...previousDeps,
    ])]
    const contributedIds = new Set([
      ...priorRefs.filter(ref => !ref.dependencyOnly).map(ref => ref.id),
      ...turns.flatMap(turn => turn.user.map(item => item.source.id)),
      ...previousContributedIds,
    ])
    const related = [...new Set([...sources.map(source => source.id), ...priorSources, ...assistantIds])]
    const versions = notes.snapshot(related)
    const used = new Map<string, DocumentSourceRef>()
    const add = (ref: DocumentSourceRef) => {
      const old = used.get(ref.id)
      const dependencyOnly = !contributedIds.has(ref.id)
      const spans = !old ? ref.spans : (old.spans && ref.spans ? [...old.spans, ...ref.spans] : undefined)
      used.set(ref.id, {
        id: ref.id,
        token: ref.token,
        ...(spans ? { spans } : {}),
        ...(dependencyOnly ? { dependencyOnly: true } : {}),
      })
    }
    for (const ref of [...priorRefs, ...turns.flatMap(turn => turn.user.map(item => item.ref)), ...notes.snapshot(assistantIds)]) add(ref)
    const refs = versions.map(ref => used.get(ref.id)!)
    const existingParsed = existing ? parseNoteSections(existing.markdown) : undefined
    const input = {
      existing: existing && existingParsed
        ? {
            title: existing.title,
            state: existingParsed.state,
            recentEvents: existingParsed.eventLines.slice(-20),
          }
        : undefined,
      ...(freezeState ? { freezeState: true as const } : {}),
      turns: turns.map(({ row, user, assistant }) => ({
        sessionKind: row.sessionKind,
        previousAssistant: previousAssistantByRange.get(row.id) ?? null,
        user: user.map(({ source, text, question }) => ({
          sourceId: source.id,
          text,
          author: source.author,
          ...(source.sourceKind ? { sourceKind: source.sourceKind } : {}),
          version: source.version,
          question,
          at: source.at,
        })),
        assistant,
      })),
    }
    // Validate all text actually sent and stored, including stored documents and question context.
    const material = [
      existing?.title,
      existing?.markdown,
      input.existing?.state,
      ...(input.existing?.recentEvents ?? []),
      ...input.turns.flatMap(turn => [turn.previousAssistant, turn.assistant, ...turn.user.flatMap(user => [user.text, user.question])]),
    ]
    const current = () => {
      const latest = notes.read(job.key)
      return latest?.fileRevision === existing?.fileRevision && latest?.revision === existing?.revision
        && latest?.stateWatermarkAt === existing?.stateWatermarkAt && latest?.stateWatermarkKey === existing?.stateWatermarkKey
        && related.every(readable) && JSON.stringify(notes.snapshot(related)) === JSON.stringify(versions)
        && materialAllowed(material, related)
    }
    if (!current()) return 'wait'
    const result = await calculate(job, sources[0]!, 'note', NOTE_SYSTEM, input, related, current)
    if (result === undefined) return 'wait'
    const reply = noteReply.parse(result)
    if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return 'retry'
    let commitReply: Parameters<typeof notes.commit>[2] = { status: 'skip' }
    let commitWatermark: { at: number, key: string } | undefined
    if (reply.status === 'write' && (!freezeState || reply.events.length > 0)) {
      const rawOutput = freezeState ? [...reply.events] : [reply.title, reply.state, ...reply.events]
      if (rawOutput.length && sources.some(source => !allowsText(rawOutput.join('\n'), source))) return 'retry'
      const finalTitle = freezeState ? existing!.title : reply.title
      const lastRow = rows.at(-1)!
      const assembled = assembleNoteMarkdown({
        existingMarkdown: existing?.markdown,
        title: finalTitle,
        state: reply.state,
        events: reply.events,
        turnAt: rows.length === 1 ? lastRow.turnAt : undefined,
        timezone,
        freezeState,
      })
      if (sources.some(source => !allowsText(`${finalTitle}\n${assembled.markdown}`, source))) return 'retry'
      commitReply = { status: 'write', title: finalTitle, markdown: assembled.markdown }
      commitWatermark = freezeState && existing
        ? { at: existingWatermarkAt, key: existingWatermarkKey }
        : { at: lastRow.turnAt, key: rangeWatermarkKey(lastRow.session, lastRow.toSeq) }
    }
    const commit = () => {
      if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return false
      if (partialBatch && !effects.get(WRITE_NOTE, job.key)?.payload && !effects.amend(job, { flush: true })) return false
      return notes.commit(job.key, rows, commitReply, job.generation, now(), refs, existing, commitWatermark)
    }
    if (!commit()) {
      store.tx(() => { effects.finishGeneration(job); schedule(job.key, true) })
      wake()
      return 'done'
    }
    store.tx(() => {
      const flush = Boolean(effects.get(WRITE_NOTE, job.key)?.payload)
        || rows[0]!.day !== todayAt(now(), timezone)
        || partialBatch
      effects.finishGeneration(job)
      const remainder = notes.pending(job.key, noteInterval)
      if (remainder.length && (flush || remainder.length >= noteInterval)) schedule(job.key, flush)
    })
    diagnostics.emit({ event: 'operation.progress', operation: 'memory.daily', stage: 'checkpoint',
      identities: { jobId: job.key, generation: job.generation }, metrics: { count: rows.length, completedCount: sources.length, ok: commitReply.status === 'write' } })
    wake()
    return 'done'
  }

  const run = (job: (effect: Effect) => Promise<Outcome>) => async (jobs: readonly Effect[]) => {
    const outcomes = new Map<string, Outcome>()
    for (const effect of jobs) {
      const observation = beginDiagnosticOperation(diagnostics, 'memory.daily', {
        stage: effect.attempts ? 'recovering' : 'running', identities: { jobId: effect.key, generation: effect.generation }, metrics: { attempt: effect.attempts } })
      try {
        const outcome = await job(effect)
        outcomes.set(effect.key, outcome)
        const isRetry = outcome === 'retry' || (typeof outcome === 'object' && outcome.kind === 'retry')
        const isWait = outcome === 'wait' || (typeof outcome === 'object' && outcome.kind === 'defer')
        observation.end(isRetry ? 'failed' : 'completed', {
          stage: isWait ? 'waiting' : isRetry ? 'queued' : 'checkpoint',
          reason: isRetry ? 'retry' : isWait ? 'external_wake' : 'normal' })
      } catch (error) {
        if (error instanceof MemoryComputeError && error.reason === 'deferred') {
          const delayMs = error.retryAfterMs ?? 3_000
          observation.end('completed', { stage: 'waiting', reason: 'external_wake' })
          diagnostics.emit({ event: 'operation.progress', operation: 'memory.daily', stage: 'waiting', reason: 'external_wake',
            identities: { jobId: effect.key, generation: effect.generation }, metrics: { attempt: effect.attempts, retryDelayMs: delayMs } })
          outcomes.set(effect.key, { kind: 'defer', delayMs })
          continue
        }
        const retryAfterMs = error instanceof MemoryComputeError ? error.retryAfterMs : undefined
        const retryOutcome: Outcome = retryAfterMs !== undefined
          ? { kind: 'retry', delayMs: retryAfterMs, cooldown: true }
          : 'retry'
        const delayMs = retryAfterMs ?? Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** effect.attempts)
        observation.fail(error)
        diagnostics.emit({ event: 'operation.progress', operation: 'memory.daily', stage: 'queued', reason: safeDiagnosticReason(error),
          identities: { jobId: effect.key, generation: effect.generation }, metrics: { attempt: effect.attempts, retryDelayMs: delayMs } })
        outcomes.set(effect.key, retryOutcome)
      }
    }
    return outcomes
  }
  effects.runs(WRITE_NOTE, run(write), attempts => Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** attempts))
  store.tx(() => {
    for (const group of notes.pendingGroups()) schedule(group.note, true)
  })
  return {
    record,
    recordRangeInTx,
    storage: notes,
    read: notes.read,
    sources: notes.sources,
    list: notes.list,
    flush(session?: string) {
      store.tx(() => {
        if (session) {
          for (const item of notes.pendingKeysForSession?.(session) ?? []) schedule(item.note, true)
          return
        }
        for (const group of notes.pendingGroups()) schedule(group.note, true)
      })
      wake()
    },
  }
}
