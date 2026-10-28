/**
 * Where a message named by a search hit or a link, once the history has found it (history-db.ts locate, so the
 * place alone never stands for it), is on screen in the one timeline. A segment's `seq` counts its
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

export function hitTarget(state: State, found: VerifiedMessage): { msgId: string } | null {
  // The conversation on screen: its finished messages are what is saved, in order, and the history has just said
  // the message is there now at that place (history-db.ts locate), so its place names it.
  if (found.segmentId === state.conversationId) {
    const message = state.messages.filter((m: ThreadMessage) => !m.open)[found.seq]
    return message ? { msgId: message.id } : null
  }
  const segment: Segment | undefined = state.earlier.segments.find((s: Segment) => s.id === found.segmentId)
  const message = segment?.messages.find((m) => m.seq === found.seq)
  if (!message) return null
  // A row read back from the history has its id: only the very message is taken (not one read before it was said
  // again differently). A row without one is the window's own conversation moved up (a new topic): like the
  // conversation on screen, its place is what the history has just confirmed.
  return message.id === undefined || message.id === found.messageId ? { msgId: `${found.segmentId}-${found.seq}` } : null
}

/** A message the history has found where it is now (history-db.ts locate, status 'found'): its id is checked. */
export type VerifiedMessage = { segmentId: string, seq: number, messageId: number }
