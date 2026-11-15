import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MemoryCompute } from '../shared/memory-contract.ts'
import { MAX_TIMER_DELAY_MS } from './effects.ts'
import type { Effect, Effects, Outcome } from './effects.ts'
import { MEMORY_PROFILE_GENERATOR, MEMORY_PROFILE_SYSTEM, memoryProfileRequest, memoryProfileScope, parseMemoryProfileReply,
  prepareMemoryProfileInput } from './memory-profile.ts'
import type { MemoryProfileInput, MemoryProfileRef, MemoryProfileScope } from './memory-profile.ts'
import type { openMemoryProfileStore } from './memory-profile-store.ts'
import { memoryScopeKey } from './memory-store.ts'

export const MEMORY_PROFILE_EFFECT = 'memory.profile'
const MAX_OBSERVED_PROJECTS = 12
const COMPUTE_TIMEOUT_MS = 15_000
const FOLLOWING_BATCH_MS = 50

type Model = Pick<MemoryCompute, 'provider' | 'model'>
type ScopeInput = { inputs: readonly MemoryProfileInput[], validUntil: number | null }
export type MemoryProfileSnapshot = ScopeInput & { scope: MemoryProfileScope, revision: number, model: Model, generatedAt: number }
export type MemoryProfileAdmission = { ready: () => boolean, current: () => boolean, deadline: number | null }

const payload = z.strictObject({ revision: z.int().nonnegative(), generator: z.string() })
type Payload = z.infer<typeof payload>

const generatorOf = (model: Model) => `${MEMORY_PROFILE_GENERATOR}:${createHash('sha256').update(JSON.stringify([model.provider, model.model])).digest('hex')}`

function scopeOf(key: string): MemoryProfileScope | null {
  let encoded: unknown
  try { encoded = JSON.parse(key) } catch { return null }
  const parsed = memoryProfileScope.safeParse(encoded)
  return parsed.success && memoryScopeKey(parsed.data) === key ? parsed.data : null
}

