/**
 * Going back to an earlier point of the conversation, on the app's side of the fork contract (version 1,
 * prototype, see plugins/fork/lib/channel.js): the viva-fork plugin inside dsh writes a new session seeded with
 * everything before that point, and answers with its id. Every request is answered, by the plugin or by a timeout.
 */
const FORK_TIMEOUT_MS = 10_000
/** No answer from the plugin: it is not loaded, or dsh is gone. */
export const NO_PLUGIN = 'unavailable'

export type ForkResult = { ok: boolean, sessionId?: string, reason?: string }

/**
 * before: index of the user message to go back to; or words: what the user said there, the occurrence-th
 * such turn from the end; cwd: where the new session works.
 */
export interface ForkPoint { before?: number, words?: string, occurrence?: number, cwd?: string }

export function createForkDesk({ send, sessionId, timeoutMs = FORK_TIMEOUT_MS }: {
  send: (message: object) => void, sessionId: () => string | null, timeoutMs?: number,
}) {
  const waiting = new Map<string, { resolve: (result: ForkResult) => void, timer: ReturnType<typeof setTimeout> }>()
  let seq = 0

  function settle(id: string, result: ForkResult): void {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }

  function fork({ before, words, occurrence, cwd }: ForkPoint = {}): Promise<ForkResult> {
    const session = sessionId()
    if (!session) return Promise.resolve({ ok: false, reason: NO_PLUGIN })
    const id = `f${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, { ok: false, reason: NO_PLUGIN }), timeoutMs)
      timer.unref?.()
      waiting.set(id, { resolve, timer })
      const point = words === undefined
        ? (before === undefined ? {} : { before })
        : { words, ...(occurrence === undefined ? {} : { occurrence }) }
      send({ type: 'fork', id, sessionId: session, ...point, ...(cwd ? { cwd } : {}) })
    })
  }

  function receive(message: any): void {
    if (message?.type !== 'fork_result' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') return
    if (message.ok && typeof message.sessionId === 'string') return settle(message.id, { ok: true, sessionId: message.sessionId })
    settle(message.id, { ok: false, reason: typeof message.reason === 'string' ? message.reason : NO_PLUGIN })
  }

  function closeAll(): void {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, reason: NO_PLUGIN })
  }

  return { fork, receive, closeAll }
}
