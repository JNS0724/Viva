import { restartDelay } from '../backend/dsh-runtime.ts'

/**
 * Keeps the backend process running for the shell (docs/backend-split-design.md §12 C4): started once at launch,
 * started again when it ends on its own, waiting longer each time as dsh is (dsh-runtime.ts restartDelay), and given
 * up when it keeps crashing. A call made while it restarts waits for the new one, for a while.
 */
/** How long a page's call waits for a backend that is restarting. */
export const BACKEND_WAIT_MS = 20_000

type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void

export interface BackendKeeper<B> {
  /** The first start; what goes wrong is the caller's to report. */
  start: () => Promise<B>
  /** The backend, once it is running: at once, or after a restart, or an error after waiting `waitMs`. */
  get: () => Promise<B>
  /** The backend if it is running now, else null. */
  running: () => B | null
  /** Quitting: the backend stops, and nothing is restarted after. */
  shutdown: () => Promise<void>
}

export function createBackendKeeper<B extends { shutdown: () => Promise<void> }>({
  spawn, onUp, onGaveUp, now = Date.now, schedule = (run, ms) => { setTimeout(run, ms) }, waitMs = BACKEND_WAIT_MS,
}: {
  /** Starts a backend; `onExit` is told when it ends on its own. */
  spawn: (onExit: ExitHandler) => Promise<B>
  /** A backend is up; `restarted` after one that ended. */
  onUp: (backend: B, restarted: boolean) => void | Promise<void>
  /** It kept crashing: nothing more is tried. */
  onGaveUp: (why: string) => void
  now?: () => number
  schedule?: (run: () => void, ms: number) => void
  waitMs?: number
}): BackendKeeper<B> {
  let current: B | null = null
  let crashes: readonly number[] = []
  let stopped: string | null = null
  let waiters: ReadonlyArray<{ resolve: (backend: B) => void, reject: (err: Error) => void }> = []

  function settle(result: { backend: B } | { error: Error }) {
    const waiting = waiters
    waiters = []
    for (const waiter of waiting) {
      if ('backend' in result) waiter.resolve(result.backend)
      else waiter.reject(result.error)
    }
  }

  async function launch(restarted: boolean): Promise<B> {
    const backend = await spawn((code, signal) => died(backend, code, signal))
    current = backend
    await onUp(backend, restarted)
    settle({ backend })
    return backend
  }

  function died(backend: B | null, code: number | null, signal: NodeJS.Signals | null) {
    if (stopped !== null || (backend !== null && backend !== current)) return
    current = null
    const at = now()
    crashes = [...crashes, at]
    const why = signal ?? `exit ${code}`
    const delay = restartDelay(crashes, at)
    if (delay === null) {
      stopped = `the backend stopped: ${why}`
      settle({ error: new Error(stopped) })
      onGaveUp(why)
      return
    }
    console.error(`[backend] ended (${why}); starting it again in ${delay / 1000}s`)
    schedule(() => {
      if (stopped !== null) return
      launch(true).catch((err: Error) => {
        console.error('[backend] could not start again:', err.message)
        died(null, null, null)
      })
    }, delay)
  }

  return {
    start: () => launch(false),
    get() {
      if (current) return Promise.resolve(current)
      if (stopped !== null) return Promise.reject(new Error(stopped))
      return new Promise<B>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter.resolve !== done)
          reject(new Error('the backend is restarting; try again in a moment'))
        }, waitMs)
        const done = (backend: B) => {
          clearTimeout(timer)
          resolve(backend)
        }
        const failed = (err: Error) => {
          clearTimeout(timer)
          reject(err)
        }
        waiters = [...waiters, { resolve: done, reject: failed }]
      })
    },
    running: () => current,
    async shutdown() {
      stopped = 'the backend stopped: quitting'
      const backend = current
      current = null
      settle({ error: new Error(stopped) })
      await backend?.shutdown()
    },
  }
}
