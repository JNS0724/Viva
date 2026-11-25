import path from 'node:path'
import { createMemoryOwnerSupervisor } from '../../../src/memory/node/owner-supervisor.ts'
import type { MemoryOwnerConnection } from './remote-owner.ts'

type SupervisorOptions = Parameters<typeof createMemoryOwnerSupervisor>[0]
type Callbacks = NonNullable<SupervisorOptions['callbacks']>
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
        readSessionRange: (input, signal) => {
          const readSessionRange = attached?.callbacks?.readSessionRange
          if (!readSessionRange) return Promise.resolve({ status: 'unavailable' as const })
          return readSessionRange(input, signal)
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
      // Persistence can finish boot before Cordis activates the dsh adapter; replay the
      // three-step boot order so late subscribers see L2 populated inside their first ready callback.
      const snapshot = supervisor.state()
      const profile = supervisor.profile()
      if (snapshot?.state === 'ready' && profile && profile.epoch === snapshot.epoch) {
        listener({ ...snapshot, state: 'recovering' })
        listener(profile)
        listener(snapshot)
      } else {
        if (snapshot) listener(snapshot)
        if (profile && (!snapshot || profile.epoch === snapshot.epoch)) listener(profile)
      }
      return () => { listeners.delete(listener) }
    }
    let retiring: Promise<void> | undefined
    return {
      start() {
        if (closing || attached !== options || retiring) return Promise.reject(new Error('Memory adapter has been retired'))
        transition ??= Promise.resolve().then(async () => {
          // Existing profiles can still put these settings on the adapter. A storage-only
          // activation has no model route or live memory RPCs before this attachment.
          if (settings.hostNamespace !== options.hostNamespace
            || settings.dailyNotes !== options.dailyNotes
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
      callHost: (method, input, optionsForCall) => supervisor.callHost(method, input, optionsForCall),
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

export function openPluginOwner(options: OwnerOptions, _port?: typeof process): MemoryOwnerConnection {
  const entry = byRoot.get(path.resolve(options.root))
  if (entry) return entry.attach(options)
  // Both Viva desktop (config.host === true) and standalone DSH run through the same single
  // standaloneOwner path with an exclusive memory-root lock.
  const privateEntry = standaloneOwner(options)
  const client = privateEntry.attach(options)
  return { ...client, async close() { await privateEntry.close(); await client.close() } }
}
