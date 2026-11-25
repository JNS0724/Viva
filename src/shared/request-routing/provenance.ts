/**
 * Top-level structured provenance header and unified payload-relative UTF-16 `humanSpans`
 * for Viva -> DSH prompts and typed steers (docs/memory-runtime-decoupling.md §5.4).
 *
 * All `humanSpans` coordinates are UTF-16 offsets relative to `payload` AFTER stripping the
 * top-level structured header (or leading task header on `viva-task-human-steer`).
 * Spans exclude ONLY Viva-inserted zero-width QUOTE characters, so literal user `\u200B`
 * and quoted lookalike headers round-trip verbatim without calling generic `unquote()`.
 */
export type DispatchOrigin = 'human' | 'router' | 'unattended'
export type SessionKind = 'main' | 'task' | 'unattended'
export type WireSourceKind =
  | 'main-human'
  | 'project-user'
  | 'question-answer'
  | 'task-human-steer'
  | 'task-question-answer'
  | 'task-brief'
  | 'task-assistant'
  | 'viva-report'
  | 'viva-report-batch'
  | 'unattended'

export type HumanSpan = { start: number, end: number }

export type VivaProvenanceHeader = {
  origin: DispatchOrigin
  sourceKind: WireSourceKind
  sessionKind: SessionKind
  conversationId?: string
  sourceId?: string
  humanSpans?: HumanSpan[]
}

export type SteerMessageSource =
  | { kind: 'viva-main-human-steer', sourceId?: string, conversationId?: string, humanSpans?: HumanSpan[] }
  | { kind: 'viva-task-human-steer', sourceId?: string, conversationId?: string, humanSpans?: HumanSpan[] }
  | { kind: 'viva-task-router-message', conversationId?: string }

export const PROVENANCE_HEAD = '【Viva 元数据：'
const QUOTE = '\u200B'
export const PROVENANCE_QUOTED = `【${QUOTE}Viva 元数据：`
const LEADING_PROVENANCE_MARK = /^【Viva 元数据：([^\n】]+)】\n/

const ORIGINS: ReadonlySet<string> = new Set(['human', 'router', 'unattended'])
const SESSION_KINDS: ReadonlySet<string> = new Set(['main', 'task', 'unattended'])
const SOURCE_KINDS: ReadonlySet<string> = new Set([
  'main-human', 'project-user', 'question-answer', 'task-human-steer', 'task-question-answer',
  'task-brief', 'task-assistant', 'viva-report', 'viva-report-batch', 'unattended',
])

export function validateHumanSpans(raw: unknown, maxLength: number): HumanSpan[] | null {
  if (!Array.isArray(raw)) return null
  const spans: HumanSpan[] = []
  let position = 0
  for (const item of raw) {
    let start: unknown, end: unknown
    if (Array.isArray(item) && item.length === 2) {
      ;[start, end] = item
    } else if (item && typeof item === 'object') {
      const pair = item as { start?: unknown, end?: unknown }
      start = pair.start
      end = pair.end
    } else {
      return null
    }
    if (typeof start !== 'number' || typeof end !== 'number'
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < position || start >= end || end > maxLength) {
      return null
    }
    spans.push({ start, end })
    position = end
  }
  return spans
}

/**
 * Reconstruct verbatim human text from `payload` using disjoint ordered UTF-16 spans.
 * Never calls generic `unquote()`, preserving literal user `\u200B` verbatim.
 */
export function extractHumanSpans(payload: string, spans: readonly HumanSpan[]): string | null {
  let position = 0
  const parts: string[] = []
  for (const { start, end } of spans) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < position || start >= end || end > payload.length) {
      return null
    }
    parts.push(payload.slice(start, end))
    position = end
  }
  return parts.join('')
}

/**
 * Escape occurrences of any lookalike `heads` inside `words` (inserting `\u200B` after `【`),
 * prepend `leadingPrefix`, and compute exact disjoint payload-relative `humanSpans` covering
 * `sourceText` (which must be a suffix of `words` or empty).
 */
