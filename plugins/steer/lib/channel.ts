import { isReportId, isToken } from './reports.ts'

/**
 * The steer contract (version 2) between this plugin, inside dsh, and the app that started dsh. The messages
 * go over Node's IPC channel (`process.send` / `process.on('message')`); the app keeps the same shapes in
 * src/backend/steer-channel.ts.
 *
 *   app → plugin  { type: 'steer', id, sessionId, text }       what the user said while the agent works
 *   plugin → app  { type: 'steer_result', id, ok, reason? }    reason when not ok: see REASONS
 *
 * A background task's result (lib/reports.ts), at most once and confirmed read:
 *
 *   app → plugin  { type: 'report', id, sessionId, reportId, token, text }   into the running turn, unless already there
 *   app → plugin  { type: 'report_status', id, sessionId, reportId, token }  how it stands, before the app opens a turn
 *   plugin → app  { type: 'report_result', id, status }              read · pending · none · steered · idle · missing · failed
 *   plugin → app  { type: 'report_read' | 'report_dropped', sessionId, reportId }   written and flushed, or lost
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
/** The report requests (lib/reports.ts createReportDesk): null when no live agent has that session. */
export interface ReportHandlers {
  deliver: (sessionId: string, reportId: string, token: string, text: string) => Promise<string | null>
  status: (sessionId: string, reportId: string, token: string) => Promise<string | null>
}

export function createSteerChannel(
  port: { send: (message: object) => unknown, on: Function, off: Function },
  steer: (sessionId: string, text: string) => SteerReason | null,
  log: (message: string) => void,
  reports: ReportHandlers | null = null,
): { close: () => void } {
  function onReport(message: Incoming) {
    if (!isText(message.id, MAX_ID_CHARS)) return log('ignored a report request without an id')
    const reply = (status: string) => port.send({ type: 'report_result', id: message.id, status })
    const valid = reports && isText(message.sessionId, MAX_ID_CHARS) && isReportId(message.reportId) && isToken(message.token)
      && (message.type === 'report_status' || isText(message.text, MAX_TEXT_CHARS))
    if (!valid) return reply(REASONS.failed)
    const asked = message.type === 'report'
      ? reports.deliver(message.sessionId, message.reportId, message.token, message.text)
      : reports.status(message.sessionId, message.reportId, message.token)
    asked.then((status) => reply(status ?? REASONS.missing), (err: any) => {
      log(`could not handle a report: ${err?.message ?? err}`)
      reply(REASONS.failed)
    })
  }

  function onMessage(message: Incoming) {
    if (message?.type === 'report' || message?.type === 'report_status') return onReport(message)
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
