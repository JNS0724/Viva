import { createRequestBudget, INITIALIZATION_BUDGET_MS } from '../shared/request-budget.ts'
import path from 'node:path'
import { DAILY_MEMORY_DEFAULTS } from '../memory/contracts/memory-daily-defaults.ts'
import { isDailyMemoryStage } from '../memory/contracts/memory-contract.ts'
import { MEMORY_HOST_PROTOCOL } from '../memory/contracts/host.ts'
import type { OwnerAdapterApi } from '../memory/node/owner-adapter.ts'
import { createOwnerRpcPeer } from '../memory/node/owner-rpc-peer.ts'
import { createMemoryOwnerSupervisor } from '../memory/node/owner-supervisor.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { createRemoteMemoryChannel, MemoryOwnerUnavailable, type MemoryChannelEvents } from './remote-memory-channel.ts'

type Supervisor = ReturnType<typeof createMemoryOwnerSupervisor>
type SupervisorOptions = Parameters<typeof createMemoryOwnerSupervisor>[0]
type AdapterLink = { peer: ReturnType<typeof createOwnerRpcPeer>, attached: boolean, reconciledEpoch?: string }
const CALLBACK_MS = 10_000
const MODEL_CALLBACK_MS = 130_000

/** Settlement remains legal after a session is fenced. New work carries either
 * a session argument, a request origin, or a native tool identity. */
function adapterSessions(method: keyof OwnerAdapterApi, args: unknown[]): unknown[] {
  const first = objectOf(args[0]), second = objectOf(args[1])
  switch (method) {
    case 'finishNativeOutput': case 'finishNativeToolRead': return []
    case 'sessionView': case 'snapshot': case 'rememberStandaloneFile': case 'forgetStandaloneFile': return [args[0]]
    case 'modelRequest': return [args[1]]
    case 'acquireSend': return [second?.session]
    case 'admitNativeSpillRead': return [objectOf(second?.call)?.session]
    case 'registerDerived': return [first?.sessionId, first?.senderSessionId]
    case 'initializeSession': return [first?.sessionId, first?.parentSessionId]
    case 'prepareContextRecovery': return [first?.sessionId, first?.nativeParentSessionId]
    default: return [first?.sessionId ?? first?.session ?? objectOf(first?.call)?.session]
  }
}

