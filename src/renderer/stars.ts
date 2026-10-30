/**
 * 收藏: a star on a message (history-review.ts keeps them), wherever the message is shown — the conversation on
 * screen, the earlier part of the timeline, a topic read in 回顾 — found by the segment it is kept in and its place
 * there (history-db.ts seq). The view puts the star by the message (view/star-buttons.ts).
 */
export type MessagePlace = { segmentId: string, seq: number }

export const starKey = (place: MessagePlace) => `${place.segmentId}:${place.seq}`

/** An earlier row's or a 回顾 row's `data-msg` (selectors.ts earlierRows: `<segment id>-<seq>`). */
export function rowPlace(msgId: string): MessagePlace | null {
  const at = msgId.lastIndexOf('-')
  const seq = Number(msgId.slice(at + 1))
  if (at <= 0 || !/^\d+$/.test(msgId.slice(at + 1)) || !Number.isSafeInteger(seq)) return null
  return { segmentId: msgId.slice(0, at), seq }
}

/**
 * A message where it is shown: in the conversation on screen ('thread'), its seq counts the finished messages, as
 * they are saved (selectors.ts historyMessages), and only once the conversation is saved; elsewhere ('row'), its mark.
 */
export function placeOf(state: State, msgId: string, where: 'thread' | 'row'): MessagePlace | null {
  if (where === 'row') return rowPlace(msgId)
  if (!state.conversationId) return null
  const seq = state.messages.filter((message) => !message.open).findIndex((message) => message.id === msgId)
  return seq < 0 ? null : { segmentId: String(state.conversationId), seq }
}

export const isStarred = (state: State, place: MessagePlace) => state.review.starKeys.includes(starKey(place))
