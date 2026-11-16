import type { MemoryOwnerState } from '../memory/contracts/host.ts'

/** Serializes durable host replay. Effect availability is independent of the core's data revision. */
export function createMemoryHostRecovery({ state, recover, onError, retryMs = 1000 }: {
  state(): MemoryOwnerState | undefined,
  recover(): Promise<void>,
  onError(error: unknown): void,
  retryMs?: number,
}) {
  let last = '', running: Promise<void> | undefined, closed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  function notify(): Promise<void> {
    if (closed) return Promise.resolve()
    if (running) return running
    const current = state()
    if (!current || current.state === 'unavailable') return Promise.resolve()
    const signature = `${current.epoch}:${current.revision}:${current.effectsRevision ?? 0}:${current.state}`
    if (last === signature) return Promise.resolve()
    last = signature
    clearTimeout(retry)
    let success = false
    running = Promise.resolve().then(recover).then(() => { success = true }, error => {
      last = ''; onError(error)
      if (!closed) { retry = setTimeout(() => { void notify() }, retryMs); retry.unref() }
    }).then(async () => {
      running = undefined
      // A state/effect notification received while recovering still gets its own replay pass.
      if (success && !closed) await notify()
    })
    return running
  }
  return { notify, close() { closed = true; clearTimeout(retry) } }
}
