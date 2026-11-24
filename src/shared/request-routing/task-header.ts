/**
 * Lightweight task correlation header independent of main-conversation routing (`viva-routing`).
 * Reuses the same zero-width escape and `wireSpans` calculation as `header.ts` so memory ingestion
 * recovers exact headerless original user/task words while DSH `pre-step` claims prefetches by `requestId`.
 */
const TASK_MARK = /【任务请求 ID：([A-Za-z0-9-]{1,64})】\n/g
const TASK_HEAD = '【任务请求 ID：'
const QUOTE = '\u200B'
const TASK_QUOTED = `【${QUOTE}任务请求 ID：`

const unquoteTask = (text: string): string => text.replaceAll(TASK_QUOTED, TASK_HEAD)
const taskPrefix = (id: string) => `${TASK_HEAD}${id}】\n`

export function withTaskRequestSource(words: string, requestId: string) {
  const spans: { start: number, end: number }[] = []
  let cursor = 0
  let padding = taskPrefix(requestId).length
  const locateThrough = (end: number) => {
    if (cursor < end) spans.push({ start: padding + cursor, end: padding + end })
    cursor = end
  }
  for (let offset = words.indexOf(TASK_HEAD); offset !== -1; offset = words.indexOf(TASK_HEAD, offset + TASK_HEAD.length)) {
    locateThrough(offset + 1)
    padding += QUOTE.length
  }
  locateThrough(words.length)
  return {
    requestId,
    text: taskPrefix(requestId) + words.replaceAll(TASK_HEAD, TASK_QUOTED),
    spans,
  }
}

export function taskRequestsIn(text: string): Array<{ id: string, words: string }> {
  const matches = [...text.matchAll(TASK_MARK)]
  return matches.map((match, i) => ({
    id: match[1]!,
    words: unquoteTask(text.slice((match.index ?? 0) + match[0].length, matches[i + 1]?.index ?? text.length)),
  }))
}

export const withoutTaskHeaders = (text: string): string => unquoteTask(text.replace(TASK_MARK, ''))
