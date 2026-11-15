import type { Effect, Effects, Outcome } from './effects.ts'
import { DAILY_MEMORY_DEFAULTS as defaults } from '../shared/memory-daily-defaults.ts'
import { DREAM, DREAM_SYSTEM, NOTE_SYSTEM, WRITE_NOTE, dreamReply, nextDreamAt, noteReply, openMemoryNotes } from './memory-notes.ts'
import type { DailyMemorySettings } from './memory-notes.ts'
import type { MemoryProvenance, MemorySource, MemoryStore } from './memory-store.ts'
import { todayAt } from './memory-facts.ts'
import { MemoryComputeError } from './memory-channel.ts'

const DAILY = 'daily'
const DAY_MS = 86_400_000

type NoteRef = { key: string, revision: number }
type DreamNote = NoteRef & { scopeKey: string, day: string, title: string, markdown: string, sources: string[], dependencies: string[] }
type DreamPlan = { processed: Array<NoteRef & { sources: string[] }> }

function groupBy<T>(items: Iterable<T>, keyOf: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  return groups
}

function dreamBatches(notes: DreamNote[], budget: number) {
  if (!budget || !notes.length) return notes.length ? [notes] : []
  const batches: DreamNote[][] = []
  let batch: DreamNote[] = [], bytes = 0
  const size = (note: DreamNote) => Buffer.byteLength(note.title + '\n' + note.markdown)
  const flush = () => {
    if (batch.length) batches.push(batch)
    batch = []
    bytes = 0
  }
  const groups = groupBy(notes, note => note.day)
  for (const day of groups.values()) {
    const dayBytes = day.reduce((sum, note) => sum + size(note), 0)
    if (bytes + dayBytes > budget) flush()
    if (dayBytes <= budget) {
      batch.push(...day)
      bytes += dayBytes
      continue
    }
    for (const note of day) {
      const noteBytes = size(note)
      if (bytes + noteBytes > budget) flush()
      batch.push(note)
      bytes += noteBytes
    }
  }
  flush()
  return batches
}

type Calculate = (job: Effect, source: MemorySource, stage: 'note' | 'dream', system: string, input: object,
  sources: string[], current: () => boolean) => Promise<unknown>

