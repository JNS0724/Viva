export type TextSpan = { start: number, end: number }

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
