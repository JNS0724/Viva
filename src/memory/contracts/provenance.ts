import { z } from 'zod'
import { memoryFilePath } from './memory-file-contract.ts'
import type { MemoryProvenance } from './records.ts'
import type { TextSpan } from './text-spans.ts'
export type { MemoryProvenance } from './records.ts'

const key = z.string().min(1).max(256)
const integer = z.number().int().nonnegative()
const ranges = z.strictObject({ sourceId: key, spans: z.array(z.strictObject({ start: integer, end: integer })
  .refine(span => span.start < span.end)).min(1).optional() })
export const memoryErasureEvidenceSchema = z.strictObject({
  sources: z.array(key), fileRanges: z.array(ranges), memoryIds: z.array(integer),
})
type MemoryErasureEvidence = z.output<typeof memoryErasureEvidenceSchema>
export const memoryFileDependencySchema = z.strictObject({
  workspace: z.string().regex(/^[a-f0-9]{64}$/u), id: key, path: memoryFilePath,
  revision: key, usageVersion: integer, policyToken: key,
  sourceRanges: z.array(ranges).optional(),
})
export const memoryProvenanceSchema = z.strictObject({
  dependencies: z.array(z.strictObject({ id: integer, revision: integer, asOf: z.string().optional(),
    asOfZone: z.string().optional(), disputed: z.boolean().optional(), expiresAt: z.number().optional(), collectionRevision: integer.optional() })),
  sources: z.array(key), turnOnly: z.boolean(), epoch: integer, projects: z.array(key).optional(),
  files: z.array(memoryFileDependencySchema).optional(), fileSources: z.array(key).optional(),
}).refine(value => !value.fileSources?.length || Boolean(value.files?.length) && value.fileSources.every(id => value.sources.includes(id)),
  { message: 'File sources require file read dependencies and must be included in sources' })

export function rawMemorySources(evidence: Pick<MemoryProvenance, 'sources' | 'fileSources'>): string[] {
  if (!evidence.fileSources?.length) return evidence.sources
  const bound = new Set(evidence.fileSources)
  return evidence.sources.filter(id => !bound.has(id))
}

/** Keep only the identities and source coordinates a future erasure needs. */
export function memoryErasureEvidence(evidence: MemoryProvenance): MemoryErasureEvidence {
  return { sources: rawMemorySources(evidence), fileRanges: evidence.files?.flatMap(file => file.sourceRanges ?? []) ?? [],
    memoryIds: evidence.dependencies.map(ref => ref.id) }
}

export function intersectsMemoryErasure(evidence: MemoryErasureEvidence, ranges: readonly { sourceId: string; spans: readonly TextSpan[] }[],
  memoryIds: readonly number[] = []): boolean {
  if (evidence.memoryIds.some(id => memoryIds.includes(id))) return true
  return ranges.some(range => evidence.sources.includes(range.sourceId)
    || evidence.fileRanges.some(ref => ref.sourceId === range.sourceId
      && (!ref.spans || ref.spans.some(span => range.spans.some(cut => span.start < cut.end && cut.start < span.end)))))
}

/** A historical snapshot intersects only the erased sources or verified file ranges it actually used. */
export function usesErasedMemory(evidence: MemoryProvenance, ranges: Parameters<typeof intersectsMemoryErasure>[1],
  memoryIds: readonly number[] = []): boolean {
  return intersectsMemoryErasure(memoryErasureEvidence(evidence), ranges, memoryIds)
}

/** Combine carried evidence without deciding its validity; authorization remains with the owner. */
export function combineMemoryProvenance(first: MemoryProvenance | null, second: MemoryProvenance): MemoryProvenance {
  if (!first) return second
  const dependencies = new Map([...first.dependencies, ...second.dependencies].map(item => [JSON.stringify(item), item]))
  const files = new Map([...first.files ?? [], ...second.files ?? []].map(item =>
    [JSON.stringify([item.workspace, item.id, item.path, item.revision, item.usageVersion, item.policyToken]), item]))
  const projects = [...new Set([...first.projects ?? [], ...second.projects ?? []])]
  const raw = new Set([...rawMemorySources(first), ...rawMemorySources(second)])
  const fileSources = [...new Set([...first.fileSources ?? [], ...second.fileSources ?? []])].filter(id => !raw.has(id))
  return { ...(fileSources.length ? { fileSources } : {}), ...(projects.length ? { projects } : {}), ...(files.size ? { files: [...files.values()] } : {}), dependencies: [...dependencies.values()], sources: [...new Set([...first.sources, ...second.sources])], turnOnly: first.turnOnly || second.turnOnly,
    epoch: Math.min(first.epoch, second.epoch) }
}
