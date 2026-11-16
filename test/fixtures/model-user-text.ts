/** Test responder parsing only. Recovery history may share a provider user message with a new prompt. */
export function currentTurnTextParts(texts: readonly string[]): string[] {
  const opening = 'The previous generated context has been retired.'
  const closing = '[End of earlier user messages]'
  let historical = false
  let current: string[] = []
  for (const text of texts) {
    if (text.startsWith(opening)) { historical = true; current = [] }
    const boundary = historical ? text.lastIndexOf(closing) : -1
    if (boundary >= 0) {
      historical = false
      const after = text.slice(boundary + closing.length).trimStart()
      if (after) current.push(after)
    } else if (!historical) current.push(text)
  }
  return current
}
