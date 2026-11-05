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
 * - That conversation on screen: the window is the one writer of its messages (each save is its whole list, in order),
 *   so the window draws the record where it came (`written`, as soon as the note is in the session) and keeps it with
 *   its saves. The report is done only once the record is stored there; till then each pass draws it again (the
 *   window draws a report once, and saves) and is put off with the queue's growing waits.
 * - Another conversation (no window writes it now): the record is written in and the report done, in one change; a
 *   write that fails leaves the report queued, tried again after the queue's wait.
 */

/** A report read: its record kept (or nothing to keep it in), so done; or waiting for the window to store it. */
export type RecordState = 'kept' | 'waiting'

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

/**
 * A record for the window to show where it came (state.ts report_delivered): for that conversation, or, before its
 * first save (the window knows no id for it yet), for the topic on that session.
 */
export interface RecordShown { type: 'report_delivered', conversationId: string, sessionId: string, reportId: string, text: string, at: number }

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
    if (!target || target.id !== current().id) return
    // When it came, kept with it: the record written when it is read says the same time.
    const at = effect.payload.recordedAt ?? now()
    if (effect.payload.recordedAt === undefined) effects()?.amend(effect, { ...effect.payload, recordedAt: at })
    showOn(target, effect, at)
  }

  function showOn(target: Conversation, effect: Effect<ReportPayload>, at: number) {
    const record = recordOf(effect, at)
    show({ type: 'report_delivered', conversationId: target.id, sessionId: effect.payload.deliveredTo as string, reportId: effect.key, text: record.text, at })
  }

  /**
   * Read there (viva-steer `report_read`, or a pass that found it so): done once its record is kept there. Kept
   * already, or no conversation to keep it in: done now. Says whether it is done (`kept`), or waits for the window to
   * store its record (`waiting`: to be looked at again after a wait).
   */
  function read(effect: Effect<ReportPayload>): RecordState {
    const queue = effects()
    const store = history()
    if (!queue || !store) return 'waiting'
    const target = targetOf(effect)
    if (!target || store.hasReport(target.id, effect.key)) {
      queue.finish(REPORT, effect.key)
      return 'kept'
    }
    if (target.id === current().id) {
      showOn(target, effect, effect.payload.recordedAt ?? now())
      return 'waiting'
    }
    const found = store.get(target.id)
    if (!found) {
      queue.finish(REPORT, effect.key)
      return 'kept'
    }
    apply('report.recorded', { reportId: effect.key, conversationId: target.id }, () => {
      store.save(found.conversation, [...found.messages, recordOf(effect, effect.payload.recordedAt ?? now())])
      queue.finish(REPORT, effect.key)
    })
    return 'kept'
  }

  return { written, read }
}
