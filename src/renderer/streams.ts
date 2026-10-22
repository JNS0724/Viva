/** Assistant text and thoughts arrive as open streams; anything else happening closes them. */

export function closeLast<T extends { open?: boolean }>(list: readonly T[]): readonly T[] {
  const last = list[list.length - 1]
  if (!last?.open) return list
  return [...list.slice(0, -1), { ...last, open: false }]
}

export function closeStreams(state: State): State {
  const messages = closeLast(state.messages)
  const thoughts = closeLast(state.thoughts)
  return messages === state.messages && thoughts === state.thoughts ? state : { ...state, messages, thoughts }
}
