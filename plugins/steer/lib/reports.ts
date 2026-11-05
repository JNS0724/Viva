import { TOKEN_MARK } from '../../../src/shared/task-report.ts'

/**
 * A background task's result, delivered into the main conversation at most once and confirmed read
 * (docs/system-design.md §11.5). The app names each report (`reportId`, a task's run) and gives it a `token`: a
 * random secret it keeps with the report. This side finds the report in the session and says how it stands:
 *
 * - `read`: its message is in the session's history and the session was flushed (`sessions.flush` true).
 * - `pending`: it waits in the inbox, or a step took it and has not written it yet.
 * - `none`: it is nowhere: never delivered, or lost (a turn stopped before its step, a step rejected).
 *
 * A report is known only by what no one else can write: the source of a message this plugin steered in (`viva-report`,
 * with its report and token), or, in a turn the app opened over ACP (whose messages are the user's), the report's
 * token in the note's words, for a token the app registered for that session. A report id in someone's words is no
 * report; nor is a token another session was given.
 */

/** The message source of a report steered in: who produced it, and which report it is. */
export const REPORT_SOURCE = 'viva-report'
/** The message identity of a report: the same on every try, so one already delivered is known. */
export const reportMessageId = (reportId: string): string => `viva-report:${reportId}`
/** How a note carries its reports' tokens, one line each (task-reports.ts noteFor; the format in src/shared). */
export { TOKEN_MARK }
const MAX_ID_CHARS = 200
/** A token: 32 or more hex digits, as the app makes them (randomUUID without its dashes). */
const TOKEN = /^[0-9a-f]{32,128}$/

export type ReportStatus = 'read' | 'pending' | 'none'

/** What of a dsh message is read here: its source and its words. */
export interface ReportMessage {
  readonly id?: unknown
  readonly source?: { readonly kind?: unknown, readonly reportId?: unknown, readonly token?: unknown } | null
  readonly content?: ReadonlyArray<{ readonly type?: unknown, readonly text?: unknown }>
}

export const isReportId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
export const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)

const wordsOf = (message: ReportMessage): string => (message.content ?? [])
  .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n')

/** Whether a message is this report: steered in under it, or a note bearing its token. */
function isReport(message: ReportMessage | null | undefined, reportId: string, token: string): boolean {
  if (!message) return false
  if (message.source?.kind === REPORT_SOURCE) return message.source.reportId === reportId && message.source.token === token
  return wordsOf(message).includes(`${TOKEN_MARK}${token}`)
}

/** What this side reads of an agent (the main conversation's), kept narrow so it can be tested without dsh. */
export interface ReportAgent {
  readonly status: string
  readonly inbox: { readonly nextTurn: readonly ReportMessage[], readonly nextStep: readonly ReportMessage[] }
  /** The messages in the session's history (its `user/message` events). */
  history: () => readonly ReportMessage[]
  /** Writes the session out: true only when a persistence listener took it. */
  flush: () => Promise<boolean>
  /** Steers a report's message into the running turn. */
  steer: (reportId: string, token: string, text: string) => void
}

export interface ReportDeskDeps {
  agentOf: (sessionId: string) => ReportAgent | null
  /**
   * The history of a session no agent holds now (the conversation moved to another topic since), as stored: its
   * `user/message` messages, or null when no such session is stored.
   */
  stored?: (sessionId: string) => Promise<readonly ReportMessage[] | null>
  /**
   * To the app: a report written in that session's history (said at once, so the conversation shows it where it came,
   * before what the model says next), read (written and flushed), or lost.
   */
  send: (message: { type: 'report_written' | 'report_read' | 'report_dropped', sessionId: string, reportId: string }) => void
  log?: (message: string) => void
}

