import { createRequestBudget, INITIALIZATION_BUDGET_MS } from '../shared/request-budget.ts'
import { belongsTo, isConversationEvent, type ContextEvent } from '../shared/conversation-context.ts'
import { invalidatesConversationSnapshot, streamMark, type RendererSnapshot, type StreamMark } from '../shared/renderer-sync.ts'
import type { DiagnosticEvent } from '../diagnostics/contracts.ts'

export type InitializationFailure = 'timeout' | 'capacity' | 'age' | 'boundary' | 'gap' | 'unavailable'
const foreground = (value: ContextEvent) => isConversationEvent(value) || value.type === 'ready' || value.type === 'workdir'

/** Owns required startup state only. Optional memory, settings and feed reads never gate this handoff. */
export function createInitializationActions({ snapshot, install, deliver, pause, initialized, failed, loading, observe = () => {},
  budgetMs = INITIALIZATION_BUDGET_MS, maxEvents = 1024, maxBytes = 2 * 1024 * 1024, maxAgeMs = 15_000,
}: {
  snapshot(options: { budgetMs: number }): Promise<RendererSnapshot>, install(value: RendererSnapshot): void, deliver(value: unknown): void,
  pause(): void, initialized(): void, failed(reason: InitializationFailure): void, loading(): void,
  observe?: (event: DiagnosticEvent) => void,
  budgetMs?: number, maxEvents?: number, maxBytes?: number, maxAgeMs?: number,
}) {
  let generation = 0, mode: 'loading' | 'ready' | 'failed' = 'loading'
  let active: StreamMark | null = null
  let held: Array<{ json: string, mark: StreamMark }> = []
  let bytes = 0, ageTimer: ReturnType<typeof setTimeout> | undefined
  let lifetime: ReturnType<typeof createRequestBudget> | undefined
  let observed: StreamMark | null = null
  let received: { first: StreamMark | null, gapAfter: number } = { first: null, gapAfter: 0 }
  let invalidation: StreamMark | null = null
  const retired = new Set<string>()
  const log = (event: DiagnosticEvent) => { try { observe(event) } catch { /* Optional diagnostics never control synchronization. */ } }
  function clearHeld() { held = []; bytes = 0; clearTimeout(ageTimer); ageTimer = undefined }
  function fail(reason: InitializationFailure) {
    if (mode === 'failed') return
    log({ event: 'state.changed', operation: 'startup', stage: 'failed', reason: reason === 'capacity' || reason === 'age' ? 'buffer_limit' : reason === 'boundary' ? 'invalid_context' : reason,
      identities: { generation }, metrics: { pendingCount: held.length, bytes, eventCursor: observed?.eventCursor ?? 0 } })
    mode = 'failed'; generation++; lifetime?.cancel(); lifetime?.close(); clearHeld(); pause(); failed(reason)
  }
  function receive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const value = raw as ContextEvent, mark = streamMark(raw)
    if (mark && retired.has(mark.streamGeneration)) return
    if (mark && observed?.streamGeneration === mark.streamGeneration && mark.eventCursor <= observed.eventCursor) return
    if (mark && invalidatesConversationSnapshot(raw)
      && (invalidation?.streamGeneration !== mark.streamGeneration || mark.eventCursor > invalidation.eventCursor)) invalidation = mark
    if (mark) {
      if (mode === 'loading') {
        if (received.first?.streamGeneration !== mark.streamGeneration) received = { first: mark, gapAfter: 0 }
        if (observed?.streamGeneration === mark.streamGeneration && mark.eventCursor > observed.eventCursor + 1) received.gapAfter = Math.max(received.gapAfter, observed.eventCursor + 1)
      }
      if (!observed || observed.streamGeneration !== mark.streamGeneration || mark.eventCursor > observed.eventCursor) observed = mark
    }
    if (mode === 'ready') {
      if (!mark) { if (foreground(value)) fail('boundary'); else deliver(raw); return }
      if (mark.streamGeneration !== active?.streamGeneration) {
        if (active) { retired.add(active.streamGeneration); if (retired.size > 8) retired.delete(retired.values().next().value!) }
        fail('boundary'); return
      }
      if (mark.eventCursor <= active.eventCursor) return
      if (mark.eventCursor !== active.eventCursor + 1) { fail('gap'); return }
      active = mark; deliver(raw); return
    }
    if (!foreground(value)) { deliver(raw); return }
    if (mode === 'failed') return
    if (!mark) { fail('boundary'); return }
    let size: number, json: string
    try { json = JSON.stringify(raw); size = Math.max(json.length * 2, new TextEncoder().encode(json).byteLength) + 128 } catch { fail('boundary'); return }
    if (held.length + 1 > maxEvents || bytes + size > maxBytes) { fail('capacity'); return }
    held.push({ json, mark }); bytes += size
    ageTimer ??= setTimeout(() => fail('age'), maxAgeMs)
  }
  async function initialize() {
    const attempt = ++generation
    // Events received before this attempt are no longer buffered. Its snapshot must cover them.
    const baseline = observed
    lifetime?.cancel(); lifetime?.close(); clearHeld(); mode = 'loading'; active = null; received = { first: null, gapAfter: 0 }
    pause(); loading()
    log({ event: 'state.changed', operation: 'startup', stage: 'start', identities: { generation: attempt } })
    const budget = createRequestBudget(budgetMs); lifetime = budget
    try {
      const view = await budget.run(() => snapshot({ budgetMs: budget.remainingMs() }))
      if (attempt !== generation || mode !== 'loading') return false
      const mark = streamMark({ streamGeneration: view.streamGeneration, eventCursor: view.cutoverCursor })
      if (!mark || !Array.isArray(view.replay) || observed && observed.streamGeneration !== mark.streamGeneration && !retired.has(observed.streamGeneration)
        || invalidation?.streamGeneration === mark.streamGeneration && invalidation.eventCursor > mark.eventCursor
        || (view.history && view.history.id !== view.context.conversationId)
        || (view.info.conversationId ?? null) !== view.context.conversationId || (view.info.sessionId ?? null) !== view.context.sessionId) throw new Error('Untrusted snapshot boundary')
      if (baseline?.streamGeneration === mark.streamGeneration && baseline.eventCursor > mark.eventCursor
        || received.first?.streamGeneration === mark.streamGeneration && received.first.eventCursor > mark.eventCursor + 1
        || received.gapAfter > mark.eventCursor) { fail('gap'); return false }
      let previous = -1
      for (const event of view.replay) {
        const at = streamMark(event)
        if (!at || at.streamGeneration !== mark.streamGeneration || at.eventCursor <= previous || at.eventCursor > mark.eventCursor
          || !belongsTo(event as ContextEvent, view.context)) throw new Error('Untrusted replay boundary')
        previous = at.eventCursor
      }
      const after = held.filter(item => item.mark.streamGeneration === mark.streamGeneration && item.mark.eventCursor > mark.eventCursor)
      install(view)
      // Synchronous install/replay: callbacks from an older attempt cannot commit halfway through.
      initialized()
      for (const event of view.replay) deliver(event)
      for (const item of after) deliver(JSON.parse(item.json) as unknown)
      active = observed?.streamGeneration === mark.streamGeneration && observed.eventCursor > mark.eventCursor ? observed : mark
      clearHeld(); mode = 'ready'
      log({ event: 'state.changed', operation: 'startup', stage: 'ready', identities: { generation: attempt }, metrics: { eventCursor: active.eventCursor } })
      return true
    } catch (error) {
      if (attempt === generation) fail(budget.signal.aborted ? 'timeout' : error instanceof Error && /boundary/.test(error.message) ? 'boundary' : 'unavailable')
      return false
    } finally { budget.close(); if (lifetime === budget) lifetime = undefined }
  }
  return { receive, initialize, invalidate: fail, watermark: () => mode === 'ready' ? active ?? undefined : undefined,
    state: () => ({ mode, heldCount: held.length, heldBytes: bytes }), close: () => { generation++; lifetime?.cancel(); lifetime?.close(); clearHeld() } }
}
