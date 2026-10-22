/** Assistant text and thoughts arrive as open streams; anything else happening closes them. */

export function closeLast(list) {
  const last = list[list.length - 1]
  if (!last?.open) return list
  return [...list.slice(0, -1), { ...last, open: false }]
}

export function closeStreams(state) {
  const messages = closeLast(state.messages)
  const thoughts = closeLast(state.thoughts)
  return messages === state.messages && thoughts === state.thoughts ? state : { ...state, messages, thoughts }
}
