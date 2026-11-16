import type { MemorySource } from '../contracts/records.ts'
import type { DocumentSourceRef } from './ports/documents.ts'

type Span = { start: number, end: number }
const valid = (span: Span) => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end

function orderedSpans(spans: readonly Span[]): Span[] {
  const result: Span[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1)
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end)
    else result.push({ ...span })
  }
  return result
}

/** Exact available evidence after subtracting disabled fragments. Used to rebuild a mixed
 * daily from still-authorized originals without granting the full original source anew. */
export function availableDocumentSourceSpans(text: string, source: DocumentSourceRef, restrictions: readonly DocumentSourceRef[]): Span[] {
  return subtractDocumentSourceSpans(text.length, source, restrictions)
}

export function subtractDocumentSourceSpans(length: number, source: DocumentSourceRef, restrictions: readonly DocumentSourceRef[]): Span[] {
  if (source.spans && (!source.spans.length || source.spans.some(span => !valid(span) || span.end > length))) {
    throw new Error('invalid-document-source-spans')
  }
  let result = orderedSpans(source.spans ?? (length ? [{ start: 0, end: length }] : []))
  for (const restriction of restrictions) {
    if (restriction.id !== source.id || restriction.token !== source.token) continue
    if (!restriction.spans) return []
    if (!restriction.spans.length || restriction.spans.some(span => !valid(span) || span.end > length)) {
      throw new Error('invalid-document-restriction-spans')
    }
    for (const blocked of restriction.spans) result = result.flatMap(span => {
      if (!overlaps(span, blocked)) return [span]
      return [
        ...(span.start < blocked.start ? [{ start: span.start, end: blocked.start }] : []),
        ...(span.end > blocked.end ? [{ start: blocked.end, end: span.end }] : []),
      ]
    })
  }
  return result
}

/** Restrictions bind canonical identity/version, never text similarity or a predicate category.
 * A new independent input, or a disjoint verified fragment, does not inherit this restriction. */
export function documentSourceRestricted(source: DocumentSourceRef, restrictions: readonly DocumentSourceRef[]): boolean {
  if (source.spans && (!source.spans.length || !source.spans.every(valid))) throw new Error('invalid-document-source-spans')
  return restrictions.some(restriction => {
    if (restriction.id !== source.id || restriction.token !== source.token) return false
    if (restriction.spans && (!restriction.spans.length || !restriction.spans.every(valid))) throw new Error('invalid-document-restriction-spans')
    return !source.spans || !restriction.spans || source.spans.some(span => restriction.spans!.some(blocked => overlaps(span, blocked)))
  })
}

export function erasedDocumentSource(source: Pick<MemorySource, 'id' | 'erasure'>): DocumentSourceRef | undefined {
  return source.erasure && { id: source.id, ...source.erasure }
}

/** A stable token proves coordinates inherited from the original source. After a
 * partial erasure only explicit, disjoint ranges of that token can prove content. */
export function documentSourceProofCurrent(ref: DocumentSourceRef, text: string, token: string, erasure?: DocumentSourceRef): boolean {
  return ref.token === token && (!ref.spans || ref.spans.length > 0 && ref.spans.every(span => valid(span) && span.end <= text.length))
    && (!erasure || !documentSourceRestricted(ref, [erasure]))
}

export function planDocumentSourceErasure(source: Pick<MemorySource, 'id' | 'text' | 'erasure'>, token: string, target: DocumentSourceRef) {
  if (source.id !== target.id || !source.text || !documentSourceProofCurrent(target, source.text, token, erasedDocumentSource(source))) return null
  const text = source.text
  const selected = target.spans ?? [{ start: 0, end: text.length }]
  // The persisted offsets are UTF-16. Do not create an isolated half of a
  // surrogate pair when removing source fragments.
  const splitsCharacter = (offset: number) => text.charCodeAt(offset - 1) >= 0xD800 && text.charCodeAt(offset - 1) <= 0xDBFF
    && text.charCodeAt(offset) >= 0xDC00 && text.charCodeAt(offset) <= 0xDFFF
  if (selected.some(({ start, end }) => splitsCharacter(start) || splitsCharacter(end))) return null
  const spans = orderedSpans([...(source.erasure?.spans ?? []), ...selected])
  return { text: projectDocumentSource(text, target, [target]), erasure: { token, spans } }
}

/** Produce a model-visible canonical source view without renumbering its UTF-16 offsets.
 * This masks every restricted fragment, including outside source.spans: the caller may
 * provide surrounding context but must never smuggle a disabled neighboring fragment.
 * Persist the original source and verify proposed evidence against both the original
 * and documentSourceRestricted; this projection is not a new independent source. */
export function projectDocumentSource(text: string, source: DocumentSourceRef, restrictions: readonly DocumentSourceRef[]): string {
  const spans: Span[] = []
  for (const restriction of restrictions) {
    if (restriction.id !== source.id || restriction.token !== source.token) continue
    if (!restriction.spans) return text.replace(/[^\r\n]/g, ' ')
    if (!restriction.spans.length || restriction.spans.some(span => !valid(span) || span.end > text.length)) {
      throw new Error('invalid-document-restriction-spans')
    }
    spans.push(...restriction.spans)
  }
  const merged = orderedSpans(spans)
  let projected = '', offset = 0
  for (const span of merged) {
    projected += text.slice(offset, span.start) + text.slice(span.start, span.end).replace(/[^\r\n]/g, ' ')
    offset = span.end
  }
  return projected + text.slice(offset)
}
