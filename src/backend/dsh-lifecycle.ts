import { CRASH_WINDOW_MS, restartDelay } from '../shared/restart-delay.ts'

export interface DshLifetime {
  /** Checked before routing an event from this particular instance. */
  isCurrent(): boolean
  onExit(exit: { message: string }): void
}

interface DshProcess { dispose(): Promise<unknown> }
type Schedule = (run: () => void, ms: number) => () => void
const scheduleTimer: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
const CANCELLED = Symbol('retired dsh startup')

/**
 * Owns one dsh instance and its lifetime, not conversations or task state. Creation and connection are supplied
 * by compose; every replacement waits for real disposal, even if quitting stopped waiting for it earlier.
 */
export function createDshLifecycle<Context, Instance extends DshProcess, Info>({
  create, connect, onReady = () => {}, onGone, onCrash, restart, onRestartError, now = Date.now, schedule = scheduleTimer,
}: {
  create: (context: Context, lifetime: DshLifetime) => Instance
  connect: (instance: Instance, context: Context) => Promise<Info>
  onReady?: (info: Info, context: Context) => void
  onGone: () => void
  onCrash: (exit: { message: string }, delay: number | null) => void
  restart: () => Promise<unknown>
  onRestartError: (error: unknown) => void
  now?: () => number
  schedule?: Schedule
}) {
  type Run = {
    generation: number, instance: Instance | null, promise: Promise<Info | null> | null,
    cancel: () => void, cancellation: Promise<typeof CANCELLED>, gone: boolean, cleanup: Promise<void> | null,
  }
  let active: Run | null = null, generation = 0, quitting = false
  let starting: Promise<Info | null> | null = null, stopping: Promise<void> | null = null
  let releasing: Promise<void> = Promise.resolve()
  let crashes: number[] = []
  let restartToken: object | null = null, cancelRestartTimer: (() => void) | null = null

  function cancelRestart() {
    restartToken = null; cancelRestartTimer?.(); cancelRestartTimer = null
  }

  const isCurrent = (run: Run) => active === run && run.generation === generation && !quitting
  function notifyGone(run: Run) {
    if (run.gone) return
    run.gone = true; onGone()
  }

  function release(run: Run): Promise<void> {
    if (run.cleanup) return run.cleanup
    const instance = run.instance
    if (!instance) return releasing
    run.cleanup = releasing.then(() => instance.dispose()).then(() => undefined)
    releasing = run.cleanup
    // A failed release remains a barrier to future starts; retain it without an unhandled rejection.
    void releasing.catch(() => {})
    return run.cleanup
  }

  function retire(run: Run) {
    if (active === run) { active = null; generation++ }
    if (starting === run.promise) starting = null
    run.cancel()
    const cleanup = release(run)
    notifyGone(run)
    return cleanup
  }

  function exited(run: Run, exit: { message: string }) {
    if (!isCurrent(run)) return
    void retire(run).catch(onRestartError)
    const at = now()
    crashes = [...crashes.filter(time => at - time < CRASH_WINDOW_MS), at]
    const delay = restartDelay(crashes, at)
    onCrash(exit, delay)
    cancelRestart()
    if (delay === null || quitting) return
    const token = {}; restartToken = token
    cancelRestartTimer = schedule(() => {
      if (restartToken !== token) return
      cancelRestartTimer = null
      void Promise.resolve().then(() => {
        if (restartToken !== token || quitting || active || starting) return
        restartToken = null
        return restart()
      }).catch(onRestartError)
    }, delay)
  }

  function start(context: Context): Promise<Info | null> {
    if (quitting) return Promise.resolve(null)
    if (starting) return starting
    if (active?.promise) return active.promise
    cancelRestart()
    const ticket = ++generation
    const promise: Promise<Info | null> = releasing.then(async () => {
      if (ticket !== generation || quitting) return null
      let cancel!: () => void
      const cancellation = new Promise<typeof CANCELLED>(resolve => { cancel = () => resolve(CANCELLED) })
      const run: Run = { generation: ticket, instance: null, promise: null, cancel, cancellation, gone: false, cleanup: null }
      active = run
      run.promise = promise
      try {
        run.instance = create(context, { isCurrent: () => isCurrent(run), onExit: exit => exited(run, exit) })
        if (!isCurrent(run)) { void release(run).catch(onRestartError); return null }
        const instance = run.instance
        const connected = Promise.resolve().then<Info | typeof CANCELLED>(() => isCurrent(run) ? connect(instance, context) : CANCELLED)
        const info = await Promise.race([connected, cancellation])
        if (info === CANCELLED || !isCurrent(run)) return null
        onReady(info, context)
        return info
      } catch (error) {
        if (!isCurrent(run)) return null
        await retire(run)
        throw error
      }
    })
    starting = promise
    const settled = () => { if (starting === promise) starting = null }
    void promise.then(settled, settled)
    return promise
  }

  function stop(): Promise<void> {
    cancelRestart(); generation++
    const run = active; active = null; starting = null
    if (!run && stopping) return stopping
    const cleanup = run ? release(run) : releasing
    if (run) { run.cancel(); notifyGone(run) }
    const promise = cleanup.then(() => undefined)
    stopping = promise
    const settled = () => { if (stopping === promise) stopping = null }
    void promise.then(settled, settled)
    return promise
  }

  function stopWithin(ms = 5_000): Promise<void> {
    const stopped = stop()
    let cancel = () => {}
    const deadline = new Promise<void>(resolve => { cancel = schedule(resolve, ms) })
    return Promise.race([stopped, deadline]).finally(() => cancel())
  }

  return {
    get current() { return active?.instance ?? null },
    start, stop, stopWithin,
    isQuitting: () => quitting,
    markQuitting: () => { quitting = true; generation++; cancelRestart(); active?.cancel() },
  }
}