/** The backend owns the process and host IPC. dsh gets a relay for adapter operations only. */
export function createDesktopMemoryOwner(settings: Pick<SupervisorOptions, 'root' | 'embedding' | 'dailyNotes'>,
  events: MemoryChannelEvents) {
  let owner: Supervisor | undefined
  let adapter: AdapterLink | undefined
  let adapterRelease = Promise.resolve()
  let closing = false
  const channel = createRemoteMemoryChannel({ ...events, callOwner(method, input, options) {
    if (!owner) throw new MemoryOwnerUnavailable()
    return owner.callHost(method, input, options)
  } })

  function adapterCall<T>(method: string, input: object, signal: AbortSignal, budgetMs: number): Promise<T> {
    if (!adapter?.attached) return Promise.reject(new MemoryOwnerUnavailable('Memory adapter is unavailable'))
    return adapter.peer.call<T>(method, input, { signal, budgetMs })
  }

  function bindDsh(send: Parameters<typeof createOwnerRpcPeer>[0]['send'], exited: Promise<void>,
    foregroundSignal: (session: string) => AbortSignal | undefined, onReady?: () => void) {
    if (adapter) throw new Error('The previous dsh memory channel is still active')
    const waiters = new Set<() => void>()
    const notifyWaiters = () => { for (const wake of waiters) wake() }
    const grantSignals = new Map<string, AbortSignal>()
    let grantEpoch: string | undefined
    const ready = () => adapter === link && channel.ready() && link.reconciledEpoch === owner?.epoch()
    const peer = createOwnerRpcPeer({ send, onEvent(raw) {
      const event = objectOf(raw)
      if (!link.attached || adapter !== link || event?.type !== 'memory_adapter_ready' || typeof event.ready !== 'boolean'
        || typeof event.epoch !== 'string' || event.epoch !== owner?.epoch()) return
      const wasReady = ready()
      link.reconciledEpoch = event.ready ? event.epoch : undefined
      if (!wasReady && ready()) { notifyWaiters(); onReady?.() }
    }, handle(method, input, signal, budgetMs) {
      const data = objectOf(input)
      if (method === 'attach') {
        if (!data || data.protocol !== MEMORY_HOST_PROTOCOL || typeof data.root !== 'string'
          || path.resolve(data.root) !== path.resolve(settings.root) || data.hostNamespace !== 'viva') {
          throw new Error('Memory adapter owner binding differs')
        }
        link.attached = true
        return channel.state()
      }
      if (method !== 'adapter' || !link.attached || adapter !== link || !owner
        || typeof data?.method !== 'string' || !Array.isArray(data.args) || !data.epoch || data.epoch !== owner.epoch()) {
        throw new MemoryOwnerUnavailable()
      }
      if (grantEpoch !== data.epoch) {
        grantEpoch = owner.epoch()
        grantSignals.clear()
      }
      const operation = data.method as keyof OwnerAdapterApi
      let args = data.args
      // The worker validates the method and its input. Bind foreground work to the
      // session that issued it. Permit settlement and final audit receipts still drain.
      const grantId = typeof args[0] === 'string' ? args[0] : ''
      const fences = adapterSessions(operation, args).map(id => typeof id === 'string' ? foregroundSignal(id) : undefined)
        .filter((fence): fence is AbortSignal => !!fence)
      const fence = operation === 'recordSendBody' ? grantSignals.get(grantId) : fences.length > 1 ? AbortSignal.any(fences) : fences[0]
      if (operation === 'settleSend') grantSignals.delete(grantId)
      fence?.throwIfAborted()
      if (operation === 'reconcileActiveTurns' && Array.isArray(args[0])) {
        args = [args[0].filter(turn => {
          const id = objectOf(turn)?.sessionId
          return typeof id !== 'string' || !foregroundSignal(id)?.aborted
        })]
      }
      if (operation === 'acquireSend' && fence) grantSignals.set(grantId, fence)
      return owner.callAdapter(operation, args as Parameters<OwnerAdapterApi[keyof OwnerAdapterApi]>,
        { signal: fence ? AbortSignal.any([signal, fence]) : signal, budgetMs, waitForCompletion: data.waitForCompletion === true ? true : undefined })
        .catch(error => { if (operation === 'acquireSend') grantSignals.delete(grantId); throw error })
    } })
    const link: AdapterLink = { peer, attached: false }
    adapter = link
    adapterRelease = exited.then(async () => {
      peer.close()
      if (adapter === link) {
        adapter = undefined
        notifyWaiters()
        if (!closing) await owner?.adapterExited()
      }
    })
    void adapterRelease.catch(() => {})
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
      recoverContext(session: string) {
        if (!ready()) throw new MemoryOwnerUnavailable()
        const epoch = link.reconciledEpoch
        return peer.call<boolean>('recoverContext', { epoch, session }, { budgetMs: CALLBACK_MS, signal: foregroundSignal(session) })
          .then(value => ready() && link.reconciledEpoch === epoch && value)
      },
    }
  }

  const create = () => createMemoryOwnerSupervisor({
    ...settings, hostNamespace: 'viva',
    onEvent(event) {
      if (closing) return
      try { channel.receive(event) }
      finally {
        if (adapter?.attached) {
          try { adapter.peer.notify(event) } catch { /* dsh is exiting */ }
        }
      }
    },
    callbacks: {
      compute: (input, signal) => adapterCall<string>('compute', input, signal,
        isDailyMemoryStage(input.job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : MODEL_CALLBACK_MS),
      quiesce: async (input, signal) => { if (adapter?.attached) await adapterCall('quiesce', input, signal, CALLBACK_MS) },
      checkRecovery: (input, signal) => adapterCall<boolean>('checkRecovery', input, signal, CALLBACK_MS),
      async drainSends(input) {
        const link = adapter
        if (!link?.attached) return
        try { await link.peer.call('drainSends', input, { budgetMs: CALLBACK_MS }) }
        catch (error) { if (adapter === link) throw error }
      },
    },
  })

  async function release() {
    const current = owner
    if (!current) return
    await current.close()
    if (owner === current) {
      owner = undefined
      channel.processExited()
    }
  }

  return {
    channel, bindDsh,
    pid: () => owner?.pid() ?? null,
    async prepare(coldMaintenance: () => Promise<void>) {
      if (closing) throw new MemoryOwnerUnavailable()
      await adapterRelease.catch(() => release())
      if (owner) {
        await owner.start()
        if (!await owner.nativeMaintenancePending()) return
        await release()
      }
      await coldMaintenance()
      if (closing) throw new MemoryOwnerUnavailable()
      owner = create()
      await owner.start()
    },
    close() {
      closing = true
      channel.close()
      return release()
    },
  }
}
export type DesktopMemoryOwner = ReturnType<typeof createDesktopMemoryOwner>
