/**
 * Lightweight task correlation header independent of main-conversation routing (`viva-routing`).
 * Reuses the same zero-width escape and `wireSpans` calculation as `header.ts` so memory ingestion
 * recovers exact headerless original user/task words while DSH `pre-step` claims prefetches by `requestId`.
 */
const TASK_MARK = /【任务请求 ID：([A-Za-z0-9-]{1,64})】\n/g
const LEADING_TASK_MARK = /^【任务请求 ID：([A-Za-z0-9-]{1,64})】\n/
const TASK_HEAD = '【任务请求 ID：'
const ROUTED_HEAD = '【请求 ID：'
const QUOTE = '\u200B'
const TASK_QUOTED = `【${QUOTE}任务请求 ID：`
const ROUTED_QUOTED = `【${QUOTE}请求 ID：`

const unquoteTask = (text: string): string => text.replaceAll(TASK_QUOTED, TASK_HEAD).replaceAll(ROUTED_QUOTED, ROUTED_HEAD)
const taskPrefix = (id: string) => `${TASK_HEAD}${id}】\n`

export function withTaskRequestSource(words: string, requestId: string) {
  const spans: { start: number, end: number }[] = []
  let cursor = 0
  let padding = taskPrefix(requestId).length
  const locateThrough = (end: number) => {
    if (cursor < end) spans.push({ start: padding + cursor, end: padding + end })
    cursor = end
  }
  const offsets: number[] = []
  for (const head of [TASK_HEAD, ROUTED_HEAD]) {
    for (let offset = words.indexOf(head); offset !== -1; offset = words.indexOf(head, offset + head.length)) {
      offsets.push(offset)
    }
  }
  offsets.sort((a, b) => a - b)
  for (const offset of offsets) {
    locateThrough(offset + 1)
    padding += QUOTE.length
  }
  locateThrough(words.length)
  return {
    requestId,
    text: taskPrefix(requestId) + words.replaceAll(TASK_HEAD, TASK_QUOTED).replaceAll(ROUTED_HEAD, ROUTED_QUOTED),
    spans,
  }
}

export function leadingTaskRequestId(text: string): string | undefined {
  return LEADING_TASK_MARK.exec(text)?.[1]
}

export function taskRequestsIn(text: string): Array<{ id: string, words: string }> {
  const matches = [...text.matchAll(TASK_MARK)]
  return matches.map((match, i) => ({
    id: match[1]!,
    words: unquoteTask(text.slice((match.index ?? 0) + match[0].length, matches[i + 1]?.index ?? text.length)),
  }))
}

export const withoutTaskHeaders = (text: string): string => unquoteTask(text.replace(TASK_MARK, ''))
