import { DAILY_MEMORY_DEFAULTS } from '../memory/contracts/memory-daily-defaults.ts'
import type { HostMemoryApi, MemoryOwnerChange, MemoryOwnerProfile, MemoryOwnerState, MemoryProfileSnapshot, MemoryProject } from '../memory/contracts/host.ts'
import type { AutomaticRecallResult, MemoryScope } from '../memory/contracts/memory-contract.ts'
import { looksSecret } from '../memory/contracts/memory-sensitive.ts'
import { RequestTimeout } from '../shared/request-budget.ts'

export type PrefetchStartInput = {
  requestId: string
  sessionId: string
  queryText: string
  cwd?: string | null
  context?: MemoryScope
  project?: MemoryProject
  budgetMs?: number
}

export type ClaimPrefetchResult =
  | { found: false, cancelledRequestIds?: readonly string[] }
  | { found: true, result: AutomaticRecallResult, epoch?: string, revision?: number, deadlineAt?: number, retried?: boolean, cancelledRequestIds?: readonly string[] }

type PrefetchEntry = {
  key: string
  requestId: string
  sessionId: string
  queryText: string
  cwd?: string | null
  context?: MemoryScope
  project?: MemoryProject
  deadlineAt: number
  expiresAt: number
  ownerEpoch: string | undefined
  revision: number | undefined
  stale: boolean
  settled: boolean
  requeried: boolean
  cancelled?: boolean
  result?: AutomaticRecallResult
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  work?: Promise<void>
}

type DeliveryTerminal = { status: 'skipped' | 'timeout' | 'empty' | 'unavailable', deadlineAt: number }

const DEFAULT_CACHE_TTL_MS = 60_000
const MAX_CANCELLED_RECORDS = 4096

const prefetchKey = (sessionId: string, requestId: string) => `${sessionId}\0${requestId}`

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize = MAX_CANCELLED_RECORDS) {
  if (map.has(key)) map.delete(key)
  else if (map.size >= maxSize) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}

/**
 * Host-side L2 profile cache and L3 automatic-recall prefetch coordinator.
 * - Caches monotonic `{ epoch, revision, text }` snapshots (accepting `text: ''` as a valid update);
 * - Starts L3 prefetch at the exact validated dispatch point keyed by `(requestId, sessionId)`;
 * - Enforces double-point `{ ownerEpoch, revision }` invalidation (both on reply write and on claim);
 * - Preserves lightweight delivery terminals (`skipped` / `timeout` / `empty` / `unavailable`) across
 *   cache TTL eviction until consumed or cancelled, without retaining skipped/sensitive query text.
 */
