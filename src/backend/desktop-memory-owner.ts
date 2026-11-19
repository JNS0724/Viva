import path from 'node:path'
import { DAILY_MEMORY_DEFAULTS } from '../memory/contracts/memory-daily-defaults.ts'
import { isDailyMemoryStage } from '../memory/contracts/memory-contract.ts'
import { MEMORY_HOST_PROTOCOL } from '../memory/contracts/host.ts'
import type { OwnerAdapterApi } from '../memory/node/owner-adapter.ts'
import { createOwnerRpcPeer } from '../memory/node/owner-rpc-peer.ts'
import { createMemoryOwnerSupervisor } from '../memory/node/owner-supervisor.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { createRemoteMemoryChannel, MemoryOwnerUnavailable } from './remote-memory-channel.ts'

type Supervisor = ReturnType<typeof createMemoryOwnerSupervisor>
type SupervisorOptions = Parameters<typeof createMemoryOwnerSupervisor>[0]
type AdapterLink = { peer: ReturnType<typeof createOwnerRpcPeer>, attached: boolean }
const CALLBACK_MS = 10_000
const MODEL_CALLBACK_MS = 130_000

/** The backend owns the process and host IPC. dsh gets a relay for adapter operations only. */
export function createDesktopMemoryOwner(settings: Pick<SupervisorOptions, 'root' | 'embedding' | 'dailyNotes'>,
  events: Omit<Parameters<typeof createRemoteMemoryChannel>[0], 'send'>) {
  let owner: Supervisor | undefined
  let adapter: AdapterLink | undefined
  let adapterRelease = Promise.resolve()
  let closing = false
  const channel = createRemoteMemoryChannel({ ...events, send(message) {
    if (!owner) throw new MemoryOwnerUnavailable()
    owner.sendHost(message)
  } })

  function adapterCall<T>(method: string, input: object, signal: AbortSignal, budgetMs: number): Promise<T> {
    if (!adapter?.attached) return Promise.reject(new MemoryOwnerUnavailable('Memory adapter is unavailable'))
    return adapter.peer.call<T>(method, input, { signal, budgetMs })
  }

  function bindDsh(send: Parameters<typeof createOwnerRpcPeer>[0]['send'], exited: Promise<void>) {
    if (adapter) throw new Error('The previous dsh memory channel is still active')
    const peer = createOwnerRpcPeer({ send, handle(method, input, signal, budgetMs) {
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
      // The worker validates the named method against the adapter allowlist before execution.
      return owner.callAdapter(data.method as keyof OwnerAdapterApi, data.args as Parameters<OwnerAdapterApi[keyof OwnerAdapterApi]>,
        { signal, budgetMs, waitForCompletion: data.waitForCompletion === true ? true : undefined })
    } })
    const link: AdapterLink = { peer, attached: false }
    adapter = link
    adapterRelease = exited.then(async () => {
      peer.close()
      if (adapter === link) {
        adapter = undefined
        if (!closing) await owner?.adapterExited()
      }
    })
    void adapterRelease.catch(() => {})
    return peer.receive
  }

  const create = () => createMemoryOwnerSupervisor({
    ...settings, hostNamespace: 'viva',
    onEvent(event) {
      if (closing) return
      try { channel.receive(event) }
      finally {
        if (adapter?.attached && event.type !== 'memory_host_result') {
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
