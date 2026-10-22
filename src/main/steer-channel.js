/**
 * Words the user sends while the agent works, on the app's side of the steer contract (version 1, see
 * plugins/steer/lib/channel.js): handed to the viva-steer plugin inside dsh, which gives them to the running
 * turn. Every request is answered, by the plugin or, when it does not, by a timeout.
 */
const STEER_TIMEOUT_MS = 5_000
/** No answer from the plugin: it is not loaded, or dsh is gone. */
export const NO_PLUGIN = 'unavailable'
const ROUTES = new Set(['into', 'other'])

/**
 * @param {{ send: (message: object) => void, sessionId: () => string | null, timeoutMs?: number }} deps
 * @returns {{
 *   steer: (text: string) => Promise<{ ok: boolean, reason?: string }>,
 *   receive: (message: object) => void, closeAll: () => void,
 * }}
 */
export function createSteerDesk({ send, sessionId, timeoutMs = STEER_TIMEOUT_MS }) {
  const waiting = new Map()
  let seq = 0

  function settle(id, result) {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }

  /** @param {string} text @param {string | null} [session] the turn to steer: the main conversation's, or a background task's */
  function steer(text, session = sessionId()) {
    if (!session) return Promise.resolve({ ok: false, reason: NO_PLUGIN })
    const id = `s${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, { ok: false, reason: NO_PLUGIN }), timeoutMs)
      timer.unref?.()
      waiting.set(id, { resolve, timer })
      send({ type: 'steer', id, sessionId: session, text })
    })
  }

  /**
   * Where words typed now would go, judged by the session's model (the route message, same contract): 'into'
   * the turn or 'other', or null when nothing answers in time, and the window keeps its own guess.
   * @param {string} words what started the running turn @param {string} text what is typed now
   * @returns {Promise<'into' | 'other' | null>}
   */
  function route(words, text, session = sessionId()) {
    if (!session) return Promise.resolve(null)
    const id = `r${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, null), timeoutMs)
      timer.unref?.()
      waiting.set(id, { resolve, timer })
      send({ type: 'route', id, sessionId: session, words, text })
    })
  }

  function receive(message) {
    if (message?.type === 'route_result' && typeof message.id === 'string') {
      return settle(message.id, ROUTES.has(message.route) ? message.route : null)
    }
    if (message?.type !== 'steer_result' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') return undefined
    return settle(message.id, message.ok ? { ok: true } : { ok: false, reason: typeof message.reason === 'string' ? message.reason : NO_PLUGIN })
  }

  /** dsh is going away or the session is switched: nothing will answer. */
  function closeAll() {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, reason: NO_PLUGIN })
  }

  return { steer, route, receive, closeAll }
}
