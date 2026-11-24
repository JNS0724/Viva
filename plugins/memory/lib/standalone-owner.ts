import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { RequestTimeout } from '../../../src/shared/request-budget.ts'
import { MEMORY_HOST_PROTOCOL, memoryOwnerProfile, memoryOwnerState, type MemoryOwnerProfile, type MemoryOwnerState, type MemoryProfileSnapshot } from '../../../src/memory/contracts/host.ts'
import { createOwnerRpcPeer } from '../../../src/memory/node/owner-rpc-peer.ts'
import { createMemoryOwnerSupervisor } from '../../../src/memory/node/owner-supervisor.ts'
import type { MemoryOwnerConnection } from './remote-owner.ts'

type SupervisorOptions = Parameters<typeof createMemoryOwnerSupervisor>[0]
type Callbacks = NonNullable<SupervisorOptions['callbacks']> & {
}
type Supervisor = ReturnType<typeof createMemoryOwnerSupervisor>
type OwnerOptions = Pick<SupervisorOptions, 'root' | 'hostNamespace' | 'dailyNotes' | 'embedding'> & { callbacks?: Callbacks }

type StandaloneOwner = ReturnType<typeof standaloneOwner>
const byRoot = new Map<string, StandaloneOwner>()

function standaloneOwner(initial: OwnerOptions) {
  const listeners = new Set<(event: unknown) => void>()
  let attached: OwnerOptions | undefined
  let settings = initial
  let supervisor = createSupervisor()
  let closing: Promise<void> | undefined
  let transition: Promise<void> | undefined

  function createSupervisor(): Supervisor {
    return createMemoryOwnerSupervisor({ ...settings,
      callbacks: {
        compute: (input, signal) => {
          const compute = attached?.callbacks?.compute
          if (!compute) throw new Error('Memory model adapter is unavailable')
          return compute(input, signal)
        },
      },
      onEvent: event => { for (const listener of listeners) listener(event) },
    })
  }

  function attach(options: OwnerOptions): MemoryOwnerConnection {
    if (closing || attached) throw new Error('Memory owner already has an adapter')
    attached = options
    const subscribe: MemoryOwnerConnection['subscribe'] = listener => {
      listeners.add(listener)
      // Persistence can finish boot before Cordis activates the dsh adapter.
      const snapshot = supervisor.state()
      if (snapshot) listener(snapshot)
      const profile = supervisor.profile()
      if (profile && (!snapshot || profile.epoch === snapshot.epoch)) listener(profile)
      return () => { listeners.delete(listener) }
    }
    let retiring: Promise<void> | undefined
    return {
      start() {
        if (closing || attached !== options || retiring) return Promise.reject(new Error('Memory adapter has been retired'))
        transition ??= Promise.resolve().then(async () => {
          // Existing profiles can still put these settings on the adapter. A storage-only
          // activation has no model route or live memory RPCs before this attachment.
          if (settings.dailyNotes !== options.dailyNotes
            || settings.embedding?.modelRoot !== options.embedding?.modelRoot
            || settings.embedding?.runtimeRoot !== options.embedding?.runtimeRoot) {
            await supervisor.close()
            if (closing || attached !== options || retiring) throw new Error('Memory adapter has been retired')
            settings = options
            supervisor = createSupervisor()
          }
          await supervisor.start()
        })
        return transition
      },
      close() {
        retiring ??= Promise.resolve().then(async () => {
          await transition?.catch(() => {})
          if (attached === options) {
            try { if (!closing) await supervisor.adapterExited() }
            finally { attached = undefined; transition = undefined }
          }
        })
        return retiring
      },
      callHost: (method, input) => supervisor.callHost(method, input),
      callAdapter: (method, args, optionsForCall) => supervisor.callAdapter(method, args, optionsForCall),
      status: () => supervisor.status(),
      epoch: () => supervisor.epoch(),
      subscribe,
    }
  }
  return {
    start: () => supervisor.start(),
    attach,
    close() {
      closing ??= Promise.resolve().then(async () => {
        await transition?.catch(() => {})
        await supervisor.close()
        listeners.clear()
      })
      return closing
    },
  }
}

/** The persistence entry owns the standalone process, even while the adapter is being reloaded. */
export function registerStandaloneOwner(dataRoot: string) {
  const root = path.resolve(dataRoot)
  if (byRoot.has(root)) throw new Error('Memory root already has an active owner')
  const entry = standaloneOwner({ root, dailyNotes: true })
  byRoot.set(root, entry)
  return {
    start: entry.start,
    async close() {
      try { await entry.close() } finally { if (byRoot.get(root) === entry) byRoot.delete(root) }
    },
  }
}

