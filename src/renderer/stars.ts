/**
 * 收藏: a star on a message (history-review.ts keeps them), wherever the message is shown — the conversation on
 * screen, the earlier part of the timeline, a topic read in 回顾 — found by the segment it is kept in and its place
 * there (history-db.ts seq). The view puts the star by the message (view/star-buttons.ts).
 */
export type MessagePlace = { segmentId: string, seq: number }

export const starKey = (place: MessagePlace) => `${place.segmentId}:${place.seq}`

const messagePlaces = new WeakMap<State['messages'], Map<string, number>>()
const starredKeys = new WeakMap<State['review']['starKeys'], Set<string>>()

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
  let places = messagePlaces.get(state.messages)
  if (!places) {
    places = new Map()
    let seq = 0
    for (const message of state.messages) {
      if (message.open) continue
      if (!places.has(message.id)) places.set(message.id, seq)
      seq += 1
    }
    messagePlaces.set(state.messages, places)
  }
  const seq = places.get(msgId)
  return seq === undefined ? null : { segmentId: String(state.conversationId), seq }
}

export function isStarred(state: State, place: MessagePlace): boolean {
  let keys = starredKeys.get(state.review.starKeys)
  if (!keys) {
    keys = new Set(state.review.starKeys)
    starredKeys.set(state.review.starKeys, keys)
  }
  return keys.has(starKey(place))
}
