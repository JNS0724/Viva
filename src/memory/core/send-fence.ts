/** Actual transport attempts, not model calls: retries acquire separate payload-bound permits. */
export interface SendAdmission { current(): boolean; deadline: number | null }
export class MemorySendDenied extends Error {
  constructor(message = 'Memory request is not admitted') { super(message); this.name = 'MemorySendDenied' }
}
export interface MemorySendPermit {
  readonly id: string
  readonly payload: string
  readonly signal: AbortSignal
  current(): boolean
  /** Only the adapter's observed body commit or confirmed transport abandonment may call this. */
  settled(): void
}

export function createMemorySendFence({ epoch, admit, now = Date.now }: {
  epoch: string, admit(origin: { session: string, contextGeneration?: number } | { jobId: string }): SendAdmission | null, now?: () => number,
}) {
  const attempts = new Map<string, { controller: AbortController, done: Promise<void>, finish(): void }>()
  let paused = false, closed = false
  let serial: Promise<unknown> = Promise.resolve()
  function acquire(id: string, origin: { session: string, contextGeneration?: number } | { jobId: string }, payload: string, ownerEpoch = epoch): MemorySendPermit {
    if (closed || paused || ownerEpoch !== epoch || attempts.has(id)) throw new MemorySendDenied()
    const admission = admit(origin)
    if (!admission?.current() || admission.deadline !== null && admission.deadline <= now()) throw new MemorySendDenied()
    const controller = new AbortController()
    let resolve!: () => void
    const done = new Promise<void>(accept => { resolve = accept })
    const deadline = admission.deadline
    let expiry: ReturnType<typeof setTimeout> | undefined
    function expire() {
      if (deadline === null) return
      const remaining = deadline - now()
      if (remaining <= 0) { controller.abort(new MemorySendDenied('Memory admission expired')); return }
      // Node clamps larger delays to 1ms. Long-lived validity windows need chained timers.
      expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      expiry.unref()
    }
    expire()
    const attempt = { controller, done, finish: () => { if (attempts.get(id) === attempt) { clearTimeout(expiry); attempts.delete(id); resolve() } } }
    attempts.set(id, attempt)
    return { id, payload, signal: controller.signal,
      current: () => !closed && !paused && !controller.signal.aborted && admission.current()
        && (admission.deadline === null || now() < admission.deadline),
      settled: attempt.finish,
    }
  }
  async function drain() {
    const pending = [...attempts.values()]
    for (const attempt of pending) attempt.controller.abort(new MemorySendDenied('Memory changed before request body committed'))
    // Aborting is not acknowledgment: only the transport can resolve these promises.
    await Promise.all(pending.map(attempt => attempt.done))
  }
  function mutate<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = serial
    // Synchronously close admission, including while queued behind another mutation.
    paused = true
    const operation = previous.catch(() => {}).then(async () => { await drain(); return work() })
    serial = operation
    return operation.finally(() => { if (serial === operation && !closed) paused = false })
  }
  return { acquire, mutate, pending: () => attempts.size, blocked: () => paused || closed,
    async close() { closed = true; paused = true; await drain(); await serial.catch(() => {}) },
  }
}
export type MemorySendFence = ReturnType<typeof createMemorySendFence>