/** Owns daily note and consolidation jobs. Formal facts are still committed by MemoryRuntime. */
export function createMemoryNoteJobs({ store, effects, now, settings, readable, eligible, allowsText, assistantContextCurrent, calculate, queueExtraction, extractionPending }: {
  store: MemoryStore, effects: Effects, now: () => number, settings?: DailyMemorySettings,
  readable: (id: string) => boolean,
  eligible: (source: MemorySource) => boolean,
  allowsText: (text: string, source: MemorySource) => boolean,
  assistantContextCurrent: (context: MemoryProvenance) => boolean,
  calculate: Calculate,
  queueExtraction: (id: string, note: NoteRef, focuses: string[], supporting: NoteRef[]) => boolean,
  extractionPending: (id: string) => boolean,
}) {
  const { timezone, dreamTime, noteInterval, scanDays, dreamUnits, dreamBatchBytes } = { ...defaults, ...settings }
  if (!Number.isSafeInteger(noteInterval) || noteInterval < 1) throw new Error('invalid-note-interval')
  const notes = openMemoryNotes(store, readable, undefined, (key, generation) => effects.holds({ kind: WRITE_NOTE, key, generation }))
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
  const scheduleDream = () => effects.queue(DREAM, DAILY, null, nextDreamAt(now(), timezone, dreamTime))
  const wake = () => { void effects.wake() }
  function record(session: string, ids: readonly string[], assistant: string) {
    const sources = [...new Set(ids)].flatMap(id => {
      const source = sourceOf(id)
      return source?.session === session ? [source] : []
    })
    const source = sources[0]
    if (!source || !sources.every(item => allowsText(assistant, item))) return
    const day = todayAt(sources.at(-1)!.at, timezone)
    const seen = store.dispatch.snapshot(session)
    const dependencies = [...new Set([...notes.contextSources(session, source), ...seen.sources,
      ...seen.dependencies.flatMap(ref => store.get(ref.id)?.evidence.map(edge => edge.sourceId) ?? [])])]
    // Assistant replies may restate any context the session saw. Keep that provenance, never promote the reply to independent evidence.
    const safeAssistant = assistantContextCurrent(seen) && dependencies.every(id => readable(id)) ? assistant : ''
    const key = notes.add(session, day, sources, safeAssistant, ids[0]!, safeAssistant ? dependencies : [], assistant)
    if (!key) return
    store.tx(() => {
      for (const group of notes.pendingGroups()) {
        if (group.session === session && (group.day !== day || group.count >= noteInterval)) schedule(group.note)
      }
    })
    wake()
  }

  async function write(job: Effect): Promise<Outcome> {
    notes.recover()
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
      store.tx(() => { effects.finishGeneration(job); schedule(job.key, true) })
      wake()
      return 'done'
    }
    if (notes.jobState(job.key, job.generation) === 'conflict') return 'wait'
    if (notes.blocked(job.key)) return 'wait'
    const rows = notes.pending(job.key, noteInterval)
    if (!rows.length) return 'done'
    const existing = notes.read(job.key)
    const priorSources = existing ? notes.sources(job.key) : []
    if (rows.some(row => !row.sourceIds.every(readable)) || priorSources.some(id => !readable(id))) return 'wait'
    const turns = rows.map(row => ({ row, sources: row.sourceIds.flatMap(id => sourceOf(id) ?? []) }))
    const sources = turns.flatMap(turn => turn.sources)
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
    const previousAssistant = lastTurn && [...lastTurn.sourceIds, ...lastTurn.assistantSourceIds].every(readable)
      && sources.every(source => allowsText(lastTurn.assistant, source)) ? lastTurn.assistant : null
    const related = [...new Set([...sources.map(source => source.id), ...priorSources, ...rows.flatMap(row => row.assistantSourceIds), ...(previousAssistant ? [...lastTurn!.sourceIds, ...lastTurn!.assistantSourceIds] : [])])]
    const refs = notes.snapshot(related)
    const input = {
      existing: existing && { title: existing.title, markdown: existing.markdown },
      previousAssistant,
      turns: turns.map(({ row, sources }) => ({
        user: sources.map(source => ({ sourceId: source.id, text: source.text!, author: source.author, version: source.version, question: source.question, at: source.at })),
        assistant: sources.length && sources.every(source => allowsText(row.assistant, source)) ? row.assistant : '',
      })),
    }
    // Validate all text actually sent, including stored documents and question context, not only new sources.
    const material = [input.existing?.title, input.existing?.markdown, input.previousAssistant,
      ...input.turns.flatMap(turn => [turn.assistant, ...turn.user.flatMap(user => [user.text, user.question])])]
    const current = () => notes.read(job.key)?.fileRevision === existing?.fileRevision
      && related.every(readable) && JSON.stringify(notes.snapshot(related)) === JSON.stringify(refs)
      && materialAllowed(material, related)
    if (!current()) return 'wait'
    const result = await calculate(job, sources[0]!, 'note', NOTE_SYSTEM, input, related, current)
    if (result === undefined) return 'wait'
    const reply = noteReply.parse(result)
    if (!current() || !effects.holds(job) || sources.some(source => !eligible(source))) return 'retry'
    if (reply.status === 'write' && sources.some(source => !allowsText(`${reply.title}\n${reply.markdown}\n${reply.filename ?? ''}`, source))) return 'retry'
    if (!notes.commit(job.key, rows, reply, job.generation, now(), refs, existing)) {
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
    console.info('[memory] daily note', { outcome: reply.status, turns: rows.length, sources: sources.length })
    wake()
    return 'done'
  }

  async function dream(job: Effect): Promise<Outcome> {
    const plan = job.payload as DreamPlan | null
    if (plan) {
      if (plan.processed.some(note => note.sources.some(extractionPending))) return 'wait'
      if (!effects.holds(job)) return 'done'
      store.tx(() => {
        for (const note of plan.processed) {
          const pending = note.sources.some(id => ['pending', 'note-ready'].includes(store.readSource(id)?.outcome ?? ''))
          if (!pending) notes.markProcessed(note.key, note.revision)
        }
        effects.finishGeneration(job)
        scheduleDream()
      })
      return 'done'
    }
    const today = todayAt(now(), timezone)
    const first = new Date(Date.parse(today) - (scanDays - 1) * DAY_MS).toISOString().slice(0, 10)
    const changed = notes.changed(first, today).flatMap(note => {
      const dependencies = notes.sources(note.key)
      if (!dependencies.length || !dependencies.every(readable)) return []
      const sources = dependencies.filter(id => sourceOf(id)?.outcome === 'note-ready')
      const scopes = new Set(dependencies.map(id => {
        const source = store.readSource(id)!
        return JSON.stringify([source.scope, source.context, source.project])
      }))
      return scopes.size === 1 ? [{ ...note, sources, dependencies, scopeKey: [...scopes][0]! }] : []
    })
    const units = new Map<string, { id: string, focus: string, note: NoteRef, supporting: Map<string, NoteRef> }>()
    const processed = new Map<string, NoteRef & { sources: string[] }>()
    let waiting = false, failed = 0, unitCount = 0
    const current = (batch: DreamNote[]) => effects.holds(job) && batch.every(note =>
      notes.read(note.key)?.revision === note.revision && note.dependencies.every(readable)
      && materialAllowed([note.title, note.markdown], note.dependencies))
    async function extractBatch(batch: DreamNote[]) {
      if (unitCount >= dreamUnits || waiting) return
      const anchor = batch.flatMap(note => note.sources).map(sourceOf).find(source => source !== undefined)
      if (!current(batch) || anchor && !eligible(anchor)) { waiting = true; return }
      if (!anchor) {
        for (const { key, revision } of batch) processed.set(key, { key, revision, sources: [] })
        return
      }
      const maxUnits = dreamUnits - unitCount
      const material = batch.map(({ key, title, markdown, sources }) => {
        const chars = [...markdown]
        const body = chars.length > defaults.dreamFileChars ? chars.slice(0, defaults.dreamFileChars).join('') + '\n\n[truncated]' : markdown
        return { key, title, markdown: body, sources }
      })
      const related = [...new Set(batch.flatMap(note => note.dependencies))]
      function validate(result: unknown) {
        const receipt = dreamReply.safeParse(result)
        if (!receipt.success) return null
        const candidates = []
        for (const unit of receipt.data.units) {
          const main = batch.find(note => note.key === unit.note && note.sources.includes(unit.sourceId))
          const source = sourceOf(unit.sourceId)
          const support = (unit.supportingNotes ?? []).flatMap(key => batch.find(note => note.key === key) ?? [])
          if (!main || !source || !allowsText(unit.focus, source) || support.length !== (unit.supportingNotes?.length ?? 0)) return null
          candidates.push({ id: source.id, focus: unit.focus, note: main, support: [main, ...support] })
        }
        return candidates
      }
      let accepted: ReturnType<typeof validate> = null
      let hadInvalidReceipt = false
      for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
        if (!current(batch)) { waiting = true; return }
        try {
          const result = await calculate(job, anchor, 'dream', DREAM_SYSTEM, {
            maxUnits, notes: material,
            ...(hadInvalidReceipt ? { retry: '上一条回执不符合格式或依据要求，请按输入中有效的笔记和原文 ID 重试。' } : {}),
          }, related, () => current(batch))
          if (result === undefined || !current(batch)) { waiting = true; return }
          accepted = validate(result)
          hadInvalidReceipt = !accepted
        } catch (err) {
          if (err instanceof SyntaxError) { hadInvalidReceipt = true; continue }
          if (!current(batch) || err instanceof MemoryComputeError && ['dispatch-denied', 'aborted'].includes(err.reason)) {
            waiting = true
          } else if (batch.length > 1) {
            const middle = Math.floor(batch.length / 2)
            await extractBatch(batch.slice(0, middle))
            await extractBatch(batch.slice(middle))
          } else failed += batch.length
          return
        }
      }
      if (!accepted) { failed += batch.length; return }
      for (const { key, revision } of batch) processed.set(key, { key, revision, sources: [] })
      for (const unit of accepted.slice(0, maxUnits)) {
        const key = JSON.stringify([unit.note.scopeKey, unit.focus.toLowerCase()])
        const merged = units.get(key) ?? { id: unit.id, note: unit.note, focus: unit.focus, supporting: new Map() }
        for (const { key, revision } of unit.support) merged.supporting.set(key, { key, revision })
        units.set(key, merged)
        unitCount++
      }
    }
    for (const scoped of groupBy(changed, note => note.scopeKey).values()) {
      for (const batch of dreamBatches(scoped, dreamBatchBytes)) await extractBatch(batch)
    }
    if (waiting) return 'wait'
    if (!effects.holds(job)) return 'done'
    const bySource = groupBy(units.values(), unit => unit.id)
    store.tx(() => {
      for (const [id, group] of bySource) {
        const supporting = [...new Map(group.flatMap(unit => [...unit.supporting])).values()]
        const queued = queueExtraction(id, group[0]!.note, group.map(unit => unit.focus), supporting)
        for (const { key } of supporting) {
          if (queued) processed.get(key)?.sources.push(id)
          else processed.delete(key)
        }
      }
      if (bySource.size) effects.amend(job, { processed: [...processed.values()] } satisfies DreamPlan)
      else {
        for (const note of processed.values()) notes.markProcessed(note.key, note.revision)
        effects.finishGeneration(job)
        scheduleDream()
      }
    })
    console.info('[memory] daily consolidation', { notes: processed.size, units: units.size, failed })
    if (bySource.size) {
      wake()
      return 'wait'
    }
    return 'done'
  }

  const run = (job: (effect: Effect) => Promise<Outcome>) => async (jobs: readonly Effect[]) => {
    const outcomes = new Map<string, Outcome>()
    for (const effect of jobs) {
      try {
        outcomes.set(effect.key, await job(effect))
      } catch {
        console.info('[memory] note job', { stage: effect.kind, outcome: 'retry' })
        outcomes.set(effect.key, 'retry')
      }
    }
    return outcomes
  }
  const CLEAN = 'memory.note-cleanup'
  effects.runs(CLEAN, async jobs => {
    notes.recover()
    return new Map(jobs.map(job => [job.key, 'done' as const]))
  })
  effects.runs(WRITE_NOTE, run(write), attempts => Math.min(defaults.retryMaxMs, defaults.retryMs * 2 ** attempts))
  effects.runs(DREAM, run(dream))
  store.tx(() => {
    if (!effects.get(DREAM, DAILY)) scheduleDream()
    for (const group of notes.pendingGroups()) schedule(group.note, true)
  })
  return {
    record,
    read: notes.read,
    sources: notes.sources,
    list: notes.list,
    flush(session?: string) {
      store.tx(() => {
        for (const group of notes.pendingGroups()) if (!session || group.session === session) schedule(group.note, true)
      })
      wake()
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
