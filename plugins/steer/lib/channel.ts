/**
 * The steer contract (version 1) between this plugin, inside dsh, and the app that started dsh. The messages
 * go over Node's IPC channel (`process.send` / `process.on('message')`); the app keeps the same shapes in
 * src/main/steer-channel.js.
 *
 *   app → plugin  { type: 'steer', id, sessionId, text }       what the user said while the agent works
 *   plugin → app  { type: 'steer_result', id, ok, reason? }    reason when not ok: see REASONS
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

/** Why the words did not reach the turn. */
export type SteerReason = (typeof REASONS)[keyof typeof REASONS]
/** What arrives over IPC: anything at all, so every field is checked before it is used. */
type Incoming = any

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/**
 * @param port the IPC channel to the app
 * @param steer null once dsh has the words
 */
export function createSteerChannel(
  port: { send: (message: object) => unknown, on: Function, off: Function },
  steer: (sessionId: string, text: string) => SteerReason | null,
  log: (message: string) => void,
): { close: () => void } {
  function onMessage(message: Incoming) {
    if (message?.type !== 'steer') return
    if (!isText(message.id, MAX_ID_CHARS)) return log('ignored a steer without an id')
    const reply = (reason: SteerReason | null) => port.send({ type: 'steer_result', id: message.id, ok: !reason, ...(reason ? { reason } : {}) })
    if (!isText(message.sessionId, MAX_ID_CHARS) || !isText(message.text, MAX_TEXT_CHARS)) return reply(REASONS.failed)
    let reason: SteerReason | null
    try {
      reason = steer(message.sessionId, message.text)
    } catch (err: any) {
      log(`could not steer: ${err.message}`)
      reason = REASONS.failed
    }
    return reply(reason)
  }
  port.on('message', onMessage)
  return { close: () => port.off('message', onMessage) }
}
