/**
 * The request header (docs/agent-routing-design.md §5): the app puts it before the words of each request it hands to
 * the main agent, and the routing plugin keeps its ledger by it. One definition for both sides.
 */
const MARK = /【请求 ID：([A-Za-z0-9-]{1,64})】\n用户原话：/g
const HEAD = '【请求 ID：'
/**
 * A header inside the user's words (quoted from a log, say) is theirs, not a request: it goes in with a zero-width
 * space after its bracket, so only the app's own headers match, and comes back out as they said it.
 */
const QUOTED = '【\u200B请求 ID：'
const unquote = (text: string): string => text.replaceAll(QUOTED, HEAD)

export const withRequestHeader = (words: string, requestId: string): string => `${HEAD}${requestId}】\n用户原话：${words.replaceAll(HEAD, QUOTED)}`

/** The requests named in a message, in order, each with the words that follow its header. */
export function requestsIn(text: string): Array<{ id: string, words: string }> {
  const matches = [...text.matchAll(MARK)]
  return matches.map((match, i) => ({ id: match[1], words: unquote(text.slice((match.index ?? 0) + match[0].length, matches[i + 1]?.index ?? text.length)) }))
}

/** The words without request headers, as the fast lane reads earlier turns. */
export const withoutHeaders = (text: string): string => unquote(text.replace(MARK, ''))
