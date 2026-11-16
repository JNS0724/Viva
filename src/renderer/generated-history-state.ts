/** History can copy the same unique stream key into multiple branches. Keep their
 * positions and strip the body, including when an earlier read finishes later. */
export function hideErasedHistoryCopies(state: State, previous: State): State {
  const keys = state.erasedGeneratedKeys
  const changed = keys !== previous.erasedGeneratedKeys || state.feed.erasedIds !== previous.feed.erasedIds
  if (!Object.keys(keys).length && !state.feed.erasedIds.length) return state
  const erased = (key: string | undefined) => Boolean(key && Object.hasOwn(keys, key))
  const redact = <T extends { key?: string, text: string, feedItemId?: string, images?: unknown, receipt?: Receipt | null }>(messages: readonly T[]) => {
    const hasBody = (message: T) => (erased(message.key) || Boolean(message.feedItemId && state.feed.erasedIds.includes(message.feedItemId)))
      && Boolean(message.text || erased(message.key) && message.images || message.receipt)
    return messages.some(hasBody) ? messages.map(message => hasBody(message)
      ? { ...message, text: '', receipt: null, images: erased(message.key) ? undefined : message.images } : message) : messages
  }

  let next = state
  if (changed || state.messages !== previous.messages) {
    const hasBody = (message: ThreadMessage) => (erased(message.streamKey) || Boolean(message.feedItemId && state.feed.erasedIds.includes(message.feedItemId)))
      && Boolean(message.text || message.streamBlocks || message.receipt)
    if (state.messages.some(hasBody)) next = { ...next, messages: state.messages.map(message => hasBody(message)
      ? { ...message, text: '', shown: 0, open: false, receipt: null, images: erased(message.streamKey) ? undefined : message.images, streamBlocks: undefined } : message) }
  }
  if (changed || state.earlier.segments !== previous.earlier.segments) {
    const segments = state.earlier.segments.map((segment: Segment) => {
      const messages = redact(segment.messages)
      return messages === segment.messages ? segment : { ...segment, messages }
    })
    if (segments.some((segment, index) => segment !== state.earlier.segments[index])) next = { ...next, earlier: { ...state.earlier, segments } }
  }
  if (changed || state.rewind.open !== previous.rewind.open) {
    const open = Object.entries(state.rewind.open).map(([id, messages]) => [id, redact(messages as readonly SegmentMessage[])] as const)
    if (open.some(([id, messages]) => messages !== state.rewind.open[id])) next = { ...next, rewind: { ...state.rewind, open: Object.fromEntries(open) } }
  }
  if (state.review.reading && (changed || state.review.reading !== previous.review.reading)) {
    const reading = state.review.reading
    const messages = redact(reading.messages)
    if (messages !== reading.messages) next = { ...next, review: { ...state.review, reading: { ...reading, messages } } }
  }
  return next
}
