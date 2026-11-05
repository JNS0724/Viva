/**
 * A background task's result, delivered into the main conversation at most once and confirmed read
 * (docs/system-design.md §12.4). The app names each report (`reportId`, a task's run); this side finds it in the
 * session and says how it stands:
 *
 * - `read`: its message is in the session's history and the session was flushed (`sessions.flush` true).
 * - `pending`: it waits in the inbox, or a step took it and has not written it yet.
 * - `none`: it is nowhere: never delivered, or lost (a turn stopped before its step, a step rejected).
 *
 * A report is delivered by steering it into the running turn (its message identified by the report), or by the app
 * opening a turn with a note that names it (`REPORT_MARK`). Either way, it is found again by its id: in the
 * message's source, or in the note's words.
 */

/** The message source of a report steered in: who produced it, and which report it is. */
export const REPORT_SOURCE = 'viva-report'
/** The message identity of a report: the same on every try, so one already delivered is known. */
export const reportMessageId = (reportId: string): string => `viva-report:${reportId}`
/** How a note names its reports, one line each (task-reports.ts noteFor): a turn opened over ACP has no other mark. */
export const REPORT_MARK = '回报编号：'
const MARKED = new RegExp(`${REPORT_MARK}(\\S+)`, 'g')
const MAX_REPORT_ID_CHARS = 200

export type ReportStatus = 'read' | 'pending' | 'none'

/** What of a dsh message is read here: its identity, its source, its words. */
export interface ReportMessage {
  readonly id?: unknown
  readonly source?: { readonly kind?: unknown, readonly reportId?: unknown } | null
  readonly content?: ReadonlyArray<{ readonly type?: unknown, readonly text?: unknown }>
}

const isReportId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_REPORT_ID_CHARS

/** The reports a message is: the one its source names (steered in), and those its words name (a note). */
export function reportIdsOf(message: ReportMessage | null | undefined): string[] {
  if (!message) return []
  const ids = new Set<string>()
  if (message.source?.kind === REPORT_SOURCE && isReportId(message.source.reportId)) ids.add(message.source.reportId)
  for (const block of message.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const match of block.text.matchAll(MARKED)) if (isReportId(match[1])) ids.add(match[1])
  }
  return [...ids]
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
  steer: (reportId: string, text: string) => void
}

export interface ReportDeskDeps {
  agentOf: (sessionId: string) => ReportAgent | null
  /** To the app: a report read, or lost. */
  send: (message: { type: 'report_read' | 'report_dropped', sessionId: string, reportId: string }) => void
  log?: (message: string) => void
}

export function createReportDesk({ agentOf, send, log = () => {} }: ReportDeskDeps) {
  /** sessionId → reports a step took and has not written yet. */
  const claimed = new Map<string, Set<string>>()
  /** The app's requests, one at a time: a report looked for and steered in one go, never two of them at once. */
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work, work)
    queue = done.catch(() => undefined)
    return done
  }

  const inHistory = (agent: ReportAgent, reportId: string) => agent.history().some((message) => reportIdsOf(message).includes(reportId))
  const inInbox = (agent: ReportAgent, reportId: string) =>
    [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some((message) => reportIdsOf(message).includes(reportId))

  /** How a report stands in a session; null when there is no live agent for it. */
  async function statusNow(sessionId: string, reportId: string): Promise<ReportStatus | null> {
    const agent = agentOf(sessionId)
    if (!agent) return null
    if (inHistory(agent, reportId)) return (await agent.flush()) ? 'read' : 'pending'
    if (inInbox(agent, reportId) || claimed.get(sessionId)?.has(reportId)) return 'pending'
    return 'none'
  }

  /**
   * Into the running turn, once: one already there is not sent again. `idle` when no turn runs (the app opens one);
   * `steered` when it went in (its `report_read` comes once written).
   */
  async function deliverNow(sessionId: string, reportId: string, text: string): Promise<ReportStatus | 'steered' | 'idle' | null> {
    const now = await statusNow(sessionId, reportId)
    if (now !== 'none') return now
    const agent = agentOf(sessionId)
    if (!agent) return null
    if (agent.status !== 'running') return 'idle'
    agent.steer(reportId, text)
    return 'steered'
  }

  /** A message entered the history: a report written; confirmed once the session is flushed. */
  async function written(sessionId: string, message: ReportMessage) {
    const ids = reportIdsOf(message)
    if (!ids.length) return
    for (const id of ids) claimed.get(sessionId)?.delete(id)
    const agent = agentOf(sessionId)
    let flushed = false
    try {
      flushed = agent ? await agent.flush() : false
    } catch (err) {
      log(`could not flush the session after a report: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Not flushed: no confirmation now; the app asks again (status), which flushes again.
    if (flushed) for (const reportId of ids) send({ type: 'report_read', sessionId, reportId })
  }

  /** A message left the inbox for a step: pending until it is written, or the turn ends without it. */
  function taken(sessionId: string, message: ReportMessage) {
    const ids = reportIdsOf(message)
    if (!ids.length) return
    claimed.set(sessionId, new Set([...(claimed.get(sessionId) ?? []), ...ids]))
  }

  /** A message was discarded from the inbox (the turn stopped): that report is lost. */
  function discarded(sessionId: string, message: ReportMessage) {
    for (const reportId of reportIdsOf(message)) send({ type: 'report_dropped', sessionId, reportId })
  }

  /** The agent is idle: a report a step took and never wrote (the step rejected) is lost. */
  function idle(sessionId: string) {
    const ids = claimed.get(sessionId)
    claimed.delete(sessionId)
    const agent = agentOf(sessionId)
    for (const reportId of ids ?? []) if (!agent || !inHistory(agent, reportId)) send({ type: 'report_dropped', sessionId, reportId })
  }

  return {
    status: (sessionId: string, reportId: string) => inTurn(() => statusNow(sessionId, reportId)),
    deliver: (sessionId: string, reportId: string, text: string) => inTurn(() => deliverNow(sessionId, reportId, text)),
    written, taken, discarded, idle,
  }
}
