export type TextSpan = { start: number, end: number }

export type OriginalHistoryCut = { sourceId: string, length: number, spans: readonly TextSpan[] }

export function mergeTextSpans(spans: readonly TextSpan[]): TextSpan[] {
  const result: TextSpan[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1)
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end)
    else result.push({ ...span })
  }
  return result
}

/** Mask checked UTF-16 spans without moving offsets or line breaks. */
export function maskTextSpans(text: string, spans: readonly TextSpan[]): string {
  let projected = '', offset = 0
  for (const span of mergeTextSpans(spans)) {
    projected += text.slice(offset, span.start) + text.slice(span.start, span.end).replace(/[^\r\n]/g, ' ')
    offset = span.end
  }
  return projected + text.slice(offset)
}