/** Coordinate profile computation with the existing durable effect queue and canonical snapshot checks. */
export function createMemoryProfileJobs({ effects, store, tx, revision, route, now = Date.now, busy = () => false, ready,
  makeSnapshot, dispatch, changed = () => {}, delayMs = 1000 }: {
  effects: Effects,
  store: ReturnType<typeof openMemoryProfileStore>,
  tx: <T>(work: () => T) => T,
  revision: () => number,
  route: () => Model | null,
  now?: () => number,
  busy?: () => boolean,
  ready: (snapshot: MemoryProfileSnapshot) => boolean,
  makeSnapshot: (scope: MemoryProfileScope, at: number) => ScopeInput,
  dispatch: (request: MemoryCompute, signal: AbortSignal, admission: MemoryProfileAdmission) => Promise<string> | null,
  changed?: (scope: MemoryProfileScope) => void,
  delayMs?: number,
}) {
  const observed = new Map<string, MemoryProfileScope>()
  const expiration = new Map<string, number>()
  let closed = false
  let active: { controller: AbortController, current: () => boolean } | undefined
  let followingBatch: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let expiryAt = Infinity

  function read(scope: MemoryProfileScope) {
    if (closed) return null
    const model = route()
    if (!model) return null
    const saved = store.read(scope)
    const at = now()
    return saved && saved.revision === revision() && saved.generator === generatorOf(model) && saved.generatedAt <= at
      && (saved.validUntil === null || at < saved.validUntil) ? saved : null
  }

  function queue(key: string, desired: Payload, at: number) {
    effects.queue(MEMORY_PROFILE_EFFECT, key, desired, at)
  }

  function publish(scope: MemoryProfileScope) {
    try { changed(scope) } catch { console.error('[memory] could not publish profile change') }
  }

  function scheduleExpiry() {
    const at = Math.min(...expiration.values())
    if (expiryAt === at) return
    clearTimeout(expiryTimer)
    expiryAt = at
    if (!Number.isFinite(at)) return
    expiryTimer = setTimeout(() => {
      expiryAt = Infinity
      const current = now()
      for (const [key, deadline] of expiration) {
        if (deadline > current) continue
        expiration.delete(key)
        const scope = observed.get(key)
        if (scope) publish(scope)
      }
      // The due durable effect handles regeneration independently of the view invalidation.
      scheduleExpiry()
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, at - now())))
    expiryTimer.unref()
  }

  function watchExpiry(key: string, deadline: number | null) {
    if (deadline !== null && observed.has(key)) expiration.set(key, deadline)
    else expiration.delete(key)
    scheduleExpiry()
  }

  function ensure(scope: MemoryProfileScope, desired: Payload) {
    const key = memoryScopeKey(scope)
    const saved = read(scope)
    // A read performed after waking from sleep must leave the pending view notification intact.
    if (saved) watchExpiry(key, saved.validUntil)
    if (saved && saved.validUntil === null) return false
    const existing = payload.safeParse(effects.get(MEMORY_PROFILE_EFFECT, key)?.payload)
    if (existing.success && existing.data.revision === desired.revision && existing.data.generator === desired.generator) return false
    queue(key, desired, saved?.validUntil ?? now() + delayMs)
    return true
  }

  function observe(scope: MemoryProfileScope) {
    if (closed) return
    const key = memoryScopeKey(scope)
    observed.delete(key)
    observed.set(key, scope)
    const projects = [...observed].filter(([, value]) => value.kind === 'project')
    if (projects.length > MAX_OBSERVED_PROJECTS) {
      const oldest = projects[0][0]
      observed.delete(oldest)
      watchExpiry(oldest, null)
    }
    const model = route()
    if (model && tx(() => ensure(scope, { revision: revision(), generator: generatorOf(model) }))) void effects.wake()
  }

  function sync(changeRevision = revision()) {
    if (closed) return
    if (active && !active.current()) active.controller.abort()
    const model = route()
    const queued = tx(() => {
      // Capture persisted scopes before discarding stale projections so a reboot after a commit can regenerate them.
      const scopes = new Map([...store.scopes(MAX_OBSERVED_PROJECTS + 1), ...observed.values()]
        .map(scope => [memoryScopeKey(scope), scope]))
      store.invalidate(changeRevision)
      if (!model) { expiration.clear(); scheduleExpiry(); return false }
      const desired = { revision: changeRevision, generator: generatorOf(model) }
      let requeued = false
      for (const scope of scopes.values()) if (ensure(scope, desired)) requeued = true
      return requeued
    })
    if (queued) void effects.wake()
  }

  function commit(job: Effect, snapshot: MemoryProfileSnapshot, refs: MemoryProfileRef[], current: () => boolean): boolean {
    const done = tx(() => {
      if (!current() || busy()) return false
      const { scope, revision, generatedAt, validUntil, model } = snapshot
      const generator = generatorOf(model)
      if (!store.save({ scope, revision, generator, generatedAt, validUntil, refs }, now())) return false
      if (!effects.finishGeneration(job)) throw new Error('profile effect generation changed during commit')
      if (validUntil !== null) queue(job.key, { revision, generator }, validUntil)
      return true
    })
    if (done) {
      watchExpiry(job.key, snapshot.validUntil)
      publish(snapshot.scope)
    }
    return done
  }

  async function calculate(job: Effect, snapshot: MemoryProfileSnapshot, current: () => boolean): Promise<Outcome> {
    const controller = new AbortController()
    active = { controller, current }
    const canUseSnapshot = () => !controller.signal.aborted && current()
    const admission = { ready: () => canUseSnapshot() && !busy(), current: canUseSnapshot, deadline: snapshot.validUntil }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!snapshot.inputs.length) return commit(job, snapshot, [], canUseSnapshot) ? 'done' : 'wait'
      const id = randomUUID()
      const request: MemoryCompute = { id, sourceId: id, stage: 'profile', generation: job.generation, ...snapshot.model,
        system: MEMORY_PROFILE_SYSTEM, input: memoryProfileRequest(snapshot.scope, snapshot.inputs) }
      const result = dispatch(request, controller.signal, admission)
      if (!result) return 'wait'
      const stopped = new Promise<null>(resolve => {
        if (controller.signal.aborted) resolve(null)
        else controller.signal.addEventListener('abort', () => resolve(null), { once: true })
        const validityMs = snapshot.validUntil === null ? Infinity : Math.max(0, snapshot.validUntil - now())
        timer = setTimeout(() => resolve(null), Math.min(COMPUTE_TIMEOUT_MS, validityMs))
        timer.unref()
      })
      const reply = await Promise.race([result, stopped])
      if (!canUseSnapshot()) return 'wait'
      if (reply === null) return 'retry'
      const refs = parseMemoryProfileReply(reply, snapshot.inputs)
      if (!refs) return 'retry'
      return commit(job, snapshot, refs, canUseSnapshot) ? 'done' : 'wait'
    } catch {
      return controller.signal.aborted || closed ? 'wait' : 'retry'
    } finally {
      clearTimeout(timer)
      controller.abort()
      if (active?.controller === controller) active = undefined
    }
  }

  function followingPass() {
    if (closed || followingBatch !== undefined) return
    followingBatch = setTimeout(() => {
      followingBatch = undefined
      void effects.wake()
    }, FOLLOWING_BATCH_MS)
    followingBatch.unref()
  }

  effects.runs(MEMORY_PROFILE_EFFECT, async jobs => {
    const outcomes = new Map<string, Outcome>()
    if (closed || busy()) return outcomes
    const model = route()
    if (!model) return outcomes
    const generator = generatorOf(model)
    for (const [index, job] of jobs.entries()) {
      const scope = scopeOf(job.key)
      const parsed = payload.safeParse(job.payload)
      if (!scope || !parsed.success) { outcomes.set(job.key, 'done'); continue }
      if (!effects.holds(job)) continue
      const collection = revision()
      if (collection !== parsed.data.revision || generator !== parsed.data.generator) {
        tx(() => queue(job.key, { revision: collection, generator }, now() + delayMs))
        if (delayMs <= 0) followingPass()
        continue
      }
      const generatedAt = now()
      const { inputs, validUntil } = makeSnapshot(scope, generatedAt)
      const snapshot = { scope, revision: collection, model, generatedAt, validUntil, inputs: prepareMemoryProfileInput(scope, inputs) }
      const current = () => {
        if (closed || revision() !== snapshot.revision || !effects.holds(job) || (validUntil !== null && now() >= validUntil)) return false
        const configured = route()
        return configured !== null && generatorOf(configured) === generator && ready(snapshot)
      }
      if (!current()) continue
      const outcome = await calculate(job, snapshot, current)
      const expired = !closed && validUntil !== null && now() >= validUntil
      if (expired && effects.holds(job)) {
        // Replace the generation so a late reply cannot complete the job sampled for the new time window.
        tx(() => queue(job.key, { revision: revision(), generator }, now() + delayMs))
        followingPass()
      } else {
        outcomes.set(job.key, outcome)
        if (!closed && outcome !== 'wait' && index < jobs.length - 1) followingPass()
      }
      break
    }
    return outcomes
  })

  function resetLive() {
    clearTimeout(followingBatch)
    followingBatch = undefined
    active?.controller.abort()
  }

  return { observe, sync, read, resetLive, close() { closed = true; clearTimeout(expiryTimer); resetLive() } }
}
