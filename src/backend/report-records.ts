import type { Apply } from './journal.ts'
import type { Effect } from './effects.ts'
import type { Conversation } from './history-db.ts'
import type { StoredMessage } from './history-schema.ts'
import { recordedNote, REPORT, type ReportPayload } from './task-reports.ts'

/**
 * Where a background task's result the model read is kept (system-design §12.4 point 7): as a record in the
 * conversation of the session it was delivered to, which need not be the one on screen now (the user moved to another
 * topic since). A report is done only once its record is kept there, so neither is lost on a restart, and the same
 * report is never recorded twice.
 *
 * - That conversation on screen: the window keeps its messages (a save from it rewrites them), so the record is shown
 *   there, where it came, and the report is done when the window saves it (`saved`).
 * - Another one: the record is written into it and the report done, in one change.
 */

/** What of the history is used here. */
export interface RecordHistory {
  bySession: (sessionId: string) => Conversation | null
  hasReport: (conversationId: string, reportId: string) => boolean
  get: (id: string) => { conversation: Conversation, messages: readonly StoredMessage[] } | null
  save: (conversation: Conversation, messages: readonly StoredMessage[]) => unknown
}

/** What of the effects queue is used here. */
export interface RecordEffects {
  get: (kind: string, key: string) => Effect | null
  finish: (kind: string, key: string) => void
  amend: <P extends object>(effect: Effect<P>, payload: P) => boolean
}

/** A record for the window to show where it came (state.ts report_delivered). */
export interface RecordShown { type: 'report_delivered', conversationId: string, reportId: string, text: string, at: number }

export interface ReportRecordsDeps {
  history: () => RecordHistory | null
  effects: () => RecordEffects | null
  apply: Apply
  /** The conversation on screen. */
  current: () => Conversation
  show: (event: RecordShown) => void
  now?: () => number
}

/** What the window draws and keeps for a report: the note as the model was given it, without its token. */
export const recordOf = (effect: Effect<ReportPayload>, at: number): StoredMessage & { report: { reportId: string, at: number } } =>
  ({ role: 'report', text: recordedNote(effect.payload), receipt: null, report: { reportId: effect.key, at } })

export function createReportRecords({ history, effects, apply, current, show, now = Date.now }: ReportRecordsDeps) {
  /** The conversation of the session a report went to: the one on screen first (it may not be stored yet). */
  function targetOf(effect: Effect<ReportPayload>): Conversation | null {
    const session = effect.payload.deliveredTo
    if (!session) return null
    const here = current()
    if (here.sessionId === session) return here
    return history()?.bySession(session) ?? null
  }

  /**
   * Written in the session it went to (viva-steer `report_written`): that conversation on screen, its record is shown
   * now, where it came, before what the model says next. Kept there already, nothing.
   */
  function written(effect: Effect<ReportPayload>) {
    const target = targetOf(effect)
    if (!target || target.id !== current().id || history()?.hasReport(target.id, effect.key)) return
    const record = recordOf(effect, now())
    show({ type: 'report_delivered', conversationId: target.id, reportId: effect.key, text: record.text, at: record.report.at })
  }

  /**
   * Read there (viva-steer `report_read`, or a pass that found it so): done once its record is kept there. Kept
   * already, or no conversation to keep it in: done now.
   */
  function read(effect: Effect<ReportPayload>) {
    const queue = effects()
    const store = history()
    if (!queue || !store) return
    const target = targetOf(effect)
    if (!target || store.hasReport(target.id, effect.key)) return queue.finish(REPORT, effect.key)
    if (target.id === current().id) {
      // Done when the window saves it (saved); shown again, should the window not have it yet (it dedupes).
      if (!effect.payload.read) queue.amend(effect, { ...effect.payload, read: true })
      return written(effect)
    }
    const found = store.get(target.id)
    if (!found) return queue.finish(REPORT, effect.key)
    apply('report.recorded', { reportId: effect.key, conversationId: target.id }, () => {
      store.save(found.conversation, [...found.messages, recordOf(effect, now())])
      queue.finish(REPORT, effect.key)
    })
  }

  /** The window saved the conversation on screen: a report read whose record it now keeps is done. */
  function saved(messages: readonly StoredMessage[]) {
    const queue = effects()
    if (!queue) return
    for (const message of messages) {
      if (message.role !== 'report' || !message.report) continue
      const queued = queue.get(REPORT, message.report.reportId) as Effect<ReportPayload> | null
      if (queued?.payload.read) queue.finish(REPORT, queued.key)
    }
  }

  return { written, read, saved }
}
