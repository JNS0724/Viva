/**
 * Where a search hit (history-db.js searchMessages) is in the one timeline. A segment's `seq` counts its saved
 * messages, which are the finished ones on screen (selectors.js historyMessages); an earlier segment's rows carry
 * `<segment id>-<seq>` (selectors.js earlierRows).
 * @returns the message's row, more pages to read first, or nowhere
 */
export function hitTarget(state: State, hit: SearchHit): { msgId: string } | { load: true } | null {
  if (hit.segmentId === state.conversationId) {
    const message = state.messages.filter((m: ThreadMessage) => !m.open)[hit.seq]
    return message ? { msgId: message.id } : null
  }
  const segment: Segment | undefined = state.earlier.segments.find((s: Segment) => s.id === hit.segmentId)
  if (segment) return segment.messages.some((m) => m.seq === hit.seq) ? { msgId: `${segment.id}-${hit.seq}` } : null
  return state.earlier.hasMore ? { load: true } : null
}
