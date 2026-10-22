/**
 * The steer contract (version 1) between this plugin, inside dsh, and the app that started dsh. The messages
 * go over Node's IPC channel (`process.send` / `process.on('message')`); the app keeps the same shapes in
 * src/main/steer-channel.js.
 *
 *   app → plugin  { type: 'steer', id, sessionId, text }       what the user said while the agent works
 *   plugin → app  { type: 'steer_result', id, ok, reason? }    reason when not ok: see REASONS
 *
 * And, added within version 1 (an app that does not ask, or a plugin that does not answer, loses nothing):
 *
 *   app → plugin  { type: 'route', id, sessionId, words, text } where words typed now would go (lib/route.js)
 *   plugin → app  { type: 'route_result', id, route }          'into' | 'other', or null with no answer
 */
export const REASONS = Object.freeze({
  /** The agent is not running a turn (it just ended): the app sends the words as a new question instead. */
  idle: 'idle',
  /** No live agent for that session. */
  missing: 'missing',
  /** dsh refused the words (closing, disposed); the app says it could not send them. */
  failed: 'failed',
})
const MAX_ID_CHARS = 128
const MAX_TEXT_CHARS = 20_000

const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

/**
 * @param {{ send: (message: object) => void, on: Function, off: Function }} port the IPC channel to the app
 * @param {(sessionId: string, text: string) => keyof REASONS | null} steer null once dsh has the words
 * @param {(message: string) => void} log
 * @param {(sessionId: string, words: string, text: string) => Promise<'into' | 'other' | null>} [route]
 * @returns {{ close: () => void }}
 */
export function createSteerChannel(port, steer, log, route = async () => null) {
  async function onRoute(message) {
    if (!isText(message.id, MAX_ID_CHARS)) return log('ignored a route without an id')
    const valid = isText(message.sessionId, MAX_ID_CHARS) && isText(message.words, MAX_TEXT_CHARS) && isText(message.text, MAX_TEXT_CHARS)
    let answer = null
    try {
      answer = valid ? await route(message.sessionId, message.words, message.text) : null
    } catch (err) {
      log(`could not judge where the words go: ${err.message}`)
    }
    port.send({ type: 'route_result', id: message.id, route: answer })
  }

  function onMessage(message) {
    if (message?.type === 'route') return onRoute(message)
    if (message?.type !== 'steer') return
    if (!isText(message.id, MAX_ID_CHARS)) return log('ignored a steer without an id')
    const reply = (reason) => port.send({ type: 'steer_result', id: message.id, ok: !reason, ...(reason ? { reason } : {}) })
    if (!isText(message.sessionId, MAX_ID_CHARS) || !isText(message.text, MAX_TEXT_CHARS)) return reply(REASONS.failed)
    let reason
    try {
      reason = steer(message.sessionId, message.text)
    } catch (err) {
      log(`could not steer: ${err.message}`)
      reason = REASONS.failed
    }
    return reply(reason)
  }
  port.on('message', onMessage)
  return { close: () => port.off('message', onMessage) }
}
