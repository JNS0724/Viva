/**
 * The request header (docs/agent-routing-design.md §5): the app puts it before the words of each request it hands to
 * the main agent, and the routing plugin keeps its ledger by it. One definition for both sides.
 */
const MARK = /【请求 ID：([A-Za-z0-9-]{1,64})】\n用户原话：/g

export const withRequestHeader = (words: string, requestId: string): string => `【请求 ID：${requestId}】\n用户原话：${words}`

/** The requests named in a message, in order, each with the words that follow its header. */
export function requestsIn(text: string): Array<{ id: string, words: string }> {
  const matches = [...text.matchAll(MARK)]
  return matches.map((match, i) => ({ id: match[1], words: text.slice((match.index ?? 0) + match[0].length, matches[i + 1]?.index ?? text.length) }))
}

/** The words without request headers, as the fast lane reads earlier turns. */
export const withoutHeaders = (text: string): string => text.replace(MARK, '')
