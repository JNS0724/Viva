import type { ActionHandlers } from './action-types.ts'
/**
 * The one timeline (single-conversation design): the segments before the one on screen, oldest first, as the
 * history keeps them (main/history-db.js segmentsBefore). The window scrolls up into them; when the conversation
 * goes on in a new segment (another working directory, a new session), the current messages join them here.
 * Pure and immutable like the rest of `state.js`, which merges these handlers into its reducer.
 */
export const initialEarlier = Object.freeze({ segments: [], hasMore: true, loading: false })

const withEarlier = (state: State, changes: Partial<State['earlier']>): State => ({ ...state, earlier: { ...state.earlier, ...changes } })

/** Scrolling up reads the timeline back this far by itself; what is older is read in 回顾 (view/review.ts). */
export const RECENT_DAYS = 7
const DAY_MS = 86_400_000

/** Whether the oldest part read back is already older than the recent days: scrolling up stops there. */
export function reachedRecentEnd(earlier: State['earlier'], now = Date.now()): boolean {
  const oldest: Segment | undefined = earlier.segments[0]
  if (!oldest) return false
  const at = oldest.messages[0]?.at ?? oldest.createdAt
  return typeof at === 'number' && at < now - RECENT_DAYS * DAY_MS
}

/**
 * The earlier segments with the messages on screen added as the latest one, when there are any. Their times
 * are when they were put away, close enough for the day they belong to.
 */
export function withCurrentKept(state: State, at = Date.now()): State['earlier'] {
  if (state.messages.length === 0) return state.earlier
  const offset = state.historyOffset ?? 0
  const kept: Segment = {
    id: state.conversationId ?? `unsaved-${at}`,
    sourceSessionId: state.info.sessionId ?? null,
    cwd: state.info.cwd || null,
    // What it went on from, so the topic it belongs to still reads as one (topics.js).
    parentId: state.topic?.parentId ?? null,
    createdAt: at,
    ...(offset > 0 ? { offset } : {}),
    messages: state.messages.map((message: ThreadMessage, seq: number) => ({
      seq: offset + seq, role: message.role, text: message.text, receipt: message.receipt ?? null, at, ...(message.images ? { images: message.images } : {}),
      ...(message.streamKey ? { key: message.streamKey } : {}),
    })),
    records: state.records,
  }
  return { ...state.earlier, segments: [...state.earlier.segments.filter((segment: Segment) => segment.id !== kept.id), kept] }
}

export const EARLIER_ACTIONS= {
  earlier_loading: (state) => withEarlier(state, { loading: true }),
  /** A page of segments from before those shown; one already there is not shown twice. */
  earlier_loaded: (state, { segments, hasMore }) => {
    const shown = new Set(state.earlier.segments.map((segment: Segment) => segment.id))
    const fresh = (segments ?? []).filter((segment: Segment) => !shown.has(segment.id)).map(segment => {
      if (!segment.records) return segment
      const records = segment.records
      return records === segment.records ? segment : { ...segment, records }
    })
    return withEarlier(state, { segments: [...fresh, ...state.earlier.segments], hasMore: Boolean(hasMore), loading: false })
  },
  earlier_failed: (state) => withEarlier(state, { loading: false }),
} satisfies ActionHandlers
