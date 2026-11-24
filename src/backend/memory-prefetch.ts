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
  | { found: false }
  | { found: true, result: AutomaticRecallResult }

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
  result?: AutomaticRecallResult
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  work?: Promise<void>
}

const DEFAULT_CACHE_TTL_MS = 60_000
const MAX_SKIPPED_DELIVERIES = 1_000

const prefetchKey = (sessionId: string, requestId: string) => `${sessionId}\0${requestId}`

/**
 * Host-side L2 profile cache and L3 automatic-recall prefetch coordinator.
 * - Caches monotonic `{ epoch, revision, text }` snapshots (accepting `text: ''` as a valid update);
 * - Starts L3 prefetch at the exact validated dispatch point keyed by `(requestId, sessionId)`;
 * - Enforces double-point `{ ownerEpoch, revision }` invalidation (both on reply write and on claim);
 * - Preserves `skipped` delivery markers across cache TTL eviction until consumed.
 */
export function createMemoryPrefetchManager({
  callPrefetch,
  now = Date.now,
  defaultBudgetMs = DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
}: {
  callPrefetch: (
    input: HostMemoryApi['prefetchRecall']['input'],
    options: { signal: AbortSignal, budgetMs: number },
  ) => Promise<HostMemoryApi['prefetchRecall']['output']>
  now?: () => number
  defaultBudgetMs?: number
  cacheTtlMs?: number
}) {
  let currentEpoch: string | undefined
  let currentRevision: number | undefined
  let ownerAvailable = false
  let latestProfile: MemoryProfileSnapshot | undefined
  const entries = new Map<string, PrefetchEntry>()
  const skippedDeliveries = new Set<string>()

  function cleanupExpired(at = now()) {
    for (const [key, entry] of entries) {
      if (entry.settled && entry.expiresAt <= at) entries.delete(key)
    }
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

  function rememberSkipped(key: string) {
    if (skippedDeliveries.size >= MAX_SKIPPED_DELIVERIES) {
      const oldest = skippedDeliveries.values().next().value
      if (oldest !== undefined) skippedDeliveries.delete(oldest)
    }
    skippedDeliveries.add(key)
  }

  function versionCurrent(epoch: string | undefined, revision: number | undefined): boolean {
    return ownerAvailable && epoch !== undefined && revision !== undefined
      && epoch === currentEpoch && revision === currentRevision
  }

  function startPrefetch(input: PrefetchStartInput) {
    cleanupExpired()
    const key = prefetchKey(input.sessionId, input.requestId)
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
      rememberSkipped(key)
      entries.set(key, {
        key, requestId: input.requestId, sessionId: input.sessionId, queryText: input.queryText,
        cwd: input.cwd, context: input.context, project: input.project,
        deadlineAt, expiresAt, ownerEpoch: currentEpoch, revision: currentRevision,
        stale: false, settled: true, result: { status: 'skipped' },
      })
      return
    }
    skippedDeliveries.delete(key)

    if (!ownerAvailable || !currentEpoch || currentRevision === undefined) {
      entries.set(key, {
        key, requestId: input.requestId, sessionId: input.sessionId, queryText: input.queryText,
        cwd: input.cwd, context: input.context, project: input.project,
        deadlineAt, expiresAt, ownerEpoch: currentEpoch, revision: currentRevision,
        stale: false, settled: true, result: { status: 'unavailable' },
      })
      return
    }

    const controller = new AbortController()
    const entry: PrefetchEntry = {
      key, requestId: input.requestId, sessionId: input.sessionId, queryText: input.queryText,
      cwd: input.cwd, context: input.context, project: input.project,
      deadlineAt, expiresAt, ownerEpoch: currentEpoch, revision: currentRevision,
      stale: false, settled: false, controller,
    }
    entry.timer = setTimeout(() => {
      if (!entry.settled) {
        entry.settled = true
        entry.result = { status: 'timeout' }
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
      entry.result = error instanceof RequestTimeout || controller.signal.aborted
        ? { status: 'timeout' }
        : { status: ownerAvailable ? 'timeout' : 'unavailable' }
    })

    entries.set(key, entry)
  }

  async function runRequeryOnce(entry: PrefetchEntry, remainingMs: number, signal?: AbortSignal): Promise<AutomaticRecallResult> {
    if (!ownerAvailable || remainingMs <= 0 || signal?.aborted) return ownerAvailable ? { status: 'timeout' } : { status: 'unavailable' }
    const reqEpoch = currentEpoch
    const reqRevision = currentRevision
    if (!reqEpoch || reqRevision === undefined) return { status: 'unavailable' }
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new RequestTimeout()), remainingMs)
    timer.unref?.()
    try {
      const reply = await callPrefetch({
        session: entry.sessionId,
        query: entry.queryText,
        cwd: entry.cwd,
        ...(entry.context ? { context: entry.context } : {}),
        ...(entry.project ? { project: entry.project } : {}),
      }, { signal: controller.signal, budgetMs: remainingMs })
      if (reply.result.status === 'hit') {
        if (reply.epoch !== reqEpoch || reply.revision !== reqRevision || !versionCurrent(reply.epoch, reply.revision)) {
          return { status: 'timeout' }
        }
      }
      return reply.result
    } catch (error) {
      if (error instanceof RequestTimeout || controller.signal.aborted) return { status: 'timeout' }
      return ownerAvailable ? { status: 'timeout' } : { status: 'unavailable' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function claimPrefetch({ requestId, sessionId, signal }: {
    requestId: string
    sessionId: string
    signal?: AbortSignal
  }): Promise<ClaimPrefetchResult> {
    cleanupExpired()
    const key = prefetchKey(sessionId, requestId)
    const entry = entries.get(key)
    if (!entry) {
      if (skippedDeliveries.delete(key)) {
        return { found: true, result: { status: 'skipped' } }
      }
      return { found: false }
    }
    entries.delete(key)
    skippedDeliveries.delete(key)

    // Step 1: Consume valid completed terminal results FIRST (even if now() > deadlineAt).
    if (entry.settled) {
      if (entry.result && entry.result.status !== 'hit') {
        return { found: true, result: entry.result }
      }
      if (entry.result?.status === 'hit' && !entry.stale && versionCurrent(entry.ownerEpoch, entry.revision)) {
        return { found: true, result: entry.result }
      }
      // Stale hit: allow at most one re-query within remaining original budget.
      const remaining = entry.deadlineAt - now()
      if (remaining > 0) {
        return { found: true, result: await runRequeryOnce(entry, remaining, signal) }
      }
      return { found: true, result: { status: 'timeout' } }
    }

    // Step 2: Still pending — check remaining original deadline.
    const remaining = entry.deadlineAt - now()
    if (remaining <= 0) {
      entry.controller?.abort(new RequestTimeout())
      clearTimeout(entry.timer)
      return { found: true, result: { status: 'timeout' } }
    }
    if (entry.work) {
      let wake: () => void = () => {}
      const onAbort = () => wake()
      signal?.addEventListener('abort', onAbort, { once: true })
      const waitTimer = setTimeout(() => {
        entry.controller?.abort(new RequestTimeout())
        wake()
      }, remaining)
      waitTimer.unref?.()
      try {
        await Promise.race([
          entry.work,
          new Promise<void>(resolve => { wake = resolve }),
        ])
      } finally {
        clearTimeout(waitTimer)
        signal?.removeEventListener('abort', onAbort)
      }
    }

    if (entry.settled && entry.result) {
      if (entry.result.status !== 'hit') return { found: true, result: entry.result }
      // Claim-side double-point invalidation check.
      if (!entry.stale && versionCurrent(entry.ownerEpoch, entry.revision)) {
        return { found: true, result: entry.result }
      }
    }
    // Invalidated while pending: allow at most one re-query within remaining original budget.
    const afterWaitRemaining = entry.deadlineAt - now()
    if (entry.stale && afterWaitRemaining > 0 && !signal?.aborted) {
      return { found: true, result: await runRequeryOnce(entry, afterWaitRemaining, signal) }
    }
    return { found: true, result: { status: 'timeout' } }
  }

  function close() {
    for (const entry of entries.values()) {
      entry.controller?.abort()
      clearTimeout(entry.timer)
    }
    entries.clear()
    skippedDeliveries.clear()
  }

  return {
    onState, onChange, onProfile, onUnavailable,
    acceptProfile,
    profile: (): MemoryProfileSnapshot | undefined => latestProfile,
    startPrefetch, claimPrefetch, cleanupExpired, close,
  }
}
export type MemoryPrefetchManager = ReturnType<typeof createMemoryPrefetchManager>
