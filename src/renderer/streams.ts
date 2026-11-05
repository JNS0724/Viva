/** Assistant text and thoughts arrive as open streams; anything else happening closes them. */

export function closeLast<T extends { open?: boolean }>(list: readonly T[]): readonly T[] {
  const last = list[list.length - 1]
  if (!last?.open) return list
  return [...list.slice(0, -1), { ...last, open: false }]
}

/** What the agent was writing or thinking, closed; the rest of the view (a conversation, or the window's state) as it is. */
export function closeStreams<V extends Pick<ConversationView, 'messages' | 'thoughts'>>(state: V): V {
  const messages = closeLast(state.messages)
  const thoughts = closeLast(state.thoughts)
  return messages === state.messages && thoughts === state.thoughts ? state : { ...state, messages, thoughts }
}
