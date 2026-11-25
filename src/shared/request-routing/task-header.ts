import {
  escapeAndLocateSpans,
  PROVENANCE_HEAD,
  stripLeadingProvenanceHeader,
  unquoteProvenanceHeader,
} from './provenance.ts'

/**
 * Lightweight task correlation header independent of main-conversation routing (`viva-routing`).
 * Reuses the same zero-width escape and payload-relative span calculation as `provenance.ts` so memory
 * ingestion recovers exact headerless original user/task words while preserving literal `\u200B`.
 */
const TASK_MARK = /【任务请求 ID：([A-Za-z0-9-]{1,64})】\n/g
const LEADING_TASK_MARK = /^【任务请求 ID：([A-Za-z0-9-]{1,64})】\n/
const TASK_HEAD = '【任务请求 ID：'
const ROUTED_HEAD = '【请求 ID：'
const QUOTE = '\u200B'
const TASK_QUOTED = `【${QUOTE}任务请求 ID：`
const ROUTED_QUOTED = `【${QUOTE}请求 ID：`

const unquoteTask = (text: string): string =>
  unquoteProvenanceHeader(text.replaceAll(TASK_QUOTED, TASK_HEAD).replaceAll(ROUTED_QUOTED, ROUTED_HEAD))
const taskPrefix = (id: string) => `${TASK_HEAD}${id}】\n`

export function withTaskRequestSource(words: string, requestId: string) {
  const prefix = taskPrefix(requestId)
  const { payload, spans } = escapeAndLocateSpans(words, words, [TASK_HEAD, ROUTED_HEAD, PROVENANCE_HEAD], prefix)
  const headerLength = prefix.length
  return {
    requestId,
    text: payload,
    headerLength,
    spans,
    payloadSpans: spans.map(({ start, end }) => ({ start: start - headerLength, end: end - headerLength })),
  }
}

export function stripLeadingTaskHeader(text: string): { requestId: string, payload: string } | null {
  const match = LEADING_TASK_MARK.exec(text)
  if (!match) return null
  return { requestId: match[1]!, payload: text.slice(match[0].length) }
}

export function leadingTaskRequestId(text: string): string | undefined {
  return LEADING_TASK_MARK.exec(stripLeadingProvenanceHeader(text))?.[1]
}

export function taskRequestsIn(text: string): Array<{ id: string, words: string }> {
  const clean = stripLeadingProvenanceHeader(text)
  const matches = [...clean.matchAll(TASK_MARK)]
  return matches.map((match, i) => ({
    id: match[1]!,
    words: unquoteTask(clean.slice((match.index ?? 0) + match[0].length, matches[i + 1]?.index ?? clean.length)),
  }))
}

export const withoutTaskHeaders = (text: string): string => unquoteTask(stripLeadingProvenanceHeader(text).replace(TASK_MARK, ''))
