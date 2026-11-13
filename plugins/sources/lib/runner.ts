/**
 * The checks of each source on its own timer (docs/system-design.md §12.2): one at a time per source, at the pace the
 * user confirmed, less often after failures, never the missed ones all at once after a sleep. A check calls the one
 * confirmed tool, finds the messages it has not seen, has them judged, and reports them all; what it reports is
 * remembered as seen, so nothing is judged or pushed twice.
 */
import { MAX_ITEMS_PER_CHECK, MAX_SEEN, type CheckedItem, type Json, type SourceSpec } from '../../../src/shared/sources-channel.ts'
import type { Decision } from './prompts.ts'
import { decodeResult, fill, messagesOf, type Message } from './spec.ts'

const MINUTE = 60_000
/** After failures the wait doubles, up to an hour (or the source's own pace, when that is longer). */
const MAX_BACKOFF_MINUTES = 60
/** A check that is due when the plugin starts waits a little, so several do not all go at once. */
const START_SPREAD_MS = 25_000
const START_DELAY_MS = 5_000
const CHECK_TIMEOUT_MS = 2 * MINUTE

export type CallResult = { ok: true, value: unknown } | { ok: false, error: string }

export interface RunnerDeps {
  /** The source's tool, called without an agent. */
  call: (tool: string, args: Record<string, Json>, signal: AbortSignal) => Promise<CallResult>
  /** The new messages judged; throws when the model gave no usable answer. */
  judge: (spec: SourceSpec, messages: readonly Message[], signal: AbortSignal) => Promise<Map<string, Decision>>
  report: (message: object) => void
  now?: () => number
  random?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
  startDelayMs?: number
  startSpreadMs?: number
}

interface Running {
  spec: SourceSpec
  seen: Set<string>
  failures: number
  fingerprint: string
  timer: unknown
  busy: boolean
  controller: AbortController | null
}

const fingerprintOf = ({ lastCheckedAt: _last, createdAt: _created, ...spec }: SourceSpec) => JSON.stringify(spec)

/** How long until a check that failed `failures` times running is tried again. */
export function backoffMinutes(everyMinutes: number, failures: number): number {
  return Math.min(everyMinutes * 2 ** failures, Math.max(everyMinutes, MAX_BACKOFF_MINUTES))
}

export function createRunner({
  call, judge, report, now = Date.now, random = Math.random,
  setTimer = (run, ms) => { const handle = setTimeout(run, ms); handle.unref?.(); return handle },
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log = () => {}, startDelayMs = START_DELAY_MS, startSpreadMs = START_SPREAD_MS,
}: RunnerDeps) {
  const sources = new Map<string, Running>()
  let disposed = false

  function stop(state: Running) {
    if (state.timer !== null) clearTimer(state.timer)
    state.timer = null
    state.controller?.abort()
  }

  function schedule(state: Running) {
    if (state.timer !== null) clearTimer(state.timer)
    state.timer = null
    if (disposed || state.spec.paused) return
    const { everyMinutes, lastCheckedAt, createdAt } = state.spec
    const due = state.failures
      ? now() + backoffMinutes(everyMinutes, state.failures) * MINUTE
      : (lastCheckedAt ?? createdAt) + everyMinutes * MINUTE
    const wait = Math.max(due - now(), state.failures ? 0 : startDelayMs + Math.floor(random() * startSpreadMs))
    state.timer = setTimer(() => { state.timer = null; void check(state) }, wait)
  }

  function finish(state: Running, message: object) {
    if (sources.get(state.spec.id) !== state || disposed) return
    report(message)
    schedule(state)
  }

  function fail(state: Running, startedAt: number, error: string) {
    state.failures += 1
    const nextAt = now() + backoffMinutes(state.spec.everyMinutes, state.failures) * MINUTE
    log(`source "${state.spec.name}" check failed: ${error}`)
    finish(state, { type: 'source_checked', version: 1, sourceId: state.spec.id, at: startedAt, nextAt, ok: false, error })
  }

  function judgedItems(judged: readonly Message[], decisions: Map<string, Decision>): CheckedItem[] {
    return judged.map((message) => {
      const decision = decisions.get(message.key) ?? { push: false, reason: '' }
      return { key: message.key, title: message.title, body: message.body, link: message.link, push: decision.push, reason: decision.reason }
    })
  }

  async function check(state: Running) {
    if (state.busy || disposed) return
    state.busy = true
    const startedAt = now()
    const controller = new AbortController()
    state.controller = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
    const { spec } = state
    try {
      const last = new Date(spec.lastCheckedAt ?? spec.createdAt).toISOString()
      const result = await call(spec.tool, fill(spec.args, last), signal)
      if (!result.ok) return fail(state, startedAt, result.error)
      const found = messagesOf(spec, decodeResult(spec.decode, result.value))
      if (!found.ok) return fail(state, startedAt, found.problem)
      const fresh = [...new Map(found.messages.filter((message) => !state.seen.has(message.key)).map((message) => [message.key, message])).values()]
      const judged = fresh.slice(0, MAX_ITEMS_PER_CHECK)
      // As many more as the channel carries are taken as seen; past that they wait for a later check.
      const passed = fresh.slice(MAX_ITEMS_PER_CHECK, MAX_ITEMS_PER_CHECK + MAX_SEEN).map((message) => message.key)
      const decisions = judged.length ? await judge(spec, judged, signal) : new Map<string, Decision>()
      for (const message of judged) state.seen.add(message.key)
      for (const key of passed) state.seen.add(key)
      state.failures = 0
      state.spec = { ...state.spec, lastCheckedAt: startedAt }
      const nextAt = now() + spec.everyMinutes * MINUTE
      return finish(state, { type: 'source_checked', version: 1, sourceId: spec.id, at: startedAt, nextAt, ok: true, items: judgedItems(judged, decisions), seen: passed })
    } catch (err) {
      if (controller.signal.aborted) return undefined
      return fail(state, startedAt, err instanceof Error ? err.message : String(err))
    } finally {
      state.busy = false
      state.controller = null
    }
  }

  function update(held: Running, spec: SourceSpec, seen: readonly string[]) {
    for (const key of seen) held.seen.add(key)
    const lastCheckedAt = Math.max(held.spec.lastCheckedAt ?? 0, spec.lastCheckedAt ?? 0) || null
    held.spec = { ...spec, lastCheckedAt }
    const fingerprint = fingerprintOf(spec)
    if (held.fingerprint === fingerprint && (held.timer !== null || held.busy)) return
    held.fingerprint = fingerprint
    held.failures = 0
    if (!held.busy) schedule(held)
  }

  return {
    /** The sources as the app has them now: gone ones stop, changed ones start over, the rest keep their timers. */
    set(next: ReadonlyArray<SourceSpec & { seen: readonly string[] }>) {
      const ids = new Set(next.map((source) => source.id))
      for (const [id, state] of sources) {
        if (ids.has(id)) continue
        stop(state)
        sources.delete(id)
      }
      for (const { seen, ...spec } of next) {
        const held = sources.get(spec.id)
        if (held) {
          update(held, spec, seen)
          continue
        }
        const state: Running = { spec, seen: new Set(seen), failures: 0, fingerprint: fingerprintOf(spec), timer: null, busy: false, controller: null }
        sources.set(spec.id, state)
        schedule(state)
      }
    },
    /** One check now, whatever its timer says (tests). */
    check: (id: string) => {
      const state = sources.get(id)
      return state ? check(state) : Promise.resolve()
    },
    has: (id: string) => sources.has(id),
    dispose() {
      disposed = true
      for (const state of sources.values()) stop(state)
      sources.clear()
    },
  }
}
