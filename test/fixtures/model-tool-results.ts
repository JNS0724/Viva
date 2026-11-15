/** Match result blocks to their actual call, even when a runtime notice follows the tool response. */
export function modelToolResults(request: { messages: readonly { content?: unknown }[] }, name: string): unknown[] {
  const calls = new Set<string>()
  const results: unknown[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const raw of message.content as unknown[]) {
      if (!raw || typeof raw !== 'object') continue
      const part = raw as Record<string, unknown>
      if (part.type === 'tool_use' && part.name === name && typeof part.id === 'string') calls.add(part.id)
      if (part.type === 'tool_result' && typeof part.tool_use_id === 'string' && calls.has(part.tool_use_id)) results.push(part.content)
    }
  }
  return results
}
