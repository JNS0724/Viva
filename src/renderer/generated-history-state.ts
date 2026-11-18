import { maskTextSpans, mergeTextSpans, type OriginalHistoryCut } from '../memory/contracts/text-spans.ts'

export function accumulateOriginalCuts(previous: State['originalHistoryCuts'], cuts: readonly OriginalHistoryCut[]): State['originalHistoryCuts'] {
  const next: Record<string, OriginalHistoryCut> = Object.assign(Object.create(null), previous)
  for (const cut of cuts) {
    const prior = Object.hasOwn(next, cut.sourceId) ? next[cut.sourceId] : undefined
    next[cut.sourceId] = { ...cut, spans: mergeTextSpans([...prior?.spans ?? [], ...cut.spans]) }
  }
  return next
}

function projectOriginal<T extends { sourceId?: string, text: string, role: string }>(message: T, cuts: State['originalHistoryCuts']): T {
  if (message.role !== 'user' || !message.sourceId || !Object.hasOwn(cuts, message.sourceId)) return message
  const text = projectOriginalText(message.text, cuts[message.sourceId])
  return text === message.text ? message : { ...message, text, receipt: null }
}

function projectOriginalText(text: string, { length, spans }: OriginalHistoryCut): string {
  const offset = text.length - length
  // A question reply may display its selected choices before the canonical custom text.
  return offset >= 0 && (offset === 0 || text[offset - 1] === '、')
    ? text.slice(0, offset) + maskTextSpans(text.slice(offset), spans) : ''
}

function projectAnswerTrace(timeline: ConversationView['timeline'], cuts: State['originalHistoryCuts']) {
  const projected = timeline.map(entry => {
    if (entry.kind !== 'answer' || !entry.sourceRanges) return entry
    let title = entry.title
    for (const { sourceId, start, end } of entry.sourceRanges) {
      if (!Object.hasOwn(cuts, sourceId)) continue
      const projected = projectOriginalText(title.slice(start, end), cuts[sourceId])
      title = title.slice(0, start) + projected.padEnd(end - start) + title.slice(end)
    }
    return title === entry.title ? entry : { ...entry, title }
  })
  return projected.some((entry, i) => entry !== timeline[i]) ? projected : timeline
}

/** History can copy the same unique stream key into multiple branches. Keep their
 * positions and strip the body, including when an earlier read finishes later. */
export function hideErasedHistoryCopies(state: State, previous: State): State {
  const keys = state.erasedGeneratedKeys
  const changed = state.originalHistoryCuts !== previous.originalHistoryCuts || keys !== previous.erasedGeneratedKeys || state.feed.erasedIds !== previous.feed.erasedIds
  if (!Object.keys(state.originalHistoryCuts).length && !Object.keys(keys).length && !state.feed.erasedIds.length) return state
  const erased = (key: string | undefined) => Boolean(key && Object.hasOwn(keys, key))
  const redact = <T extends { role: string, sourceId?: string, key?: string, text: string, feedItemId?: string, images?: unknown, receipt?: Receipt | null }>(messages: readonly T[]) => {
    const hasBody = (message: T) => (erased(message.key) || Boolean(message.feedItemId && state.feed.erasedIds.includes(message.feedItemId)))
      && Boolean(message.text || erased(message.key) && message.images || message.receipt)
    const projected = messages.map(message => hasBody(message)
      ? { ...message, text: '', receipt: null, images: erased(message.key) ? undefined : message.images } : projectOriginal(message, state.originalHistoryCuts))
    return projected.some((message, i) => message !== messages[i]) ? projected : messages
  }

  let next = state
  const cutsChanged = state.originalHistoryCuts !== previous.originalHistoryCuts
  if (cutsChanged || state.timeline !== previous.timeline) {
    const timeline = projectAnswerTrace(state.timeline, state.originalHistoryCuts)
    if (timeline !== state.timeline) next = { ...next, timeline }
  }
  if (cutsChanged || state.tasks.list !== previous.tasks.list) {
    const list = state.tasks.list.map(task => {
      const timeline = projectAnswerTrace(task.view.timeline, state.originalHistoryCuts)
      const messages = redact(task.view.messages)
      return timeline === task.view.timeline && messages === task.view.messages ? task
        : { ...task, view: { ...task.view, timeline, messages } }
    })
    if (list.some((task, i) => task !== state.tasks.list[i])) next = { ...next, tasks: { ...state.tasks, list } }
  }
  if (changed || state.messages !== previous.messages) {
    const hasBody = (message: ThreadMessage) => (erased(message.streamKey) || Boolean(message.feedItemId && state.feed.erasedIds.includes(message.feedItemId)))
      && Boolean(message.text || message.streamBlocks || message.receipt)
    const messages = state.messages.map(message => hasBody(message)
      ? { ...message, text: '', shown: 0, open: false, receipt: null, images: erased(message.streamKey) ? undefined : message.images, streamBlocks: undefined } : projectOriginal(message, state.originalHistoryCuts))
    if (messages.some((message, i) => message !== state.messages[i])) next = { ...next, messages }
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
