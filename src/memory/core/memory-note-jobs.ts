import type { MemoryRuntimeResources } from './ports/runtime.ts'
import { beginDiagnosticOperation } from '../../diagnostics/operation.ts'
import { guardDiagnosticPort, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import type { DiagnosticPort } from '../../diagnostics/contracts.ts'
import type { Effect, Effects, Outcome } from './ports/effects.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../contracts/memory-daily-defaults.ts'
import { NOTE_SYSTEM, WRITE_NOTE, noteReply } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import type { MemoryProvenance, MemorySource, MemoryStore } from './ports/store.ts'
import { todayAt } from './memory-calendar.ts'
import type { DocumentSourceCut, DocumentSourceRef } from './ports/documents.ts'
import type { MemorySpan } from '../contracts/memory-contract.ts'

const DAILY = 'daily'
type Calculate = (job: Effect, source: MemorySource, stage: 'note' | 'dream', system: string, input: object,
  sources: string[], current: () => boolean) => Promise<unknown>

/** Completed-turn daily capture. Document dream is independently orchestrated by memory-dream. */
export function createMemoryNoteJobs({ store, effects, now, openNotes, settings, capture = true, readable, eligible, allowsText, allowsDerived = () => true, allowsReferences = () => true, projectSource = source => ({ text: source.text ?? '' }), projectText = (_workspace, text) => text, assistantContextCurrent, calculate, mutate = async work => work(), diagnostics: providedDiagnostics }:  {
  store: MemoryStore, effects: Effects, now: () => number, settings?: DailyMemorySettings, capture?: boolean,
  openNotes: MemoryRuntimeResources['openNotes'],
  readable: (id: string) => boolean,
  eligible: (source: MemorySource) => boolean,
  allowsText: (text: string, source: MemorySource) => boolean,
  /** Unmapped summaries may not be sent while any of their evidence fragments is disabled. */
  allowsDerived?: (ids: readonly string[]) => boolean,
  allowsReferences?: (refs: readonly DocumentSourceRef[]) => boolean,
  projectSource?: (source: MemorySource, ref: DocumentSourceRef) => { text: string, spans?: MemorySpan[] },
  projectText?: (workspace: string, text: string) => string,
  assistantContextCurrent: (context: MemoryProvenance) => boolean,
  calculate: Calculate,
  mutate?: <T>(write: () => T) => Promise<T>,
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
  function record(session: string, ids: readonly string[], assistant: string) {
    if (!capture) return
    const sources = [...new Set(ids)].flatMap(id => {
      const source = sourceOf(id)
      return source?.session === session ? [source] : []
    })
    const source = sources[0]
    if (!source) return
    const day = todayAt(sources.at(-1)!.at, timezone)
    const seen = store.dispatch.snapshot(session)
    const dependencies = [...new Set([...notes.contextSources(session, source), ...seen.sources])]
    // Assistant replies may restate any context the session saw. Keep that provenance, never promote the reply to independent evidence.
    // This capture stores source IDs, not the precise ranges a file read may
    // have proved. Do not widen a surviving fragment into whole-source proof.
    const contextCurrent = assistantContextCurrent(seen) && allowsDerived(dependencies) && dependencies.every(id => readable(id))
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

  async function write(job: Effect): Promise<Outcome> {
    // Retrying computation is read-only until a real file intent or cleanup needs recovery.
    // Entering the physical send fence without such work aborts unrelated foreground requests.
    if (notes.needsRecovery()) await mutate(() => notes.recover())
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
    const requestedRebuild = Boolean(job.payload && typeof job.payload === 'object' && 'rebuild' in job.payload && job.payload.rebuild === true)
    if (notes.jobState(job.key, job.generation) === 'cancelled') {
      store.tx(() => {
        if (!effects.holds(job)) return
        effects.finishGeneration(job)
        if (requestedRebuild) queueRebuild(job.key)
        else schedule(job.key, true)
      })
      wake()
      return 'done'
    }
    if (notes.jobState(job.key, job.generation) === 'conflict') return 'wait'
    if (notes.blocked(job.key)) return 'wait'
    const existing = notes.read(job.key)
    // A registered but unavailable file awaits external verification; it is not a new empty card.
    if (!existing && notes.registered().some(note => note.key === job.key)) return 'wait'
    const rebuilding = Boolean(existing && !allowsReferences(notes.references(job.key)))
      || requestedRebuild
    const rows = rebuilding ? notes.rebuildRows(job.key) : notes.pending(job.key, noteInterval)
    if (!rows.length) return 'done'
    const workspace = rows[0]!.workspace, policyToken = notes.usePolicyToken(workspace)
    const policyCurrent = () => notes.usePolicyToken(workspace) === policyToken
    const priorRefs = existing && !rebuilding ? notes.references(job.key) : []
    const priorSources = priorRefs.map(ref => ref.id)
    if (rows.some(row => !row.sourceIds.every(readable)) || priorSources.some(id => !readable(id))) return 'wait'
    const projectTurns = (inputRows: typeof rows) => inputRows.map(row => {
      const sources = row.sourceIds.flatMap(id => sourceOf(id) ?? [])
      const assistantAllowed = allowsDerived([...row.sourceIds, ...row.assistantSourceIds])
      const user = sources.flatMap(source => {
        const ref = notes.snapshot([source.id])[0]!
        const projection = projectSource(source, ref)
        const questionAllowed = Boolean(source.question) && row.questionCurrent
          && allowsDerived(row.questionSourceIds) && projection.text === source.text
        if (!projection.text.trim() || (source.author === 'answer' && !questionAllowed)) return []
        return [{ source, ref: { ...ref, spans: projection.spans }, text: projection.text, question: questionAllowed ? source.question : null }]
      })
      return { row, user, assistant: assistantAllowed && user.length && sources.every(source => allowsText(row.assistant, source)) ? row.assistant : '' }
    })
    const turns = projectTurns(rows)
    const sources = turns.flatMap(turn => turn.user.map(item => item.source))
    if (!sources.length) {
      if (rebuilding) {
        const ids = [...new Set(rows.flatMap(row => row.sourceIds))]
        const versions = JSON.stringify(notes.snapshot(ids)), priorRows = JSON.stringify(rows)
        if (!await mutate(() => {
          const current = notes.read(job.key), latestRows = notes.rebuildRows(job.key)
          // A restored source/question permission can make an empty projection useful again
          // while physical requests drain. Never delete using that stale empty decision.
          if (!effects.holds(job) || !policyCurrent() || current?.fileRevision !== existing?.fileRevision || current?.revision !== existing?.revision
            || !ids.every(readable) || JSON.stringify(notes.snapshot(ids)) !== versions || JSON.stringify(latestRows) !== priorRows
            || projectTurns(latestRows).some(turn => turn.user.length > 0)) return false
          return notes.commit(job.key, latestRows, { status: 'skip' }, job.generation, now(), [], existing, { rebuild: true })
        })) return 'retry'
      } else store.tx(() => notes.finish(rows, false))
      store.tx(() => {
        effects.finishGeneration(job)
        if (notes.pending(job.key, noteInterval).length) schedule(job.key, Boolean(job.payload))
      })
      wake()
      return 'done'
    }
    if (sources.some(source => !eligible(source))) return 'wait'
    const lastTurn = rebuilding ? undefined : notes.previous(job.key, rows[0]!.id)
    const previousAssistant = lastTurn && [...lastTurn.sourceIds, ...lastTurn.assistantSourceIds].every(readable)
      && allowsDerived([...lastTurn.sourceIds, ...lastTurn.assistantSourceIds])
      && sources.every(source => allowsText(lastTurn.assistant, source)) ? lastTurn.assistant : null
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
    const project = (text: string) => projectText(workspace, text)
    const input = {
      existing: existing && !rebuilding ? { title: project(existing.title), markdown: project(existing.markdown) } : undefined,
      previousAssistant: previousAssistant === null ? null : project(previousAssistant),
      turns: turns.map(({ row, user, assistant }) => ({
        user: user.map(({ source, text, question }) => ({ sourceId: source.id, text: project(text), author: source.author, version: source.version,
          question: question === null ? null : project(question), at: source.at })),
        assistant: project(assistant),
      })),
    }
    // Validate all text actually sent, including stored documents and question context, not only new sources.
    const material = [input.existing?.title, input.existing?.markdown, input.previousAssistant,
      ...input.turns.flatMap(turn => [turn.assistant, ...turn.user.flatMap(user => [user.text, user.question])])]
    const current = () => {
      if (!policyCurrent()) return false
      const latest = notes.read(job.key)
      return latest?.fileRevision === existing?.fileRevision && latest?.revision === existing?.revision
        && related.every(readable) && JSON.stringify(notes.snapshot(related)) === JSON.stringify(versions)
        && allowsReferences(refs) && turns.every(turn => turn.user.every(item => projectSource(item.source, item.ref).text === item.text))
        && materialAllowed(material, related)
    }
    if (!current()) return 'wait'
    const result = await calculate(job, sources[0]!, 'note', NOTE_SYSTEM, input, related, current)
    if (result === undefined) return 'wait'
    const reply = noteReply.parse(result)
    if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return 'retry'
    const output = reply.status === 'write' ? [reply.title, reply.markdown, reply.filename ?? ''] : []
    if (output.some(text => project(text) !== text) || output.length && sources.some(source => !allowsText(output.join('\n'), source))) return 'retry'
    if (!await mutate(() => {
      if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return false
      if (output.some(text => project(text) !== text)) return false
      return notes.commit(job.key, rows, reply, job.generation, now(), refs, existing, { rebuild: rebuilding })
    })) {
      // Rebuilds can replay already checkpointed turns, including on an empty
      // allocation. An ordinary pending-turn job would lose that work.
      if (rebuilding) return 'retry'
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
        observation.end(outcome === 'retry' ? 'failed' : 'completed', {
          stage: outcome === 'wait' ? 'waiting' : outcome === 'retry' ? 'queued' : 'checkpoint',
          reason: outcome === 'retry' ? 'retry' : outcome === 'wait' ? 'external_wake' : 'normal' })
      } catch (error) {
        observation.fail(error)
        diagnostics.emit({ event: 'operation.progress', operation: 'memory.daily', stage: 'queued', reason: safeDiagnosticReason(error),
          identities: { jobId: effect.key, generation: effect.generation }, metrics: { attempt: effect.attempts, retryDelayMs: Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** effect.attempts) } })
        outcomes.set(effect.key, 'retry')
      }
    }
    return outcomes
  }
  const CLEAN = 'memory.note-cleanup'
  effects.runs(CLEAN, async jobs => {
    if (notes.needsRecovery()) await mutate(() => notes.recover())
    return new Map(jobs.map(job => [job.key, notes.pendingCleanup() ? 'retry' as const : 'done' as const]))
  })
  effects.runs(WRITE_NOTE, run(write), attempts => Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** attempts))
  store.tx(() => {
    for (const group of notes.pendingGroups()) schedule(group.note, true)
  })
  function queueRebuild(key: string) {
    effects.cancel(WRITE_NOTE, key)
    effects.queue(WRITE_NOTE, key, { rebuild: true, flush: true })
  }
  function queueRestrictedRebuilds() {
    store.tx(() => {
      for (const note of notes.list(null, null)) {
        if (allowsReferences(notes.references(note.key))) continue
        const active = effects.get(WRITE_NOTE, note.key)
        if (active?.payload && typeof active.payload === 'object' && 'rebuild' in active.payload && active.payload.rebuild === true) continue
        queueRebuild(note.key)
      }
    })
  }
  return {
    record,
    storage: notes,
    queueRebuild, queueRestrictedRebuilds,
    refreshRestrictions() { queueRestrictedRebuilds(); wake() },
    read: notes.read,
    sources: notes.sources,
    list: notes.list,
    flush(session?: string) {
      store.tx(() => {
        for (const group of notes.pendingGroups()) if (!session || group.session === session) schedule(group.note, true)
      })
      wake()
    },
    eraseSource(cut: DocumentSourceCut) {
      effects.queue(CLEAN, DAILY, null)
      for (const key of notes.eraseSource(cut)) queueRebuild(key)
    },
    withdraw(id: string) {
      effects.queue(CLEAN, DAILY, null)
      for (const key of notes.withdraw(id)) {
        effects.cancel(WRITE_NOTE, key)
        if (notes.pending(key).length) schedule(key)
      }
    },
  }
}
