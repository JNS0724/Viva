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
  threadId?: string
  hostDay?: string
  humanSpans?: HumanSpan[]
}

export type SteerMessageSource =
  | { kind: 'viva-main-human-steer', sourceId?: string, conversationId?: string, threadId?: string, humanSpans?: HumanSpan[] }
  | { kind: 'viva-task-human-steer', sourceId?: string, conversationId?: string, threadId?: string, hostDay?: string, humanSpans?: HumanSpan[] }
  | { kind: 'viva-task-router-message', conversationId?: string, threadId?: string, hostDay?: string }

export type VivaLiftedNonHumanKind = 'viva-report-batch' | 'viva-unattended' | 'viva-task-brief'

export type VivaLiftedMessageSource =
  | ({ kind: 'user', vivaProvenance: VivaProvenanceHeader } & Readonly<Record<string, unknown>>)
  | { kind: VivaLiftedNonHumanKind, vivaProvenance: VivaProvenanceHeader }

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

const INVALID_ID_CHAR = /[\u0000-\u0020\u007F-\u009F\uD800-\uDFFF]/u

export function isValidOptionalId(value: unknown, maxChars = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars && !INVALID_ID_CHAR.test(value)
}

export function formatHostDay(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(at)
  }
}

export function isValidHostDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

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
  if (isValidOptionalId(meta.threadId)) wire.t = meta.threadId
  if (isValidHostDay(meta.hostDay)) wire.hd = meta.hostDay
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
  const threadId = isValidOptionalId(obj.t) ? obj.t : undefined
  const hostDay = isValidHostDay(obj.hd) ? obj.hd : undefined
  return {
    provenance: {
      origin: obj.o as DispatchOrigin,
      sourceKind: obj.sk as WireSourceKind,
      sessionKind: obj.k as SessionKind,
      ...(typeof obj.c === 'string' ? { conversationId: obj.c } : {}),
      ...(typeof obj.s === 'string' ? { sourceId: obj.s } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(hostDay !== undefined ? { hostDay } : {}),
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

/**
 * Validate a structured `vivaProvenance` object carried on `UserMessage.source`
 * (including after a V4 JSONL disk round-trip) against `payloadLength`.
 */
export function validateVivaProvenance(raw: unknown, payloadLength: number): VivaProvenanceHeader | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.origin !== 'string' || !ORIGINS.has(obj.origin)) return null
  if (typeof obj.sourceKind !== 'string' || !SOURCE_KINDS.has(obj.sourceKind)) return null
  if (typeof obj.sessionKind !== 'string' || !SESSION_KINDS.has(obj.sessionKind)) return null
  if (obj.conversationId !== undefined && (typeof obj.conversationId !== 'string' || obj.conversationId.length === 0 || obj.conversationId.length > 256)) return null
  if (obj.sourceId !== undefined && (typeof obj.sourceId !== 'string' || obj.sourceId.length === 0 || obj.sourceId.length > 256)) return null
  let humanSpans: HumanSpan[] | undefined
  if (obj.humanSpans !== undefined) {
    const validated = validateHumanSpans(obj.humanSpans, payloadLength)
    if (!validated) return null
    humanSpans = validated
  }
  const threadId = isValidOptionalId(obj.threadId) ? obj.threadId : undefined
  const hostDay = isValidHostDay(obj.hostDay) ? obj.hostDay : undefined
  return {
    origin: obj.origin as DispatchOrigin,
    sourceKind: obj.sourceKind as WireSourceKind,
    sessionKind: obj.sessionKind as SessionKind,
    ...(typeof obj.conversationId === 'string' ? { conversationId: obj.conversationId } : {}),
    ...(typeof obj.sourceId === 'string' ? { sourceId: obj.sourceId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(hostDay !== undefined ? { hostDay } : {}),
    ...(humanSpans !== undefined ? { humanSpans } : {}),
  }
}

/** Read and validate `source.vivaProvenance` when present on a lifted `UserMessage.source`. */
export function readLiftedProvenance(source: unknown, payloadLength: number): VivaProvenanceHeader | null {
  if (!source || typeof source !== 'object' || !('vivaProvenance' in source)) return null
  return validateVivaProvenance((source as { vivaProvenance?: unknown }).vivaProvenance, payloadLength)
}

/**
 * Map parsed transport provenance to the committed `UserMessage.source`:
 * - Human ACP prompts keep `kind: 'user'` with `vivaProvenance` (preserving existing fields such as `rpcId`)
 *   so built-in `dsh-base` consumers filtering `source.kind === 'user'` keep working.
 * - Non-human ACP prompts lift to dedicated non-`'user'` kinds (`viva-report-batch`, `viva-unattended`, `viva-task-brief`).
 */
export function liftedSourceOf(
  provenance: VivaProvenanceHeader,
  existingSource?: Readonly<Record<string, unknown>>,
): VivaLiftedMessageSource {
  if (provenance.origin === 'human') {
    return { ...(existingSource ?? {}), kind: 'user', vivaProvenance: provenance }
  }
  if (provenance.sourceKind === 'viva-report-batch' || provenance.sourceKind === 'viva-report') {
    return { kind: 'viva-report-batch', vivaProvenance: provenance }
  }
  if (provenance.origin === 'unattended' || provenance.sourceKind === 'unattended' || provenance.sessionKind === 'unattended') {
    return { kind: 'viva-unattended', vivaProvenance: provenance }
  }
  return { kind: 'viva-task-brief', vivaProvenance: provenance }
}

/**
 * Pure, strictly idempotent transport-unwrapping core for `agent/pre-step` `liftProvenance`:
 * - Guards on `source.kind === 'user'` and `!('vivaProvenance' in source)` so repeated calls
 *   never strip a user-typed lookalike `【Viva 元数据：...】` line.
 * - Strips the leading `【Viva 元数据：...】\n` transport prefix from the first text block,
 *   removing that text block when emptied on image-only prompts (no other text blocks).
 * - Returns `null` when no lifting is needed.
 */
export function liftProvenanceDraft<T extends { readonly type: string, readonly text?: string }>(
  content: readonly T[],
  source: Readonly<Record<string, unknown>>,
): { content: T[], source: VivaLiftedMessageSource } | null {
  if (source.kind !== 'user' || 'vivaProvenance' in source) return null
  const firstTextIdx = content.findIndex(block => block.type === 'text' && typeof block.text === 'string')
  if (firstTextIdx < 0) return null
  const firstBlock = content[firstTextIdx]!
  const firstText = firstBlock.text!
  const match = LEADING_PROVENANCE_MARK.exec(firstText)
  if (!match) return null
  const fullWireText = content
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n')
  const parsed = parseProvenanceHeader(fullWireText)
  if (!parsed) return null
  const strippedFirstText = firstText.slice(match[0].length)
  const hasOtherTextBlock = content.some((block, idx) => idx !== firstTextIdx && block.type === 'text' && typeof block.text === 'string')
  const nextContent: T[] = []
  for (let i = 0; i < content.length; i++) {
    if (i === firstTextIdx) {
      if (strippedFirstText.length === 0 && !hasOtherTextBlock && content.length > 1) {
        continue
      }
      nextContent.push({ ...firstBlock, text: strippedFirstText })
    } else {
      nextContent.push(content[i]!)
    }
  }
  return {
    content: nextContent,
    source: liftedSourceOf(parsed.provenance, source),
  }
}