function fromViva(options: OwnerOptions, port: typeof process): MemoryOwnerConnection {
  const { callbacks } = options
  const listeners = new Set<(event: unknown) => void>()
  let current: MemoryOwnerState | undefined, starting: Promise<void> | undefined
  let currentProfile: MemoryOwnerProfile | undefined
  const lifetime = new AbortController()
  function onEvent(event: unknown) {
    const state = memoryOwnerState.safeParse(event)
    if (state.success) current = state.data
    else {
      const profile = memoryOwnerProfile.safeParse(event)
      if (profile.success) {
        if (currentProfile && currentProfile.epoch === profile.data.epoch && profile.data.revision < currentProfile.revision) return
        currentProfile = profile.data
      }
    }
    for (const listener of listeners) listener(event)
  }
  const peer = createOwnerRpcPeer({
    send(frame) {
      if (!port.connected || !port.send) throw new Error('Memory owner parent is disconnected')
      port.send(frame, () => {})
    },
    onEvent,
    handle(method, input, signal) {
      // Only the Viva parent sends reverse adapter callbacks on the dedicated IPC link.
      switch (method) {
        case 'compute': return required(callbacks?.compute)(input as Parameters<NonNullable<Callbacks['compute']>>[0], signal)
        default: throw new Error('Unsupported memory adapter callback')
      }
    },
  })
  const receive = (raw: unknown) => { peer.receive(raw) }
  function disconnect() {
    lifetime.abort()
    peer.close()
    if (current) onEvent({ ...current, state: 'unavailable' })
  }
  port.on('message', receive)
  port.once('disconnect', disconnect)
  async function attach() {
    // Repeated attachment authenticates the same parent link and returns its
    // current state and cached L2 profile snapshot. Retry only missing acknowledgements, within startup time.
    for (let attempt = 0; ; attempt++) {
      const before = current
      try {
        const reply = await peer.call<{ state?: MemoryOwnerState, profile?: MemoryProfileSnapshot } | MemoryOwnerState | undefined>('attach',
          { protocol: MEMORY_HOST_PROTOCOL, root: options.root, hostNamespace: options.hostNamespace }, { signal: lifetime.signal })
        if (reply && typeof reply === 'object') {
          if ('type' in reply) {
            if (current === before) onEvent(reply)
          } else {
            if (reply.state && current === before) onEvent(reply.state)
            if (reply.profile) {
              onEvent({ type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, ...reply.profile })
            }
          }
        }
        return
      } catch (error) {
        if (!(error instanceof RequestTimeout) || lifetime.signal.aborted || attempt >= 2) throw error
        await delay(250 * 2 ** attempt, undefined, { signal: lifetime.signal })
      }
    }
  }
  return {
    start() {
      starting ??= Promise.resolve().then(attach).catch(error => { starting = undefined; throw error })
      return starting
    },
    async close() {
      port.off('message', receive)
      port.off('disconnect', disconnect)
      disconnect()
      listeners.clear()
    },
    reconciled(epoch, ready) { peer.notify({ type: 'memory_adapter_ready', epoch, ready }) },
    claimPrefetch: (input, opts) => peer.call('claimPrefetch', input, opts),
    callAdapter: (method, args, opts) => peer.call('adapter', { method, args, epoch: current?.epoch }, opts),
    callHost: () => Promise.reject(new Error('The Viva memory adapter has no host capabilities')),
    subscribe(listener) {
      listeners.add(listener)
      if (current) listener(current)
      if (currentProfile && (!current || currentProfile.epoch === current.epoch)) listener(currentProfile)
      return () => { listeners.delete(listener) }
    },
    status: () => current?.state ?? 'unavailable',
    epoch: () => current?.epoch,
  }
}

function required<T>(callback: T | undefined): T {
  if (!callback) throw new Error('Memory adapter callback is unavailable')
  return callback
}

export function openPluginOwner(options: OwnerOptions, port: typeof process): MemoryOwnerConnection {
  if (options.hostNamespace === 'viva') return fromViva(options, port)
  const entry = byRoot.get(path.resolve(options.root))
  if (entry) return entry.attach(options)
  // Source fixtures and explicit direct mounts may supply their own persistence. The
  // plugin still uses the same separate owner entry and exclusive memory-root lock.
  const privateEntry = standaloneOwner(options)
  const client = privateEntry.attach(options)
  return { ...client, async close() { await privateEntry.close(); await client.close() } }
}
