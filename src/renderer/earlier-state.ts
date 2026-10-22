/**
 * The one timeline (single-conversation design): the segments before the one on screen, oldest first, as the
 * history keeps them (main/history-db.js segmentsBefore). The window scrolls up into them; when the conversation
 * goes on in a new segment (another working directory, a new session), the current messages join them here.
 * Pure and immutable like the rest of `state.js`, which merges these handlers into its reducer.
 */
export const initialEarlier = Object.freeze({ segments: [], hasMore: true, loading: false })

const withEarlier = (state: State, changes: Partial<State['earlier']>): State => ({ ...state, earlier: { ...state.earlier, ...changes } })

/**
 * The earlier segments with the messages on screen added as the latest one, when there are any. Their times
 * are when they were put away, close enough for the day they belong to.
 */
export function withCurrentKept(state, at = Date.now()) {
  if (state.messages.length === 0) return state.earlier
  const kept = {
    id: state.conversationId ?? `unsaved-${at}`,
    cwd: state.info.cwd || null,
    // What it went on from, so the topic it belongs to still reads as one (topics.js).
    parentId: state.topic?.parentId ?? null,
    createdAt: at,
    messages: state.messages.map((message, seq) => ({
      seq, role: message.role, text: message.text, receipt: message.receipt ?? null, at, ...(message.images ? { images: message.images } : {}),
    })),
  }
  return { ...state.earlier, segments: [...state.earlier.segments.filter((segment) => segment.id !== kept.id), kept] }
}

export const EARLIER_ACTIONS: Record<string, Reducer> = {
  earlier_loading: (state) => withEarlier(state, { loading: true }),
  /** A page of segments from before those shown; one already there is not shown twice. */
  earlier_loaded: (state, { segments, hasMore }) => {
    const shown = new Set(state.earlier.segments.map((segment) => segment.id))
    const fresh = (segments ?? []).filter((segment) => !shown.has(segment.id))
    return withEarlier(state, { segments: [...fresh, ...state.earlier.segments], hasMore: Boolean(hasMore), loading: false })
  },
  earlier_failed: (state) => withEarlier(state, { loading: false }),
}
