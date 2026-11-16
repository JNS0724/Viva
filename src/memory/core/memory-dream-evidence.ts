import { z } from 'zod'
import type { DigestAction } from '../contracts/memory-file-contract.ts'
import type { MemorySource } from './ports/store.ts'
import type { DocumentCorrection, DocumentSourceRef } from './ports/documents.ts'
import { memoryDocumentLines, readMemoryLines } from './memory-document.ts'

const evidenceSpan = z.strictObject({
  sourceId: z.string().min(1), sourceVersion: z.int().positive(),
  start: z.int().nonnegative(), end: z.int().positive(), text: z.string().min(1), claim: z.string().trim().min(1),
}).refine(value => value.end > value.start)
const correction = z.strictObject({
  path: z.string().min(1), revision: z.string().min(1), startLine: z.int().positive(), endLine: z.int().positive(),
  text: z.string().min(1), condition: z.string().min(1), time: z.string().min(1),
}).refine(value => value.endLine >= value.startLine)
export const dreamReviewSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ verdict: z.enum(['deferred', 'rejected']), reason: z.string().trim().min(1) }),
  z.strictObject({
    verdict: z.literal('verified'), action: z.enum(['CREATE', 'CORROBORATE', 'REFINE', 'CORRECT']),
    classification: z.enum(['same_abstraction', 'related', 'unrelated']),
    checks: z.strictObject({ attribution: z.literal(true), polarity: z.literal(true), time: z.literal(true),
      conditions: z.literal(true), meaning: z.literal(true), sources: z.literal(true), action: z.literal(true) }),
    evidence: z.array(evidenceSpan).min(1), changeEvidence: z.array(evidenceSpan), corrections: z.array(correction),
  }),
])

/** Exact provenance checks supplement (and never pretend to be) the independent semantic model review. */
export function validateDreamReview({ value, action, sources, source, reads, unitSources, restricted = () => false }: {
  value: unknown, action: DigestAction, sources: readonly DocumentSourceRef[], source: (id: string) => MemorySource | undefined,
  reads: readonly { path: string, revision: string, markdown: string }[], unitSources: readonly (readonly string[])[],
  restricted?: (ref: DocumentSourceRef) => boolean,
}): { verdict: 'verified', sources: DocumentSourceRef[], corrections: DocumentCorrection[] }
  | { verdict: 'deferred', reason: string } | { verdict: 'rejected', reason: string } {
  const review = dreamReviewSchema.parse(value)
  if (review.verdict === 'deferred') return { verdict: 'deferred', reason: review.reason }
  if (review.verdict === 'rejected') return { verdict: 'rejected', reason: review.reason }
  if (review.verdict !== 'verified') throw new Error('memory-dream-review-verdict')
  if (review.action !== action) throw new Error('memory-dream-review-action')
  if ((action === 'CREATE') === (review.classification === 'same_abstraction')) {
    return { verdict: 'deferred', reason: 'The proposed update does not establish the same abstraction.' }
  }
  if (action === 'CORRECT' ? !review.changeEvidence.length || !review.corrections.length : review.corrections.length > 0 || review.changeEvidence.length > 0) {
    throw new Error('memory-dream-correction-evidence')
  }
  const verified = new Map<string, DocumentSourceRef>()
  for (const span of [...review.evidence, ...review.changeEvidence]) {
    const ref = sources.find(item => item.id === span.sourceId)
    const original = ref && source(ref.id)
    if (!ref || !original?.text || original.version !== span.sourceVersion || original.withdrawn
      || original.text.slice(span.start, span.end) !== span.text || span.end > original.text.length) {
      throw new Error('memory-dream-evidence-span')
    }
    if (ref.spans && !ref.spans.some(allowed => allowed.start <= span.start && allowed.end >= span.end)) {
      throw new Error('memory-dream-evidence-outside-read')
    }
    const previous = verified.get(ref.id)
    const spans = [...previous?.spans ?? [], { start: span.start, end: span.end }]
      .sort((a, b) => a.start - b.start || a.end - b.end)
    const merged: Array<{ start: number, end: number }> = []
    for (const next of spans) {
      const last = merged.at(-1)
      if (last && next.start <= last.end) last.end = Math.max(last.end, next.end)
      else merged.push({ ...next })
    }
    verified.set(ref.id, { ...ref, spans: merged })
  }
  if ([...verified.values()].some(restricted)) throw new Error('memory-dream-evidence-restricted')
  if (unitSources.some(ids => !ids.some(id => verified.has(id)))) throw new Error('memory-dream-unit-evidence-missing')
  for (const fragment of review.corrections) {
    const previous = reads.find(item => item.path === fragment.path && item.revision === fragment.revision)
    if (!previous || readMemoryLines(previous.markdown, fragment.startLine, fragment.endLine) !== fragment.text
      || fragment.endLine > memoryDocumentLines(previous.markdown).length) throw new Error('memory-dream-correction-fragment')
  }
  return { verdict: 'verified', sources: [...verified.values()], corrections: review.corrections }
}
