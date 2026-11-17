/** Test responder parsing only. Recovery history may share a provider user message with a new prompt. */
export function currentTurnTextParts(texts: readonly string[]): string[] {
  const opening = 'The previous generated context has been retired.'
  const closing = '[End of earlier user messages]'
  let historical = false
  let current: string[] = []
  const append = (text: string) => {
    // A system prompt after a recovered user message is represented by pi-ai as
    // a user-role reminder. It remains context, including when the provider
    // joins adjacent messages. Only consume complete leading protocol frames.
    const frame = /^<system-reminder>\r?\n(?:(?!<system-reminder>)[\s\S])*?\r?\n<\/system-reminder>(?:\r?\n|$)/u
    let match: RegExpExecArray | null
    while ((match = frame.exec(text))) text = text.slice(match[0].length).trimStart()
    if (text) current.push(text)
  }
  for (const text of texts) {
    if (text.startsWith(opening)) { historical = true; current = [] }
    const boundary = historical ? text.lastIndexOf(closing) : -1
    if (boundary >= 0) {
      historical = false
      const after = text.slice(boundary + closing.length).trimStart()
      append(after)
    } else if (!historical) append(text)
  }
  return current
}