export function createMemoryPrefetchManager({
  callPrefetch,
  onCancelled,
  now = Date.now,
  defaultBudgetMs = DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
}: {
  callPrefetch: (
    input: HostMemoryApi['prefetchRecall']['input'],
    options: { signal: AbortSignal, budgetMs: number },
  ) => Promise<HostMemoryApi['prefetchRecall']['output']>
  onCancelled?: (event: { sessionId: string, requestId?: string }) => void
  now?: () => number
  defaultBudgetMs?: number
  cacheTtlMs?: number
}) {
  let currentEpoch: string | undefined
  let currentRevision: number | undefined
  let ownerAvailable = false
  let latestProfile: MemoryProfileSnapshot | undefined
  const entries = new Map<string, PrefetchEntry>()
  const claiming = new Map<string, PrefetchEntry>()
  const deliveryTerminals = new Map<string, DeliveryTerminal>()
  const refreshable = new Map<string, PrefetchEntry>()
  const deliveredHits = new Map<string, { entry?: PrefetchEntry, expiresAt: number }>()
  const cancelledUnclaimed = new Map<string, number>()
  const cancelledAfterClaim = new Map<string, number>()

  function cleanupExpired(at = now()) {
    for (const [key, entry] of refreshable) {
      if (entry.deadlineAt <= at) refreshable.delete(key)
    }
    for (const [key, record] of deliveredHits) {
      if (record.expiresAt <= at) deliveredHits.delete(key)
    }
    for (const [key, expiresAt] of cancelledUnclaimed) {
      if (expiresAt <= at) cancelledUnclaimed.delete(key)
    }
    for (const [key, expiresAt] of cancelledAfterClaim) {
      if (expiresAt <= at) cancelledAfterClaim.delete(key)
    }
    for (const [key, entry] of entries) {
      if (entry.settled && entry.expiresAt <= at) {
        const status = entry.result?.status
        if (status === 'hit' && !entry.stale && ownerAvailable
          && entry.ownerEpoch !== undefined && entry.ownerEpoch === currentEpoch
          && entry.revision !== undefined && entry.revision === currentRevision) {
          // Retain valid versioned hits until claimed, cancelled, or invalidated by revision/epoch change.
          continue
        }
        if (status === 'skipped' || status === 'timeout' || status === 'empty' || status === 'unavailable') {
          deliveryTerminals.set(key, { status, deadlineAt: entry.deadlineAt })
        } else {
          // Invalidated or unavailable hit past TTL: preserve as timeout terminal so late claim never re-searches.
          deliveryTerminals.set(key, { status: 'timeout', deadlineAt: entry.deadlineAt })
        }
        entries.delete(key)
      }
    }
  }

  function isCancelledKey(key: string, at = now()): boolean {
    const u = cancelledUnclaimed.get(key)
    if (u !== undefined && u > at) return true
    const a = cancelledAfterClaim.get(key)
    if (a !== undefined && a > at) return true
    return false
  }

  function cancelledIdsForSession(sessionId: string, excludeRequestId?: string, at = now()): string[] {
    const prefix = `${sessionId}\0`
    const ids: string[] = []
    for (const [key, expiresAt] of cancelledAfterClaim) {
      if (expiresAt <= at) {
        cancelledAfterClaim.delete(key)
        continue
      }
      if (!key.startsWith(prefix)) continue
      const reqId = key.slice(prefix.length)
      if (reqId && reqId !== excludeRequestId) ids.push(reqId)
    }
    return ids
  }

  function attachCancelled(sessionId: string, excludeRequestId: string | undefined, claim: ClaimPrefetchResult): ClaimPrefetchResult {
    const ids = cancelledIdsForSession(sessionId, excludeRequestId)
    return ids.length ? { ...claim, cancelledRequestIds: ids } : claim
  }

  function invalidateUnclaimedHits(reason: 'changed' | 'unavailable') {
    for (const entry of entries.values()) {
      if (!entry.settled) {
        entry.stale = true
        if (reason === 'unavailable') {
          entry.controller?.abort()
          clearTimeout(entry.timer)
          entry.settled = true
          entry.result = { status: 'unavailable' }
        }
      } else if (entry.result?.status === 'hit') {
        entry.stale = true
      }
    }
  }

  function acceptProfile(next: MemoryProfileSnapshot): boolean {
    if (latestProfile && latestProfile.epoch === next.epoch && next.revision < latestProfile.revision) {
      return false
    }
    latestProfile = { epoch: next.epoch, revision: next.revision, text: next.text }
    return true
  }

  function onState(state: MemoryOwnerState) {
    const epochChanged = currentEpoch !== undefined && currentEpoch !== state.epoch
    if (state.state !== 'ready') {
      ownerAvailable = false
      if (epochChanged) {
        currentEpoch = state.epoch
        currentRevision = state.revision
      }
      invalidateUnclaimedHits('unavailable')
      return
    }
    const revisionChanged = currentEpoch === state.epoch && currentRevision !== undefined && state.revision !== currentRevision
    currentEpoch = state.epoch
    currentRevision = state.revision
    ownerAvailable = true
    if (epochChanged || revisionChanged) invalidateUnclaimedHits('changed')
  }

  function onChange(change: MemoryOwnerChange) {
    if (currentEpoch !== change.epoch) return
    if (currentRevision === undefined || change.revision > currentRevision) {
      currentRevision = change.revision
      invalidateUnclaimedHits('changed')
    }
  }

  function onProfile(event: MemoryOwnerProfile): boolean {
    if (currentEpoch && event.epoch !== currentEpoch) return false
    return acceptProfile({ epoch: event.epoch, revision: event.revision, text: event.text })
  }

  function onUnavailable() {
    ownerAvailable = false
    invalidateUnclaimedHits('unavailable')
  }

  function versionCurrent(epoch: string | undefined, revision: number | undefined): boolean {
    return ownerAvailable && epoch !== undefined && revision !== undefined
      && epoch === currentEpoch && revision === currentRevision
  }

  function startPrefetch(input: PrefetchStartInput) {
    cleanupExpired()
    const key = prefetchKey(input.sessionId, input.requestId)
    cancelledUnclaimed.delete(key)
    cancelledAfterClaim.delete(key)
    deliveredHits.delete(key)
    const previous = entries.get(key)
    if (previous) {
      previous.controller?.abort()
      clearTimeout(previous.timer)
      entries.delete(key)
    }
    const budgetMs = Math.max(1, input.budgetMs ?? defaultBudgetMs)
    const startedAt = now()
    const deadlineAt = startedAt + budgetMs
    const expiresAt = startedAt + cacheTtlMs

    if (!input.queryText.trim() || looksSecret(input.queryText)) {
      // Never retain skipped/sensitive query text in memory; keep only the terminal status until consumed or cancelled.
      deliveryTerminals.set(key, { status: 'skipped', deadlineAt })
      return
    }
    deliveryTerminals.delete(key)

    if (!ownerAvailable || !currentEpoch || currentRevision === undefined) {
      entries.set(key, {
        key, requestId: input.requestId, sessionId: input.sessionId, queryText: '',
        cwd: input.cwd, context: input.context, project: input.project,
        deadlineAt, expiresAt, ownerEpoch: currentEpoch, revision: currentRevision,
        stale: false, settled: true, requeried: false, result: { status: 'unavailable' },
      })
      return
    }

    const controller = new AbortController()
    const entry: PrefetchEntry = {
      key, requestId: input.requestId, sessionId: input.sessionId, queryText: input.queryText,
      cwd: input.cwd, context: input.context, project: input.project,
      deadlineAt, expiresAt, ownerEpoch: currentEpoch, revision: currentRevision,
      stale: false, settled: false, requeried: false, controller,
    }
    entry.timer = setTimeout(() => {
      if (!entry.settled) {
        entry.settled = true
        entry.result = { status: 'timeout' }
        entry.queryText = ''
        controller.abort(new RequestTimeout())
      }
    }, budgetMs)
    entry.timer.unref?.()

    entry.work = callPrefetch({
      session: input.sessionId,
      query: input.queryText,
      cwd: input.cwd,
      ...(input.context ? { context: input.context } : {}),
      ...(input.project ? { project: input.project } : {}),
    }, { signal: controller.signal, budgetMs }).then(reply => {
      clearTimeout(entry.timer)
      if (entry.settled) return
      // Enforce absolute deadline even if the reply arrives before the setTimeout callback executes.
      if (now() >= entry.deadlineAt) {
        entry.settled = true
        entry.result = { status: 'timeout' }
        entry.queryText = ''
        return
      }
      entry.ownerEpoch = reply.epoch
      entry.revision = reply.revision
      if (reply.result.status === 'hit') {
        // Write-side double-point invalidation check: accept only when the worker snapshot matches the live (epoch, revision).
        if (!versionCurrent(reply.epoch, reply.revision)) {
          entry.stale = true
          entry.settled = true
          entry.result = undefined
          return
        }
        entry.stale = false
      }
      entry.settled = true
      entry.result = reply.result
    }, error => {
      clearTimeout(entry.timer)
      if (entry.settled) return
      entry.settled = true
      entry.queryText = ''
      entry.result = error instanceof RequestTimeout || controller.signal.aborted
        ? { status: 'timeout' }
        : { status: ownerAvailable ? 'timeout' : 'unavailable' }
    })

    entries.set(key, entry)
  }

  async function runRequeryOnce(entry: PrefetchEntry, remainingMs: number, signal?: AbortSignal): Promise<{ result: AutomaticRecallResult, epoch?: string, revision?: number }> {
    entry.requeried = true
    if (entry.cancelled) return { result: { status: 'skipped' } }
    if (!ownerAvailable || remainingMs <= 0 || now() >= entry.deadlineAt || signal?.aborted) {
      return { result: ownerAvailable ? { status: 'timeout' } : { status: 'unavailable' } }
    }
    const reqEpoch = currentEpoch
    const reqRevision = currentRevision
    if (!reqEpoch || reqRevision === undefined) return { result: { status: 'unavailable' } }
    const controller = new AbortController()
    entry.controller = controller
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new RequestTimeout()), remainingMs)
    entry.timer = timer
    timer.unref?.()
    let abortReject: (reason?: unknown) => void = () => {}
    const onControllerAbort = () => abortReject(controller.signal.reason ?? new RequestTimeout())
    controller.signal.addEventListener('abort', onControllerAbort, { once: true })
    try {
      const work = callPrefetch({
        session: entry.sessionId,
        query: entry.queryText,
        cwd: entry.cwd,
        ...(entry.context ? { context: entry.context } : {}),
        ...(entry.project ? { project: entry.project } : {}),
      }, { signal: controller.signal, budgetMs: remainingMs })
      // Prevent unhandled rejection if abort wins the race before work settles.
      work.catch(() => {})
      const reply = await Promise.race([
        work,
        new Promise<never>((_, reject) => { abortReject = reject }),
      ])
      if (entry.cancelled) return { result: { status: 'skipped' } }
      if (now() >= entry.deadlineAt) return { result: { status: 'timeout' } }
      if (reply.result.status === 'hit') {
        if (reply.epoch !== reqEpoch || reply.revision !== reqRevision || !versionCurrent(reply.epoch, reply.revision)) {
          return { result: { status: 'timeout' } }
        }
      }
      return { result: reply.result, epoch: reply.epoch, revision: reply.revision }
    } catch (error) {
      if (entry.cancelled) return { result: { status: 'skipped' } }
      if (error instanceof RequestTimeout || controller.signal.aborted) return { result: { status: 'timeout' } }
      return { result: ownerAvailable ? { status: 'timeout' } : { status: 'unavailable' } }
    } finally {
      clearTimeout(timer)
      if (entry.controller === controller) entry.controller = undefined
      if (entry.timer === timer) entry.timer = undefined
      controller.signal.removeEventListener('abort', onControllerAbort)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function claimSingleInternal(
    requestId: string,
    sessionId: string,
    signal?: AbortSignal,
    options: { handoffToRefreshable?: boolean, keepClaiming?: boolean } = {},
  ): Promise<{ claim: ClaimPrefetchResult, entry?: PrefetchEntry }> {
    cleanupExpired()
    const key = prefetchKey(sessionId, requestId)
    const entry = entries.get(key)
    if (!entry) {
      const cancelledUntil = cancelledUnclaimed.get(key)
      if (cancelledUntil !== undefined) {
        cancelledUnclaimed.delete(key)
        if (cancelledUntil > now()) {
          return { claim: { found: true, result: { status: 'skipped' } } }
        }
      }
      const afterClaimUntil = cancelledAfterClaim.get(key)
      if (afterClaimUntil !== undefined && afterClaimUntil > now()) {
        return { claim: { found: true, result: { status: 'skipped' } } }
      }
      const terminal = deliveryTerminals.get(key)
      if (terminal) {
        deliveryTerminals.delete(key)
        return { claim: { found: true, result: { status: terminal.status } } }
      }
      return { claim: { found: false } }
    }
    entries.delete(key)
    deliveryTerminals.delete(key)
    claiming.set(key, entry)
    const handoff = (claim: ClaimPrefetchResult) => {
      if (claim.found && claim.result.status === 'hit' && !entry.cancelled && !isCancelledKey(entry.key)) {
        boundedSet(deliveredHits, entry.key, { entry, expiresAt: now() + cacheTtlMs })
        if (options.handoffToRefreshable && !entry.requeried && entry.deadlineAt > now()) {
          refreshable.set(entry.key, entry)
        }
      }
      return { claim, entry }
    }
    try {
      // Step 1: Consume valid completed terminal results FIRST (even if now() > deadlineAt).
      if (entry.settled) {
        if (entry.cancelled) return { claim: { found: true, result: { status: 'skipped' } } }
        if (entry.result && entry.result.status !== 'hit') {
          return { claim: { found: true, result: entry.result }, entry }
        }
        if (entry.result?.status === 'hit' && !entry.stale && versionCurrent(entry.ownerEpoch, entry.revision)) {
          return handoff({ found: true, result: entry.result, epoch: entry.ownerEpoch, revision: entry.revision, deadlineAt: entry.deadlineAt, retried: entry.requeried })
        }
        // Stale hit: allow at most one re-query within remaining original budget.
        const remaining = entry.deadlineAt - now()
        if (remaining > 0 && !entry.requeried) {
          const retried = await runRequeryOnce(entry, remaining, signal)
          if (entry.cancelled) return { claim: { found: true, result: { status: 'skipped' } } }
          return { claim: { found: true, ...retried, deadlineAt: entry.deadlineAt, retried: true }, entry }
        }
        return { claim: { found: true, result: { status: 'timeout' } }, entry }
      }

      // Step 2: Still pending — check remaining original deadline.
      const remaining = entry.deadlineAt - now()
      if (remaining <= 0) {
        entry.controller?.abort(new RequestTimeout())
        clearTimeout(entry.timer)
        return { claim: { found: true, result: { status: 'timeout' } }, entry }
      }
      if (entry.work && !entry.cancelled) {
        let wake: () => void = () => {}
        const onAbort = () => wake()
        const entrySignal = entry.controller?.signal
        signal?.addEventListener('abort', onAbort, { once: true })
        entrySignal?.addEventListener('abort', onAbort, { once: true })
        const waitTimer = setTimeout(() => {
          entry.controller?.abort(new RequestTimeout())
          wake()
        }, remaining)
        waitTimer.unref?.()
        try {
          if (!signal?.aborted && !entrySignal?.aborted && !entry.cancelled) {
            await Promise.race([
              entry.work,
              new Promise<void>(resolve => { wake = resolve }),
            ])
          }
        } finally {
          clearTimeout(waitTimer)
          signal?.removeEventListener('abort', onAbort)
          entrySignal?.removeEventListener('abort', onAbort)
        }
      }
      if (entry.cancelled) return { claim: { found: true, result: { status: 'skipped' } } }

      if (entry.settled && entry.result) {
        if (entry.result.status !== 'hit') return { claim: { found: true, result: entry.result }, entry }
        // Claim-side double-point invalidation check.
        if (!entry.stale && versionCurrent(entry.ownerEpoch, entry.revision)) {
          return handoff({ found: true, result: entry.result, epoch: entry.ownerEpoch, revision: entry.revision, deadlineAt: entry.deadlineAt, retried: entry.requeried })
        }
      }
      // Invalidated while pending: allow at most one re-query within remaining original budget.
      const afterWaitRemaining = entry.deadlineAt - now()
      if (entry.stale && afterWaitRemaining > 0 && !entry.requeried && !signal?.aborted) {
        const retried = await runRequeryOnce(entry, afterWaitRemaining, signal)
        if (entry.cancelled) return { claim: { found: true, result: { status: 'skipped' } } }
        return { claim: { found: true, ...retried, deadlineAt: entry.deadlineAt, retried: true }, entry }
      }
      return { claim: { found: true, result: { status: 'timeout' } }, entry }
    } finally {
      if (!options.keepClaiming && claiming.get(key) === entry) claiming.delete(key)
    }
  }

  async function claimPrefetch({ requestId, sessionId, signal }: {
    requestId: string
    sessionId: string
    signal?: AbortSignal
  }): Promise<ClaimPrefetchResult> {
    const key = prefetchKey(sessionId, requestId)
    const { claim, entry } = await claimSingleInternal(requestId, sessionId, signal, { handoffToRefreshable: true })
    if (entry?.cancelled || isCancelledKey(key)) {
      refreshable.delete(key)
      deliveredHits.delete(key)
      return attachCancelled(sessionId, requestId, { found: true, result: { status: 'skipped' } })
    }
    if (claim.found && claim.result.status === 'hit') {
      boundedSet(deliveredHits, key, { entry, expiresAt: now() + cacheTtlMs })
    }
    return attachCancelled(sessionId, requestId, claim)
  }

  /** Perform at most one bounded refresh on the host using the original verified query/scope/deadline. */
  async function refreshPrefetch({ requestId, sessionId, signal }: {
    requestId: string
    sessionId: string
    signal?: AbortSignal
  }): Promise<ClaimPrefetchResult> {
    const key = prefetchKey(sessionId, requestId)
    const entry = refreshable.get(key)
    refreshable.delete(key)
    if (entry?.cancelled || isCancelledKey(key)) {
      deliveredHits.delete(key)
      return attachCancelled(sessionId, requestId, { found: true, result: { status: 'skipped' } })
    }
    if (!entry || entry.requeried || signal?.aborted) {
      return attachCancelled(sessionId, requestId, { found: true, result: { status: 'timeout' } })
    }
    const remaining = entry.deadlineAt - now()
    if (remaining <= 0) return attachCancelled(sessionId, requestId, { found: true, result: { status: 'timeout' } })
    claiming.set(key, entry)
    try {
      const retried = await runRequeryOnce(entry, remaining, signal)
      if (entry.cancelled || isCancelledKey(key)) {
        deliveredHits.delete(key)
        return attachCancelled(sessionId, requestId, { found: true, result: { status: 'skipped' } })
      }
      if (retried.result.status === 'hit') {
        boundedSet(deliveredHits, key, { entry, expiresAt: now() + cacheTtlMs })
      }
      return attachCancelled(sessionId, requestId, { found: true, ...retried, deadlineAt: entry.deadlineAt, retried: true })
    } finally {
      if (claiming.get(key) === entry) claiming.delete(key)
    }
  }

  /** Claim multiple messages in the same step in parallel and verify every hit against live version before adoption. */
  async function claimPrefetchBatch({ requestIds, sessionId, signal }: {
    requestIds: readonly string[]
    sessionId: string
    signal?: AbortSignal
  }): Promise<ClaimPrefetchResult[]> {
    const claimed = await Promise.all(requestIds.map(requestId =>
      claimSingleInternal(requestId, sessionId, signal, { keepClaiming: true }),
    ))
    try {
      // Re-check every resolved hit against live (epoch, revision) after sibling claims complete.
      const rechecked = await Promise.all(claimed.map(async ({ claim, entry }) => {
        if (entry?.cancelled) return { claim: { found: true as const, result: { status: 'skipped' as const } }, entry }
        if (!claim.found || claim.result.status !== 'hit') return { claim, entry }
        if (versionCurrent(claim.epoch, claim.revision)) return { claim, entry }
        if (entry && !entry.requeried && !signal?.aborted) {
          const remaining = entry.deadlineAt - now()
          if (remaining > 0) {
            const retried = await runRequeryOnce(entry, remaining, signal)
            if (entry.cancelled) return { claim: { found: true as const, result: { status: 'skipped' as const } }, entry }
            return { claim: { found: true as const, ...retried }, entry }
          }
        }
        return { claim: { found: true as const, result: { status: 'timeout' as const } }, entry }
      }))
      // Final synchronous sweep so no sibling re-query or late cancel can mask invalidation or cancellation.
      return rechecked.map(({ claim, entry }) => {
        if (entry?.cancelled) return { found: true as const, result: { status: 'skipped' as const } }
        if (claim.found && claim.result.status === 'hit' && !versionCurrent(claim.epoch, claim.revision)) {
          return { found: true as const, result: { status: 'timeout' as const } }
        }
        return claim
      })
    } finally {
      for (const { entry } of claimed) {
        if (entry && claiming.get(entry.key) === entry) claiming.delete(entry.key)
      }
    }
  }

  function cancelPrefetch(sessionId: string, requestId: string) {
    const key = prefetchKey(sessionId, requestId)
    const expiresAt = now() + cacheTtlMs
    const delivered = deliveredHits.get(key)
    if (delivered?.entry) delivered.entry.cancelled = true
    const wasDelivered = deliveredHits.delete(key) || refreshable.has(key)
    const entry = entries.get(key)
    if (entry) {
      entry.cancelled = true
      entry.controller?.abort()
      clearTimeout(entry.timer)
      entries.delete(key)
    }
    const activeClaim = claiming.get(key)
    if (activeClaim) {
      activeClaim.cancelled = true
      activeClaim.controller?.abort()
      clearTimeout(activeClaim.timer)
      claiming.delete(key)
    }
    deliveryTerminals.delete(key)
    const refreshEntry = refreshable.get(key)
    if (refreshEntry) {
      refreshEntry.cancelled = true
      refreshable.delete(key)
    }
    if (wasDelivered) {
      boundedSet(cancelledAfterClaim, key, expiresAt)
    } else if (!activeClaim) {
      // Retain a bounded cancellation record so a delayed claim consumes terminal `skipped` without adapter fallback.
      boundedSet(cancelledUnclaimed, key, expiresAt)
    } else {
      boundedSet(cancelledAfterClaim, key, expiresAt)
    }
    onCancelled?.({ sessionId, requestId })
  }

  function clearSession(sessionId: string) {
    const prefix = `${sessionId}\0`
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix)) {
        entry.cancelled = true
        entry.controller?.abort()
        clearTimeout(entry.timer)
        entries.delete(key)
      }
    }
    for (const [key, entry] of claiming) {
      if (key.startsWith(prefix)) {
        entry.cancelled = true
        entry.controller?.abort()
        clearTimeout(entry.timer)
        claiming.delete(key)
      }
    }
    for (const key of deliveryTerminals.keys()) {
      if (key.startsWith(prefix)) deliveryTerminals.delete(key)
    }
    for (const [key, entry] of refreshable) {
      if (key.startsWith(prefix)) {
        entry.cancelled = true
        refreshable.delete(key)
      }
    }
    for (const [key, record] of deliveredHits) {
      if (key.startsWith(prefix)) {
        if (record.entry) record.entry.cancelled = true
        deliveredHits.delete(key)
      }
    }
    for (const key of cancelledUnclaimed.keys()) {
      if (key.startsWith(prefix)) cancelledUnclaimed.delete(key)
    }
    for (const key of cancelledAfterClaim.keys()) {
      if (key.startsWith(prefix)) cancelledAfterClaim.delete(key)
    }
    onCancelled?.({ sessionId })
  }

  function close() {
    for (const entry of entries.values()) {
      entry.cancelled = true
      entry.controller?.abort()
      clearTimeout(entry.timer)
    }
    for (const entry of claiming.values()) {
      entry.cancelled = true
      entry.controller?.abort()
      clearTimeout(entry.timer)
    }
    for (const entry of refreshable.values()) {
      entry.cancelled = true
    }
    for (const record of deliveredHits.values()) {
      if (record.entry) record.entry.cancelled = true
    }
    entries.clear()
    claiming.clear()
    deliveryTerminals.clear()
    refreshable.clear()
    deliveredHits.clear()
    cancelledUnclaimed.clear()
    cancelledAfterClaim.clear()
  }

  return {
    onState, onChange, onProfile, onUnavailable,
    acceptProfile,
    profile: (): MemoryProfileSnapshot | undefined => latestProfile,
    startPrefetch, claimPrefetch, claimPrefetchBatch, refreshPrefetch, cancelPrefetch, clearSession, cleanupExpired, close,
  }
}
export type MemoryPrefetchManager = ReturnType<typeof createMemoryPrefetchManager>
