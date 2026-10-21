/**
 * The fork contract (version 1, prototype) between this plugin, inside dsh, and the app that started dsh, over
 * Node's IPC channel like the steer contract.
 *
 *   app → plugin  { type: 'fork', id, sessionId, before?, cwd? }    before: index of the user message to go back
 *                                                                   to (that message and all after it are left
 *                                                                   out); omitted, everything so far comes along
 *                 { ..., words, occurrence? } instead of before:    go back to the turn where the user said
 *                                                                   `words`, the occurrence-th such turn from the
 *                                                                   end (0, the last); none, reason invalid
 *   plugin → app  { type: 'fork_result', id, ok, sessionId?, reason? }
 */
export const REASONS = Object.freeze({
  missing: 'missing',
  busy: 'busy',
  invalid: 'invalid',
  failed: 'failed',
})
const MAX_ID_CHARS = 128
const MAX_PATH_CHARS = 4096
const MAX_WORDS_CHARS = 20_000

const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const isCount = (value) => Number.isSafeInteger(value) && value >= 0

/** Where to go back to: a turn index, or the words of a turn (not both); neither, everything comes along. */
function pointOf(message) {
  const { before, words, occurrence } = message
  if (words === undefined) return before === undefined || isCount(before) ? { before } : null
  const valid = before === undefined && isText(words, MAX_WORDS_CHARS) && (occurrence === undefined || isCount(occurrence))
  return valid ? { words, occurrence: occurrence ?? 0 } : null
}

/**
 * @param {{ send: (message: object) => void, on: Function, off: Function }} port
 * @param {(request: { sessionId: string, before?: number, words?: string, occurrence?: number, cwd?: string }) => Promise<string>} fork the child's id
 * @param {(message: string) => void} log
 */
export function createForkChannel(port, fork, log) {
  async function onMessage(message) {
    if (message?.type !== 'fork') return
    if (!isText(message.id, MAX_ID_CHARS)) return log('ignored a fork without an id')
    const reply = (fields) => port.send({ type: 'fork_result', id: message.id, ...fields })
    const point = pointOf(message)
    const validCwd = message.cwd === undefined || isText(message.cwd, MAX_PATH_CHARS)
    if (!isText(message.sessionId, MAX_ID_CHARS) || !point || !validCwd) return reply({ ok: false, reason: REASONS.invalid })
    try {
      const sessionId = await fork({ sessionId: message.sessionId, ...point, cwd: message.cwd })
      reply({ ok: true, sessionId })
    } catch (err) {
      log(`could not fork: ${err.message}`)
      reply({ ok: false, reason: err.reason ?? REASONS.failed })
    }
  }
  port.on('message', onMessage)
  return { close: () => port.off('message', onMessage) }
}