export function escapeAndLocateSpans(
  words: string,
  sourceText: string,
  heads: readonly string[],
  leadingPrefix = '',
): { payload: string, spans: HumanSpan[] } {
  if (sourceText.length > 0 && !words.endsWith(sourceText)) {
    throw new Error('Request source is not the final part of its input')
  }
  const sourceStart = words.length - sourceText.length
  const offsets: number[] = []
  for (const head of heads) {
    for (let offset = words.indexOf(head); offset !== -1; offset = words.indexOf(head, offset + head.length)) {
      offsets.push(offset)
    }
  }
  if (offsets.length === 0) {
    const payload = leadingPrefix + words
    const spans = sourceText.length > 0
      ? [{ start: leadingPrefix.length + sourceStart, end: leadingPrefix.length + words.length }]
      : []
    return { payload, spans }
  }
  offsets.sort((a, b) => a - b)
  const parts: string[] = [leadingPrefix]
  const spans: HumanSpan[] = []
  let cursor = 0
  let padding = leadingPrefix.length
  const locateThrough = (end: number) => {
    if (sourceText.length > 0) {
      const start = Math.max(cursor, sourceStart)
      if (start < end) spans.push({ start: padding + start, end: padding + end })
    }
    cursor = end
  }
  for (const offset of offsets) {
    if (offset < cursor) continue
    parts.push(words.slice(cursor, offset + 1), QUOTE)
    locateThrough(offset + 1)
    padding += QUOTE.length
  }
  parts.push(words.slice(cursor))
  locateThrough(words.length)
  return { payload: parts.join(''), spans }
}

export function encodeProvenancePrefix(meta: VivaProvenanceHeader): string {
  const wire: Record<string, unknown> = {
    v: 1,
    o: meta.origin,
    sk: meta.sourceKind,
    k: meta.sessionKind,
  }
  if (meta.conversationId) wire.c = meta.conversationId
  if (meta.sourceId) wire.s = meta.sourceId
  if (meta.humanSpans !== undefined) wire.hs = meta.humanSpans.map(span => [span.start, span.end])
  const json = JSON.stringify(wire).replaceAll('】', '\\u3011')
  return `${PROVENANCE_HEAD}${json}】\n`
}

export function withProvenanceHeader(payload: string, meta: VivaProvenanceHeader): string {
  return encodeProvenancePrefix(meta) + payload
}

/** Escape lookalike provenance headers inside non-routed text (e.g. idle task report batches or unattended prompts). */
export function wrapRawWithProvenance(
  words: string,
  meta: Omit<VivaProvenanceHeader, 'humanSpans'>,
  sourceText = '',
): { text: string, payload: string, humanSpans: HumanSpan[] } {
  const { payload, spans } = escapeAndLocateSpans(words, sourceText, [PROVENANCE_HEAD])
  return {
    text: withProvenanceHeader(payload, { ...meta, humanSpans: spans }),
    payload,
    humanSpans: spans,
  }
}

export function parseProvenanceHeader(wireText: string): { provenance: VivaProvenanceHeader, payload: string } | null {
  const match = LEADING_PROVENANCE_MARK.exec(wireText)
  if (!match) return null
  const payload = wireText.slice(match[0].length)
  let raw: unknown
  try {
    raw = JSON.parse(match[1]!)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.v !== 1) return null
  if (typeof obj.o !== 'string' || !ORIGINS.has(obj.o)) return null
  if (typeof obj.sk !== 'string' || !SOURCE_KINDS.has(obj.sk)) return null
  if (typeof obj.k !== 'string' || !SESSION_KINDS.has(obj.k)) return null
  if (obj.c !== undefined && (typeof obj.c !== 'string' || obj.c.length === 0 || obj.c.length > 256)) return null
  if (obj.s !== undefined && (typeof obj.s !== 'string' || obj.s.length === 0 || obj.s.length > 256)) return null
  let humanSpans: HumanSpan[] | undefined
  if (obj.hs !== undefined) {
    const validated = validateHumanSpans(obj.hs, payload.length)
    if (!validated) return null
    humanSpans = validated
  }
  return {
    provenance: {
      origin: obj.o as DispatchOrigin,
      sourceKind: obj.sk as WireSourceKind,
      sessionKind: obj.k as SessionKind,
      ...(typeof obj.c === 'string' ? { conversationId: obj.c } : {}),
      ...(typeof obj.s === 'string' ? { sourceId: obj.s } : {}),
      ...(humanSpans !== undefined ? { humanSpans } : {}),
    },
    payload,
  }
}

export function stripLeadingProvenanceHeader(text: string): string {
  const match = LEADING_PROVENANCE_MARK.exec(text)
  return match ? text.slice(match[0].length) : text
}

export function unquoteProvenanceHeader(text: string): string {
  return text.replaceAll(PROVENANCE_QUOTED, PROVENANCE_HEAD)
}
