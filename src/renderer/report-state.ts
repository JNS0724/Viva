import type { ActionHandlers } from './action-types.ts'
import { closeStreams } from './streams.ts'

/**
 * Background tasks' results the model read, as the records the conversation on screen draws (system-design §11.5
 * point 7). They are not messages: the backend keeps them (report-records.ts), the window only draws them, each
 * after the message it came after (`after`: how many messages came before it), so a record never moves a message
 * nor a message's place in the history. Pure and immutable like the rest of `state.ts`, which merges these handlers.
 */

const MAX_TEXT_CHARS = 20_000
const MAX_ID_CHARS = 200

/** A record as the backend gives it (history-db.ts ReportRecord), checked; one that is not right is left out. */
function recordOf(value: unknown): ReportRecord | null {
  if (!value || typeof value !== 'object') return null
  const { reportId, at, text, after } = value as Record<string, unknown>
  if (typeof reportId !== 'string' || !reportId || reportId.length > MAX_ID_CHARS) return null
  if (typeof text !== 'string' || !text || text.length > MAX_TEXT_CHARS) return null
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return null
  if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) return null
  return Object.freeze({ reportId, at, text, after })
}

/**
 * The records drawn after `after` messages of the conversation on screen. One after more messages than there are (a
 * turn redone, an answer left out) is drawn after the last.
 */
export const recordsAt = (state: Pick<State, 'records' | 'messages'>, after: number): readonly ReportRecord[] =>
  state.records.filter((record) => Math.min(record.after, state.messages.length) === after)

/** The records of a conversation loaded, from what the backend sent. */
export const recordsFrom = (input: unknown): readonly ReportRecord[] =>
  (Array.isArray(input) ? input.flatMap((value) => recordOf(value) ?? []) : [])

/**
 * Whether a record is for the topic on screen: its conversation, or, while the topic is not saved yet (no id for it
 * here), its session; never one being left for a new topic.
 */
const isRecordFor = (state: State, conversationId: unknown, sessionId: unknown) => (state.conversationId !== null
  ? conversationId === state.conversationId
  : !state.newTopicPending && typeof sessionId === 'string' && sessionId === state.info.sessionId)

export const REPORT_ACTIONS= {
  /**
   * A task's result the model read, drawn where it came: after the messages there now. What the agent was writing
   * closes, so what it says next comes below the record. The same report twice is one record; one for a
   * conversation not on screen is not drawn here (the backend keeps it there).
   */
  report_delivered: (state, { conversationId, sessionId, reportId, text, at }) => {
    if (!isRecordFor(state, conversationId, sessionId) || state.records.some((record) => record.reportId === reportId)) return state
    const closed = closeStreams(state)
    const record = recordOf({ reportId, at, text, after: closed.messages.length })
    return record ? { ...closed, records: [...closed.records, record] } : state
  },
} satisfies ActionHandlers
