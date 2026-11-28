import type { Apply } from './journal.ts'
import type { Effect } from './effects.ts'
import type { Conversation } from './history-db.ts'
import type { ConversationContext } from '../shared/conversation-context.ts'
import { REPORT, recordedNote, type ReportPayload } from './task-reports.ts'

/**
 * Where a background task's result the model read is kept (system-design §11.5): as a record of the
 * conversation of the session it was delivered to, which need not be the one on screen now (the user moved to another
 * topic since). Records have one writer, this one, in a table of their own (history-db.ts report_records): the
 * window's saves of its messages never touch them, and a record never moves a message.
 *
 * - Written in the session (viva-steer `report_written`): that conversation on screen, the window draws it where it
 *   came, before what the model says next (state.ts report_delivered). Drawing is all the window does with it.
 * - Read there (viva-steer `report_read`, or a pass that found it so): the record is kept, after the messages stored
 *   there then, and the report done, in one change. A write that fails leaves the report queued, tried again after
 *   the queue's wait; a report already recorded is not recorded again.
 */

/** What of the history is used here. */
export interface RecordHistory {
  bySession: (sessionId: string) => Conversation | null
  /** Whether a conversation is stored (a blank topic is not, till its first save). */
  get: (id: string) => unknown
  /** Whether a conversation row ever existed in `conversations`, including soft-deleted ones. */
  hasAnyConversation?: (id: string) => boolean
  save: (conversation: Conversation, messages: readonly never[], options: { keepEmpty: boolean }) => unknown
  addRecord: (record: { conversationId: string, reportId: string, at: number, text: string, beforeSource?: string, after?: number }) => boolean
}

/** What of the effects queue is used here. */
export interface RecordEffects {
  get: (kind: string, key: string) => Effect | null
  holds: (effect: Effect) => boolean
  finishGeneration: (effect: Effect) => boolean
  amend: <P extends object>(effect: Effect<P>, payload: P) => boolean
}

/**
 * A record for the window to draw where it came (state.ts report_delivered): for that conversation, or, before its
 * first save (the window knows no id for it yet), for the topic on that session.
 */
export interface RecordShown { type: 'report_delivered', conversationId: string, sessionId: string, reportId: string, text: string, at: number, beforeSource?: string, context: ConversationContext }

export interface ReportRecordsDeps {
  history: () => RecordHistory | null
  effects: () => RecordEffects | null
  apply: Apply
  /** The conversation on screen. */
  current: () => Conversation
  show: (event: RecordShown) => void
  /** Flush any in-memory foreground text before a report record counts persisted messages; return false / { ready: false } to defer. */
  beforeRecord?: (conversationId: string, reportId: string) => boolean | { ready: boolean, after?: number } | void
  now?: () => number
}

export function createReportRecords({ history, effects, apply, current, show, beforeRecord, now = Date.now }: ReportRecordsDeps) {
  /** The conversation of the session a report went to: the one on screen first, then saved history, then an unsaved blank topic snapshotted before sending. */
  function targetOf(effect: Effect<ReportPayload>): Conversation | null {
    const session = effect.payload.deliveredTo
    if (!session) return null
    const store = history()
    const here = current()
    if (here.sessionId === session) {
      if (store && !store.get(here.id) && store.hasAnyConversation?.(here.id)) return null
      return here
    }
    const saved = store?.bySession(session) ?? null
    if (saved) return saved
    const snap = effect.payload.deliveredConversation
    if (snap && snap.sessionId === session && !store?.hasAnyConversation?.(snap.id)) return snap
    return null
  }

  /** The time a report's record says: when it was first drawn, kept with the report so the kept record says the same. */
  const timeOf = (effect: Effect<ReportPayload>) => effect.payload.recordedAt ?? now()

  function drawOn(target: Conversation, effect: Effect<ReportPayload>, at: number) {
    const context = { conversationId: target.id, sessionId: effect.payload.deliveredTo as string }
    show({ type: 'report_delivered', conversationId: target.id, sessionId: context.sessionId, reportId: effect.key, text: recordedNote(effect.payload), at, ...(effect.payload.beforeSource && { beforeSource: effect.payload.beforeSource }), context })
  }

  // The user message may already be saved when the native read receipt arrives after restart.
  function beforeUser(reportIds: readonly string[], session: string, source: string) {
    const queue = effects()
    if (!queue) return
    for (const id of reportIds) {
      const queued = queue.get(REPORT, id) as Effect<ReportPayload> | null
      if (queued?.payload.deliveredTo === session && queued.payload.via === 'turn' && !queued.payload.beforeSource) {
        queue.amend(queued, { ...queued.payload, beforeSource: source })
      }
    }
  }

  /** Written in the session it went to: that conversation on screen, its record is drawn now, where it came. */
  function written(effect: Effect<ReportPayload>) {
    const queue = effects()
    if (!queue?.holds(effect)) return
    const target = targetOf(effect)
    if (!target || target.id !== current().id) return
    const at = timeOf(effect)
    if (effect.payload.recordedAt === undefined && !queue.amend(effect, { ...effect.payload, recordedAt: at })) return
    drawOn(target, effect, at)
  }

  /**
   * Read there: its record kept and the report done, in one change; drawn too when that conversation is on screen
   * (the window draws a report once). No conversation to keep it in (its session's is gone): done. Throws when the
   * record cannot be kept now, the report left queued.
   */
  function read(effect: Effect<ReportPayload>) {
    const queue = effects()
    const store = history()
    if (!queue || !store) throw new Error('the history is not open for a report\'s record')
    // A pending status request can carry an older snapshot across beforeUser.
    const latest = queue.get(effect.kind, effect.key) as Effect<ReportPayload> | null
    if (!latest || latest.generation !== effect.generation) return
    if (latest.payload.deliveredTo) effect = latest
    const target = targetOf(effect)
    if (!target) {
      apply('effect.done', { kind: effect.kind, key: effect.key }, () => queue.finishGeneration(effect))
      return
    }
    const at = timeOf(effect)
    const gate = beforeRecord?.(target.id, effect.key)
    if (gate === false || (gate && typeof gate === 'object' && !gate.ready)) {
      throw new Error('foreground history has pending writes before report record')
    }
    const anchored = gate && typeof gate === 'object' ? gate.after : undefined
    const kept = apply('report.recorded', { reportId: effect.key, conversationId: target.id }, () => {
      if (!queue.finishGeneration(effect)) return false
      // A blank topic on screen is stored with it, so the record has a conversation to come back with after a restart.
      if (!store.get(target.id)) store.save(target, [], { keepEmpty: true })
      store.addRecord({
        conversationId: target.id, reportId: effect.key, at, text: recordedNote(effect.payload),
        beforeSource: effect.payload.beforeSource, ...(anchored !== undefined ? { after: anchored } : {}),
      })
      return true
    }).value
    if (kept && target.id === current().id) drawOn(target, effect, at)
  }

  return { beforeUser, written, read }
}
