import type { MemoryRuntimeResources } from './ports/runtime.ts'
import type { ReadSessionRange } from './ports/notes.ts'
import { beginDiagnosticOperation } from '../../diagnostics/operation.ts'
import { guardDiagnosticPort, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort } from '../../diagnostics/contracts.ts'
import { MemoryComputeError } from '../contracts/compute.ts'
import type { Effect, Effects, Outcome } from './ports/effects.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { NOTE_SYSTEM, WRITE_NOTE, noteReply } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import type { MemorySource, MemoryStore } from './ports/store.ts'
import { todayAt } from './memory-calendar.ts'
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
    fromSeq: number
    toSeq: number
    turn: number
    ids: readonly string[]
    assistant: string
    flush?: boolean
  }) {
    if (!capture) return null
    const { session, fromSeq, toSeq, turn, ids, assistant, flush = false } = input
    const sources = [...new Set(ids)].flatMap(id => {
      const source = sourceOf(id)
      return source?.session === session ? [source] : []
    })
    const source = sources[0]
    if (!source) return null
    const day = todayAt(sources.at(-1)!.at, timezone)
    const dependencies = notes.contextSources(session, source)
    const contextCurrent = dependencies.every(id => readable(id))
    const safeAssistant = contextCurrent && assistant && sources.every(item => allowsText(assistant, item)) ? assistant : ''
    const key = notes.addRange({
      session, day, fromSeq, toSeq, turn, sources,
      assistantDigest: safeAssistant ? hash(safeAssistant) : null,
      assistantSources: safeAssistant ? dependencies : [],
      questionSources: dependencies,
      questionCurrent: contextCurrent,
    })
    if (!key) return null
    let pendingCount = 0
    for (const group of notes.pendingGroups()) {
      pendingCount += group.count
      if (group.session === session && (flush || group.day !== day || group.count >= noteInterval)) {
        schedule(group.note, flush)
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
    const dependencies = notes.contextSources(session, source)
    const contextCurrent = dependencies.every(id => readable(id))
    // A generated response may contain protected material or opaque tool
    // metadata. Suppress that copy without discarding independent human input.
    const safeAssistant = contextCurrent && sources.every(item => allowsText(assistant, item)) ? assistant : ''
    const key = notes.add(session, day, sources, safeAssistant, ids[0]!, safeAssistant ? dependencies : [], assistant,
      { questionSources: dependencies, questionCurrent: contextCurrent })
    if (!key) return
    let pendingCount = 0
    store.tx(() => {
      for (const group of notes.pendingGroups()) {
        pendingCount += group.count
        if (group.session === session && (group.day !== day || group.count >= noteInterval)) schedule(group.note)
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
    const fetched = await readSessionRange({ sessionId: row.session, fromSeq: row.fromSeq, toSeq: row.toSeq })
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
    if (rawRows.some(row => !row.sourceIds.every(readable)) || priorSources.some(id => !readable(id))) return 'wait'

    // Resolve persisted assistant text on demand via readSessionRange (§5.2 item 4).
    const deletedRows: typeof rawRows = []
    const activeRows: typeof rawRows = []
    const assistantByRange = new Map<string, string>()
    for (const row of rawRows) {
      const fetched = await resolveRangeAssistant(row, true)
      if (fetched.status === 'unavailable') return 'retry'
      if (fetched.status === 'deleted') {
        deletedRows.push(row)
        continue
      }
      assistantByRange.set(row.id, fetched.text)
      activeRows.push(row)
    }
    if (deletedRows.length > 0) {
      store.tx(() => {
        notes.finish(deletedRows, false)
      })
    }
    const rows = activeRows
    if (!rows.length) {
      store.tx(() => {
        effects.finishGeneration(job)
        if (notes.pending(job.key, noteInterval).length) schedule(job.key, Boolean(job.payload))
      })
      wake()
      return 'done'
    }

    const projectTurns = (inputRows: typeof rows) => inputRows.map(row => {
      const sources = row.sourceIds.flatMap(id => sourceOf(id) ?? [])
      const assistantAllowed = row.assistantSourceIds.every(readable)
      const fetchedAssistant = assistantByRange.get(row.id) ?? ''
      const user = sources.flatMap(source => {
        const ref = notes.snapshot([source.id])[0]!
        const questionAllowed = Boolean(source.question) && row.questionCurrent && row.questionSourceIds.every(readable)
        // Separate validation for human answer text vs. revocable question text (§5.3 item 3):
        // revoking a question-only prerequisite withholds ONLY `question` without discarding a valid custom answer.
        if (!source.text?.trim()) return []
        return [{ source, ref, text: source.text, question: questionAllowed ? source.question : null }]
      })
      return { row, user, assistant: assistantAllowed && user.length && fetchedAssistant && sources.every(source => allowsText(fetchedAssistant, source)) ? fetchedAssistant : '' }
    })
    const turns = projectTurns(rows)
    const sources = turns.flatMap(turn => turn.user.map(item => item.source))
    if (!sources.length) {
      store.tx(() => {
        notes.finish(rows, false)
        effects.finishGeneration(job)
        if (notes.pending(job.key, noteInterval).length) schedule(job.key, Boolean(job.payload))
      })
      wake()
      return 'done'
    }
    if (sources.some(source => !eligible(source))) return 'wait'
    const lastTurn = notes.previous(job.key, rows[0]!.id)
    let previousAssistant: string | null = null
    if (lastTurn && [...lastTurn.sourceIds, ...lastTurn.assistantSourceIds].every(readable)) {
      const fetchedPrev = await resolveRangeAssistant(lastTurn, false)
      if (fetchedPrev.status === 'unavailable') return 'retry'
      if (fetchedPrev.status === 'ok' && fetchedPrev.text && sources.every(source => allowsText(fetchedPrev.text, source))) {
        previousAssistant = fetchedPrev.text
      }
    }
    const assistantIds = [...new Set([...turns.flatMap(turn => [
      ...(turn.assistant ? [...turn.row.sourceIds, ...turn.row.assistantSourceIds] : []),
      ...(turn.user.some(item => item.question) ? turn.row.questionSourceIds : []),
    ]),
      ...(previousAssistant ? [...lastTurn!.sourceIds, ...lastTurn!.assistantSourceIds] : [])])]
    const related = [...new Set([...sources.map(source => source.id), ...priorSources, ...assistantIds])]
    const versions = notes.snapshot(related)
    const used = new Map<string, DocumentSourceRef>()
    const add = (ref: DocumentSourceRef) => {
      const old = used.get(ref.id)
      used.set(ref.id, !old ? ref : { ...ref, spans: old.spans && ref.spans ? [...old.spans, ...ref.spans] : undefined })
    }
    for (const ref of [...priorRefs, ...turns.flatMap(turn => turn.user.map(item => item.ref)), ...notes.snapshot(assistantIds)]) add(ref)
    const refs = versions.map(ref => used.get(ref.id)!)
    const input = {
      existing: existing ? { title: existing.title, markdown: existing.markdown } : undefined,
      previousAssistant,
      turns: turns.map(({ user, assistant }) => ({
        user: user.map(({ source, text, question }) => ({ sourceId: source.id, text, author: source.author, version: source.version,
          question, at: source.at })),
        assistant,
      })),
    }
    // Validate all text actually sent, including stored documents and question context, not only new sources.
    const material = [input.existing?.title, input.existing?.markdown, input.previousAssistant,
      ...input.turns.flatMap(turn => [turn.assistant, ...turn.user.flatMap(user => [user.text, user.question])])]
    const current = () => {
      const latest = notes.read(job.key)
      return latest?.fileRevision === existing?.fileRevision && latest?.revision === existing?.revision
        && related.every(readable) && JSON.stringify(notes.snapshot(related)) === JSON.stringify(versions)
        && materialAllowed(material, related)
    }
    if (!current()) return 'wait'
    const result = await calculate(job, sources[0]!, 'note', NOTE_SYSTEM, input, related, current)
    if (result === undefined) return 'wait'
    const reply = noteReply.parse(result)
    if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return 'retry'
    const output = reply.status === 'write' ? [reply.title, reply.markdown, reply.filename ?? ''] : []
    if (output.length && sources.some(source => !allowsText(output.join('\n'), source))) return 'retry'
    const commit = () => {
      if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return false
      return notes.commit(job.key, rows, reply, job.generation, now(), refs, existing)
    }
    if (!commit()) {
      store.tx(() => { effects.finishGeneration(job); schedule(job.key, true) })
      wake()
      return 'done'
    }
    store.tx(() => {
      const flush = Boolean(effects.get(WRITE_NOTE, job.key)?.payload) || rows[0]!.day !== todayAt(now(), timezone)
      effects.finishGeneration(job)
      const remainder = notes.pending(job.key, noteInterval)
      if (remainder.length && (flush || remainder.length >= noteInterval)) schedule(job.key, flush)
    })
    diagnostics.emit({ event: 'operation.progress', operation: 'memory.daily', stage: 'checkpoint',
      identities: { jobId: job.key, generation: job.generation }, metrics: { count: rows.length, completedCount: sources.length, ok: reply.status === 'write' } })
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
        for (const group of notes.pendingGroups()) if (!session || group.session === session) schedule(group.note, true)
      })
      wake()
    },
  }
}
