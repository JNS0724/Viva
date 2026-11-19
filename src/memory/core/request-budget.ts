/** Process-local monotonic deadline. Only remaining durations cross a process boundary. */
export class RequestTimeout extends Error {
  readonly code = 'timeout'
  constructor() { super('Request timed out') }
}

export function createRequestBudget(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController()
  let deadline = performance.now() + Math.max(0, milliseconds)
  let suspended: number | undefined
  const expire = () => controller.abort(new RequestTimeout())
  const aborted = () => controller.abort(parent?.reason ?? new Error('Request cancelled'))
  let timer = setTimeout(expire, Math.max(0, milliseconds))
  parent?.addEventListener('abort', aborted, { once: true })
  if (parent?.aborted) aborted()
  const remainingMs = () => {
    const remaining = suspended ?? Math.max(0, deadline - performance.now())
    if (!remaining && !controller.signal.aborted) expire()
    controller.signal.throwIfAborted()
    return remaining
  }
  return {
    signal: controller.signal, remainingMs,
    pause() {
      if (suspended !== undefined || controller.signal.aborted) return
      const remaining = Math.max(0, deadline - performance.now())
      if (!remaining) { expire(); return }
      suspended = remaining
      clearTimeout(timer)
    },
    resume() {
      if (suspended === undefined || controller.signal.aborted) return
      deadline = performance.now() + suspended
      timer = setTimeout(expire, suspended)
      suspended = undefined
    },
    cancel(reason: unknown = new Error('Request cancelled')) { controller.abort(reason) },
    async run<T>(work: () => T | PromiseLike<T>): Promise<T> {
      remainingMs()
      return new Promise<T>((resolve, reject) => {
        const stop = () => {
          controller.signal.removeEventListener('abort', stop)
          reject(controller.signal.reason)
        }
        controller.signal.addEventListener('abort', stop, { once: true })
        Promise.resolve().then(() => { remainingMs(); return work() }).then(value => {
          try { remainingMs(); resolve(value) } catch (error) { reject(error) }
        }, reject)
          .finally(() => controller.signal.removeEventListener('abort', stop))
      })
    },
    close() { clearTimeout(timer); parent?.removeEventListener('abort', aborted) },
  }
}
