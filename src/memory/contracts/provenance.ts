import { z } from 'zod'
import { memoryFilePath } from './memory-file-contract.ts'
import type { MemoryProvenance } from './records.ts'
export type { MemoryProvenance } from './records.ts'

const key = z.string().min(1).max(256)
const integer = z.number().int().nonnegative()
export const memoryFileDependencySchema = z.strictObject({
  workspace: z.string().regex(/^[a-f0-9]{64}$/u), id: key, path: memoryFilePath,
  revision: key, usageVersion: integer, policyToken: key,
})
export const memoryProvenanceSchema = z.strictObject({
  dependencies: z.array(z.strictObject({ id: integer, revision: integer, asOf: z.string().optional(),
    asOfZone: z.string().optional(), disputed: z.boolean().optional(), expiresAt: z.number().optional(), collectionRevision: integer.optional() })),
  sources: z.array(key), turnOnly: z.boolean(), epoch: integer, projects: z.array(key).optional(),
  files: z.array(memoryFileDependencySchema).optional(),
})

/** Combine carried evidence without deciding its validity; authorization remains with the owner. */
export function combineMemoryProvenance(first: MemoryProvenance | null, second: MemoryProvenance): MemoryProvenance {
  if (!first) return second
  const dependencies = new Map([...first.dependencies, ...second.dependencies].map(item => [JSON.stringify(item), item]))
  const files = new Map([...first.files ?? [], ...second.files ?? []].map(item =>
    [JSON.stringify([item.workspace, item.id, item.path, item.revision, item.usageVersion, item.policyToken]), item]))
  const projects = [...new Set([...first.projects ?? [], ...second.projects ?? []])]
  return { ...(projects.length ? { projects } : {}), ...(files.size ? { files: [...files.values()] } : {}), dependencies: [...dependencies.values()], sources: [...new Set([...first.sources, ...second.sources])], turnOnly: first.turnOnly || second.turnOnly,
    epoch: Math.min(first.epoch, second.epoch) }
}
