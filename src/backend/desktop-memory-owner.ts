import { createRequestBudget, INITIALIZATION_BUDGET_MS } from '../shared/request-budget.ts'
import path from 'node:path'
import { emitDiagnosticFailure } from '../diagnostics/node/context.ts'
import { DAILY_MEMORY_DEFAULTS } from '../memory/contracts/memory-daily-defaults.ts'
import { isDailyMemoryStage } from '../memory/contracts/memory-contract.ts'
import { MEMORY_HOST_PROTOCOL, memoryOwnerChange, memoryOwnerProfile, memoryOwnerState } from '../memory/contracts/host.ts'
import type { OwnerAdapterApi } from '../memory/node/owner-adapter.ts'
import { createOwnerRpcPeer } from '../memory/node/owner-rpc-peer.ts'
import { createMemoryOwnerSupervisor } from '../memory/node/owner-supervisor.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { createMemoryPrefetchManager, type PrefetchStartInput } from './memory-prefetch.ts'
import { createRemoteMemoryChannel, MemoryOwnerUnavailable, type MemoryChannelEvents } from './remote-memory-channel.ts'

type Supervisor = ReturnType<typeof createMemoryOwnerSupervisor>
type SupervisorOptions = Parameters<typeof createMemoryOwnerSupervisor>[0]
type AdapterLink = { peer: ReturnType<typeof createOwnerRpcPeer>, attached: boolean, reconciledEpoch?: string }
const MODEL_CALLBACK_MS = 130_000

function requestSession(method: string, args: unknown[]) {
  switch (method) {
    case 'receiveSource': case 'completeTurn': return objectOf(args[0])?.sessionId
    case 'sidecarRequest': case 'automaticRecall': case 'reportContextUsed': return objectOf(args[0])?.session
    case 'bindIntakeSession': case 'intakeWatermark': case 'advanceIntake':
    case 'rememberStandaloneFile': case 'forgetStandaloneFile': return args[0]
  }
}

