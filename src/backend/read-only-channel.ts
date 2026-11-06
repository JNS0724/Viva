/**
 * Marking a session unattended, on the app's side (plugins/permission/index.ts): from then on it may only look things
 * up, and nothing in it is asked of the user. The plugin answers each mark; no answer in time (the plugin is not
 * loaded, dsh is gone) is a refusal, so a session is never run unattended without the mark in place.
 */
const MARK_TIMEOUT_MS = 10_000

export function createReadOnlyDesk({ send, timeoutMs = MARK_TIMEOUT_MS }: { send: (message: object) => void, timeoutMs?: number }) {
  const waiting = new Map<string, { resolve: (marked: boolean) => void, timer: ReturnType<typeof setTimeout> }>()
  let seq = 0

  function settle(id: string, marked: boolean): void {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(marked)
  }

  /** Whether the plugin took the mark. */
  function mark(sessionId: string): Promise<boolean> {
    const id = `r${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, false), timeoutMs)
      timer.unref?.()
      waiting.set(id, { resolve, timer })
      send({ type: 'read_only_session', id, sessionId })
    })
  }

  function receive(message: unknown): void {
    const { type, id } = (message ?? {}) as { type?: unknown, id?: unknown }
    if (type === 'read_only_session_ok' && typeof id === 'string') settle(id, true)
  }

  function closeAll(): void {
    for (const id of [...waiting.keys()]) settle(id, false)
  }

  return { mark, receive, closeAll }
}
