/** Process-local monotonic deadline. Only remaining durations cross a process boundary. */
export class RequestTimeout extends Error {
  readonly code = 'timeout'
  constructor() { super('Request timed out') }
}

export function createRequestBudget(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController()
  const deadline = performance.now() + Math.max(0, milliseconds)
  const expire = () => controller.abort(new RequestTimeout())
  const aborted = () => controller.abort(parent?.reason ?? new Error('Request cancelled'))
  const timer = setTimeout(expire, Math.max(0, milliseconds))
  parent?.addEventListener('abort', aborted, { once: true })
  if (parent?.aborted) aborted()
  const remainingMs = () => {
    const remaining = Math.max(0, deadline - performance.now())
    if (!remaining && !controller.signal.aborted) expire()
    controller.signal.throwIfAborted()
    return remaining
  }
  return {
    signal: controller.signal, remainingMs,
    cancel(reason: unknown = new Error('Request cancelled')) { controller.abort(reason) },
    async run<T>(work: () => T | PromiseLike<T>): Promise<T> {
      remainingMs()
      return new Promise<T>((resolve, reject) => {
        const stop = () => reject(controller.signal.reason)
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

export const MEMORY_READ_BUDGET_MS = 10_000
export const INITIALIZATION_BUDGET_MS = 30_000
export type MemoryReadOptions = { budgetMs?: number }