/** The backend owns the process and host IPC. dsh gets a relay for adapter operations only. */
export function createDesktopMemoryOwner(settings: Pick<SupervisorOptions, 'root' | 'embedding' | 'dailyNotes'>,
  events: MemoryChannelEvents) {
  let owner: Supervisor | undefined
  let adapter: AdapterLink | undefined
  let adapterRelease = Promise.resolve()
  let closing = false
  let currentProfileDeletionGen: number | undefined
  const channel = createRemoteMemoryChannel({ ...events, callOwner(method, input, options) {
    if (!owner) throw new MemoryOwnerUnavailable()
    return owner.callHost(method, input, options)
  } })
  const prefetch = createMemoryPrefetchManager({
    callPrefetch(input, options) {
      if (!owner) return Promise.reject(new MemoryOwnerUnavailable())
      return owner.callHost('prefetchRecall', input, options)
    },
    onCancelled({ sessionId, requestId }) {
      if (adapter?.attached) {
        try {
          adapter.peer.notify({
            type: 'memory_owner_prefetch_cancelled',
            protocol: MEMORY_HOST_PROTOCOL,
            sessionId,
            ...(requestId ? { requestId } : {}),
          })
        } catch { /* dsh is exiting */ }
      }
    },
  })

  function adapterCall<T>(method: string, input: object, signal: AbortSignal, budgetMs: number): Promise<T> {
    if (!adapter?.attached) return Promise.reject(new MemoryOwnerUnavailable('Memory adapter is unavailable'))
    return adapter.peer.call<T>(method, input, { signal, budgetMs })
  }

  function bindDsh(send: Parameters<typeof createOwnerRpcPeer>[0]['send'], exited: Promise<void>,
    foregroundSignal: (session: string) => AbortSignal | undefined, onReady?: () => void) {
    if (adapter) throw new Error('The previous dsh memory channel is still active')
    const waiters = new Set<() => void>()
    const notifyWaiters = () => { for (const wake of waiters) wake() }
    const previousAdapter = adapterRelease
    const ready = () => adapter === link && channel.ready() && link.reconciledEpoch === owner?.epoch()
    const peer = createOwnerRpcPeer({ send, onEvent(raw) {
      const event = objectOf(raw)
      if (!link.attached || adapter !== link || event?.type !== 'memory_adapter_ready' || typeof event.ready !== 'boolean'
        || typeof event.epoch !== 'string' || event.epoch !== owner?.epoch()) return
      const wasReady = ready()
      link.reconciledEpoch = event.ready ? event.epoch : undefined
      if (!wasReady && ready()) { notifyWaiters(); onReady?.() }
    }, async handle(method, input, signal, budgetMs) {
      const data = objectOf(input)
      if (method === 'attach') {
        if (!data || data.protocol !== MEMORY_HOST_PROTOCOL || typeof data.root !== 'string'
          || path.resolve(data.root) !== path.resolve(settings.root) || data.hostNamespace !== 'viva') {
          throw new Error('Memory adapter owner binding differs')
        }
        await previousAdapter
        signal.throwIfAborted()
        if (adapter !== link) throw new MemoryOwnerUnavailable()
        link.attached = true
        return { state: channel.state(), profile: prefetch.profile() }
      }
      if (method === 'claimPrefetch') {
        if (!link.attached || adapter !== link || !data
          || typeof data.requestId !== 'string' || typeof data.sessionId !== 'string') {
          return { found: false }
        }
        const lifetime = foregroundSignal(data.sessionId)
        if (lifetime?.aborted) return { found: true, result: { status: 'unavailable' } }
        return prefetch.claimPrefetch({
          requestId: data.requestId,
          sessionId: data.sessionId,
          signal: lifetime ? AbortSignal.any([signal, lifetime]) : signal,
        })
      }
      if (method === 'refreshPrefetch') {
        if (!link.attached || adapter !== link || !data
          || typeof data.requestId !== 'string' || typeof data.sessionId !== 'string') {
          return { found: true, result: { status: 'timeout' } }
        }
        const lifetime = foregroundSignal(data.sessionId)
        if (lifetime?.aborted) return { found: true, result: { status: 'unavailable' } }
        return prefetch.refreshPrefetch({
          requestId: data.requestId,
          sessionId: data.sessionId,
          signal: lifetime ? AbortSignal.any([signal, lifetime]) : signal,
        })
      }
      if (method !== 'adapter' || !link.attached || adapter !== link || !owner
        || typeof data?.method !== 'string' || !Array.isArray(data.args) || !data.epoch || data.epoch !== owner.epoch()) {
        throw new MemoryOwnerUnavailable()
      }
      const operation = data.method as keyof OwnerAdapterApi
      const args = data.args
      const session = requestSession(operation, args)
      const lifetime = typeof session === 'string' ? foregroundSignal(session) : undefined
      lifetime?.throwIfAborted()
      return owner.callAdapter(operation, args as Parameters<OwnerAdapterApi[keyof OwnerAdapterApi]>,
        { signal: lifetime ? AbortSignal.any([signal, lifetime]) : signal, budgetMs })
    } })
    const link: AdapterLink = { peer, attached: false }
    adapter = link
    adapterRelease = exited.then(async () => {
      peer.close()
      if (adapter === link) {
        adapter = undefined
        prefetch.close()
        notifyWaiters()
        if (!closing) await owner?.adapterExited()
      }
    }).catch(error => emitDiagnosticFailure('memory.owner', error, { stage: 'recovering' }))
    return {
      receive: peer.receive,
      ready,
      async waitReady() {
        if (ready()) return
        const budget = createRequestBudget(INITIALIZATION_BUDGET_MS)
        let wake: () => void = () => {}
        try {
          await budget.run(() => new Promise<void>((resolve, reject) => {
            wake = () => {
              if (adapter !== link) reject(new MemoryOwnerUnavailable())
              else if (ready()) resolve()
            }
            waiters.add(wake)
            wake()
          }))
        } finally { waiters.delete(wake); budget.close() }
      },

    }
  }

  const create = () => createMemoryOwnerSupervisor({
    ...settings, hostNamespace: 'viva',
    onEvent(event) {
      if (closing) return
      let forward = true
      const state = memoryOwnerState.safeParse(event)
      if (state.success) {
        if (state.data.profileDeletionGen !== undefined) currentProfileDeletionGen = state.data.profileDeletionGen
        prefetch.onState(state.data)
      }
      else {
        const change = memoryOwnerChange.safeParse(event)
        if (change.success) prefetch.onChange(change.data)
        else {
          const profile = memoryOwnerProfile.safeParse(event)
          if (profile.success) {
            if (profile.data.profileDeletionGen !== undefined) currentProfileDeletionGen = profile.data.profileDeletionGen
            forward = prefetch.onProfile(profile.data)
          }
        }
      }
      try { channel.receive(event) }
      finally {
        if (forward && adapter?.attached) {
          try { adapter.peer.notify(event) } catch { /* dsh is exiting */ }
        }
      }
    },
    callbacks: {
      compute: (input, signal) => adapterCall<string>('compute', input, signal,
        isDailyMemoryStage(input.job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : MODEL_CALLBACK_MS),
    },
  })

  async function release() {
    const current = owner
    if (!current) return
    await current.close()
    if (owner === current) {
      owner = undefined
      prefetch.onUnavailable()
      channel.processExited()
    }
  }

  return {
    channel, bindDsh,
    prefetch,
    startPrefetch: (input: PrefetchStartInput) => prefetch.startPrefetch(input),
    cancelPrefetch: (sessionId: string, requestId: string) => prefetch.cancelPrefetch(sessionId, requestId),
    finishPrefetch: (sessionId: string, requestId: string) => prefetch.finishPrefetch(sessionId, requestId),
    clearSessionPrefetches: (sessionId: string) => prefetch.clearSession(sessionId),
    profile: () => prefetch.profile(),
    profileDeletionGen: () => currentProfileDeletionGen,
    pid: () => owner?.pid() ?? null,
    async prepare() {
      if (closing) throw new MemoryOwnerUnavailable()
      owner ??= create()
      void owner.start().catch(error => emitDiagnosticFailure('memory.owner', error, { stage: 'unavailable' }))
    },
    close() {
      closing = true
      prefetch.close()
      channel.close()
      return release()
    },
  }
}
export type DesktopMemoryOwner = ReturnType<typeof createDesktopMemoryOwner>
