/**
 * The app's side of the plugins contract (plugins/plugins/lib/channel.ts), held by acp-bridge.ts: the plugins page
 * asks the viva-plugins plugin, which asks dsh's plugin manager. Each call waits for its answer, or gives up after
 * its op's limit; an install can take minutes (pnpm downloads and builds), the rest are quick.
 */
export type PluginsOp = 'list' | 'inspect' | 'install' | 'remove' | 'setBundle' | 'setPlugin'
export type PluginsResult = { ok: true, value: unknown } | { ok: false, problem: string }

const QUICK_MS = 30_000
/** Longer than dsh's own idle limit for a package run (10 minutes), so its answer comes first. */
const PACKAGE_MS = 15 * 60_000
const LIMITS: Readonly<Record<PluginsOp, number>> = Object.freeze({
  list: QUICK_MS, inspect: QUICK_MS, setBundle: QUICK_MS, setPlugin: QUICK_MS, install: PACKAGE_MS, remove: PACKAGE_MS,
})
const MAX_PROBLEM_CHARS = 2000

type Timer = ReturnType<typeof setTimeout>

export function createPluginsDesk({ send, setTimer = setTimeout, clearTimer = clearTimeout }: {
  send: (message: object) => void
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}) {
  const waiting = new Map<string, { resolve: (result: PluginsResult) => void, timer: Timer }>()
  let seq = 0

  function settle(id: string, result: PluginsResult) {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimer(entry.timer)
    entry.resolve(result)
  }

  function receive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type !== 'plugins_result' || typeof message.id !== 'string') return
    if (message.ok === true) return settle(message.id, { ok: true, value: message.value ?? null })
    settle(message.id, { ok: false, problem: String(message.problem ?? 'plugin manager failed').slice(0, MAX_PROBLEM_CHARS) })
  }

  /** One call to dsh's plugin manager, answered or timed out. */
  function call(op: PluginsOp, args: Record<string, unknown> = {}): Promise<PluginsResult> {
    const id = `plg${++seq}-${Date.now().toString(36)}`
    return new Promise<PluginsResult>((resolve) => {
      const timer = setTimer(() => settle(id, { ok: false, problem: 'timeout' }), LIMITS[op])
      waiting.set(id, { resolve, timer })
      try {
        send({ type: 'plugins_call', id, op, args })
      } catch (err) {
        settle(id, { ok: false, problem: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /** dsh is going away: nothing will answer what still waits. */
  function close() {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, problem: 'disconnected' })
  }

  return { receive, call, close }
}