export function createReportDesk({ agentOf, stored = async () => null, send, log = () => {} }: ReportDeskDeps) {
  /** The reports the app asked about, by session: report id → its token. Only these are looked for in words. */
  const known = new Map<string, Map<string, string>>()
  /** sessionId → reports a step took and has not written yet. */
  const claimed = new Map<string, Set<string>>()
  /** The app's requests, one at a time: a report looked for and steered in one go, never two of them at once. */
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work, work)
    queue = done.catch(() => undefined)
    return done
  }

  function register(sessionId: string, reportId: string, token: string) {
    known.set(sessionId, new Map([...(known.get(sessionId) ?? []), [reportId, token]]))
  }

  /** The reports of this session a message is: by the source it was steered in with, or a registered token. */
  function reportsIn(sessionId: string, message: ReportMessage): string[] {
    const mine = known.get(sessionId)
    if (!mine) return []
    return [...mine].filter(([reportId, token]) => isReport(message, reportId, token)).map(([reportId]) => reportId)
  }

  const inHistory = (agent: ReportAgent, reportId: string, token: string) => agent.history().some((message) => isReport(message, reportId, token))
  const inInbox = (agent: ReportAgent, reportId: string, token: string) =>
    [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some((message) => isReport(message, reportId, token))

  /**
   * How a report stands in a session. One no agent holds now is read as stored: in its history it is read (a session
   * let go is written out); not there, or no such session, it is lost there; a read that fails throws.
   */
  async function statusNow(sessionId: string, reportId: string, token: string): Promise<ReportStatus | null> {
    const agent = agentOf(sessionId)
    if (!agent) {
      // A read that fails (the disk busy) throws: the channel answers `failed`, which the app tries again after a
      // wait. Only a session not stored at all, or one whose history has no such report, is lost there.
      const history = await stored(sessionId).catch((err) => {
        log(`could not read a stored session for a report: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      })
      return history?.some((message) => isReport(message, reportId, token)) ? 'read' : 'none'
    }
    register(sessionId, reportId, token)
    if (inHistory(agent, reportId, token)) return (await agent.flush()) ? 'read' : 'pending'
    if (inInbox(agent, reportId, token) || claimed.get(sessionId)?.has(reportId)) return 'pending'
    return 'none'
  }

  /**
   * Into the running turn, once: one already there is not sent again. `idle` when no turn runs (the app opens one);
   * `steered` when it went in (its `report_read` comes once written).
   */
  async function deliverNow(sessionId: string, reportId: string, token: string, text: string): Promise<ReportStatus | 'steered' | 'idle' | null> {
    const now = await statusNow(sessionId, reportId, token)
    if (now !== 'none') return now
    const agent = agentOf(sessionId)
    if (!agent) return null
    if (agent.status !== 'running') return 'idle'
    agent.steer(reportId, token, text)
    return 'steered'
  }

  /** A message entered a session's history: a report of that session written; confirmed once it is flushed. */
  async function written(sessionId: string, message: ReportMessage) {
    const ids = reportsIn(sessionId, message)
    if (!ids.length) return
    for (const id of ids) {
      claimed.get(sessionId)?.delete(id)
      send({ type: 'report_written', sessionId, reportId: id })
    }
    const agent = agentOf(sessionId)
    let flushed = false
    try {
      flushed = agent ? await agent.flush() : false
    } catch (err) {
      log(`could not flush the session after a report: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Not flushed: no confirmation now; the app asks again (status), which flushes again.
    if (!flushed) return
    for (const reportId of ids) {
      known.get(sessionId)?.delete(reportId)
      send({ type: 'report_read', sessionId, reportId })
    }
  }

  /** A message left the inbox for a step: pending until it is written, or the turn ends without it. */
  function taken(sessionId: string, message: ReportMessage) {
    const ids = reportsIn(sessionId, message)
    if (ids.length) claimed.set(sessionId, new Set([...(claimed.get(sessionId) ?? []), ...ids]))
  }

  /** A message was discarded from the inbox (the turn stopped): that report is lost. */
  function discarded(sessionId: string, message: ReportMessage) {
    for (const reportId of reportsIn(sessionId, message)) send({ type: 'report_dropped', sessionId, reportId })
  }

  /** The agent is idle: a report a step took and never wrote (the step rejected) is lost. */
  function idle(sessionId: string) {
    const ids = claimed.get(sessionId)
    claimed.delete(sessionId)
    const agent = agentOf(sessionId)
    for (const reportId of ids ?? []) {
      const token = known.get(sessionId)?.get(reportId)
      if (!agent || !token || !inHistory(agent, reportId, token)) send({ type: 'report_dropped', sessionId, reportId })
    }
  }

  return {
    status: (sessionId: string, reportId: string, token: string) => inTurn(() => statusNow(sessionId, reportId, token)),
    deliver: (sessionId: string, reportId: string, token: string, text: string) => inTurn(() => deliverNow(sessionId, reportId, token, text)),
    written, taken, discarded, idle,
  }
}
