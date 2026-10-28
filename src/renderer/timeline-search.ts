/**
 * Where a search hit (history-db.js searchMessages) is on screen in the one timeline. A segment's `seq` counts its
 * saved messages, which are the finished ones on screen (selectors.js historyMessages); an earlier segment's rows
 * carry `<segment id>-<seq>` (selectors.js earlierRows). Anything not on screen is read in 回顾 instead
 * (review-actions.ts openRef), straight from where it is, never by reading the timeline back page after page.
 * @returns the message's row, or null when it is not on screen
 */
const PLACE = /^viva:\/\/timeline\/([A-Za-z0-9-]{1,64})\/(\d{1,6})(?:\/(\d{1,15}))?$/

/**
 * A viva://timeline/<segment>/<seq>[/<message id>] link (search_conversations) as the message it names, or null.
 * Answers from before the id was added name only the place.
 */
export function timelinePlace(url: string): SearchHit | null {
  const match = PLACE.exec(url)
  if (!match) return null
  return match[3] === undefined ? { segmentId: match[1], seq: Number(match[2]) } : { segmentId: match[1], seq: Number(match[2]), messageId: Number(match[3]) }
}

export function hitTarget(state: State, hit: SearchHit): { msgId: string } | null {
  if (hit.segmentId === state.conversationId) {
    const message = state.messages.filter((m: ThreadMessage) => !m.open)[hit.seq]
    return message ? { msgId: message.id } : null
  }
  const segment: Segment | undefined = state.earlier.segments.find((s: Segment) => s.id === hit.segmentId)
  const message = segment?.messages.find((m) => m.seq === hit.seq)
  // Another message at that place now (a turn redone): not the one named.
  if (!message || (hit.messageId !== undefined && message.id !== undefined && message.id !== hit.messageId)) return null
  return { msgId: `${hit.segmentId}-${hit.seq}` }
}
