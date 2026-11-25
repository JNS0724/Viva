import {
  escapeAndLocateSpans,
  PROVENANCE_HEAD,
  stripLeadingProvenanceHeader,
  unquoteProvenanceHeader,
} from './provenance.ts'

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
const QUOTE = '\u200B'
const QUOTED = `【${QUOTE}请求 ID：`
const unquote = (text: string): string => unquoteProvenanceHeader(text.replaceAll(QUOTED, HEAD))

const requestPrefix = (id: string) => `${HEAD}${id}】\n用户原话：`
export const withRequestHeader = (words: string, requestId: string): string => requestPrefix(requestId) + words.replaceAll(HEAD, QUOTED)

/** Locate original source text in the final wire, including headers quoted within it. */
export function withRequestSource(words: string, requestId: string, source: string) {
  const { payload, spans } = escapeAndLocateSpans(words, source, [HEAD, PROVENANCE_HEAD], requestPrefix(requestId))
  return { text: payload, spans }
}

/** The requests named in a message, in order, each with the words that follow its header. */
export function requestsIn(text: string): Array<{ id: string, words: string }> {
  const matches = [...text.matchAll(MARK)]
  return matches.map((match, i) => ({ id: match[1], words: unquote(text.slice((match.index ?? 0) + match[0].length, matches[i + 1]?.index ?? text.length)) }))
}

/** The words without request headers, as the fast lane reads earlier turns. */
export const withoutHeaders = (text: string): string => unquote(stripLeadingProvenanceHeader(text).replace(MARK, ''))
