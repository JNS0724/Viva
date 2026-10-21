/**
 * Going back to an earlier point of the conversation, on the app's side of the fork contract (version 1,
 * prototype, see plugins/fork/lib/channel.js): the viva-fork plugin inside dsh writes a new session seeded with
 * everything before that point, and answers with its id. Every request is answered, by the plugin or by a timeout.
 */
const FORK_TIMEOUT_MS = 10_000
/** No answer from the plugin: it is not loaded, or dsh is gone. */
export const NO_PLUGIN = 'unavailable'

/**
 * @param {{ send: (message: object) => void, sessionId: () => string | null, timeoutMs?: number }} deps
 */
export function createForkDesk({ send, sessionId, timeoutMs = FORK_TIMEOUT_MS }) {
  const waiting = new Map()
  let seq = 0

  function settle(id, result) {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }

  /**
   * @param {{ before?: number, words?: string, occurrence?: number, cwd?: string }} [request] before: index of
   *   the user message to go back to; or words: what the user said there, the occurrence-th such turn from the end
   * @returns {Promise<{ ok: boolean, sessionId?: string, reason?: string }>}
   */
  function fork({ before, words, occurrence, cwd } = {}) {
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

  function receive(message) {
    if (message?.type !== 'fork_result' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') return
    if (message.ok && typeof message.sessionId === 'string') return settle(message.id, { ok: true, sessionId: message.sessionId })
    settle(message.id, { ok: false, reason: typeof message.reason === 'string' ? message.reason : NO_PLUGIN })
  }

  function closeAll() {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, reason: NO_PLUGIN })
  }

  return { fork, receive, closeAll }
}
