/**
 * Words the user sends while the agent works, on the app's side of the steer contract (version 2, see
 * plugins/steer/lib/channel.ts): handed to the viva-steer plugin inside dsh, which gives them to the running
 * turn. Every request is answered, by the plugin or, when it does not, by a timeout.
 *
 * Background tasks' results go the same way (plugins/steer/lib/reports.ts): into the running turn at most once,
 * or asked how they stand before a turn is opened for them; the plugin says when one is read or lost.
 */
const STEER_TIMEOUT_MS = 5_000
/** No answer from the plugin: it is not loaded, or dsh is gone. */
export const NO_PLUGIN = 'unavailable'

export type SteerResult = { ok: boolean, reason?: string }

/** What marks the user's words as said mid-turn, for the model only (the window shows them as typed). */
export const INTERJECTION_MARK = '【插话】'
/**
 * The user's words said while the agent works, as the model reads them: marked as an interjection into work under
 * way, so it is not taken for a new request that replaces the one in hand (the persona says what to do with one,
 * app-plugins.ts).
 */
export const interjection = (words: string): string => `${INTERJECTION_MARK}你还在处理用户之前交代的事时，用户又说了下面这句（原话）：\n${words}`
/** How a report stands, or what became of delivering it (plugins/steer/lib/channel.ts report_result). */
export type ReportState = 'read' | 'pending' | 'none' | 'steered' | 'idle' | 'missing' | 'failed' | typeof NO_PLUGIN
const REPORT_STATES: ReadonlySet<string> = new Set(['read', 'pending', 'none', 'steered', 'idle', 'missing', 'failed'])

export interface SteerDesk {
  /** @param session the turn to steer: the main conversation's, or a background task's */
  steer: (text: string, session?: string | null) => Promise<SteerResult>
  /** A report into the running turn of `session` (the main conversation's), unless it is there already. */
  report: (session: string, reportId: string, token: string, text: string) => Promise<ReportState>
  /** How a report stands in `session`. */
  reportStatus: (session: string, reportId: string, token: string) => Promise<ReportState>
  receive: (message: any) => void
  /** dsh is going away or the session is switched: nothing will answer. */
  closeAll: () => void
}

export function createSteerDesk({ send, sessionId, timeoutMs = STEER_TIMEOUT_MS, onReport = () => {} }: {
  send: (message: object) => void, sessionId: () => string | null, timeoutMs?: number,
  /** The plugin said a report was read (written and flushed), or lost, in that session. */
  onReport?: (event: { type: 'report_written' | 'report_read' | 'report_dropped', reportId: string, sessionId: string }) => void,
}): SteerDesk {
  const waiting = new Map<string, { resolve: (result: SteerResult) => void, timer: ReturnType<typeof setTimeout> }>()
  const reporting = new Map<string, { resolve: (state: ReportState) => void, timer: ReturnType<typeof setTimeout> }>()
  let seq = 0

  function settle(id: string, result: SteerResult): void {
    const entry = waiting.get(id)
    if (!entry) return
    waiting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }

  function steer(text: string, session: string | null = sessionId()): Promise<SteerResult> {
    if (!session) return Promise.resolve({ ok: false, reason: NO_PLUGIN })
    const id = `s${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(id, { ok: false, reason: NO_PLUGIN }), timeoutMs)
      timer.unref?.()
      waiting.set(id, { resolve, timer })
      send({ type: 'steer', id, sessionId: session, text })
    })
  }

  function settleReport(id: string, state: ReportState): void {
    const entry = reporting.get(id)
    if (!entry) return
    reporting.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(state)
  }

  function ask(session: string, fields: { type: 'report' | 'report_status', reportId: string, token: string, text?: string }): Promise<ReportState> {
    if (!session) return Promise.resolve(NO_PLUGIN)
    const id = `r${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settleReport(id, NO_PLUGIN), timeoutMs)
      timer.unref?.()
      reporting.set(id, { resolve, timer })
      send({ ...fields, id, sessionId: session })
    })
  }

  function receive(message: any): void {
    if (message?.type === 'report_result' && typeof message.id === 'string') {
      return settleReport(message.id, REPORT_STATES.has(message.status) ? message.status : NO_PLUGIN)
    }
    if ((message?.type === 'report_written' || message?.type === 'report_read' || message?.type === 'report_dropped') && typeof message.reportId === 'string' && typeof message.sessionId === 'string') {
      // Said with its session: the app checks it is the one the report went to (compose.ts).
      return onReport({ type: message.type, reportId: message.reportId, sessionId: message.sessionId })
    }
    if (message?.type !== 'steer_result' || typeof message.id !== 'string' || typeof message.ok !== 'boolean') return
    settle(message.id, message.ok ? { ok: true } : { ok: false, reason: typeof message.reason === 'string' ? message.reason : NO_PLUGIN })
  }

  function closeAll(): void {
    for (const id of [...waiting.keys()]) settle(id, { ok: false, reason: NO_PLUGIN })
    for (const id of [...reporting.keys()]) settleReport(id, NO_PLUGIN)
  }

  return {
    steer,
    report: (session, reportId, token, text) => ask(session, { type: 'report', reportId, token, text }),
    reportStatus: (session, reportId, token) => ask(session, { type: 'report_status', reportId, token }),
    receive,
    closeAll,
  }
}
