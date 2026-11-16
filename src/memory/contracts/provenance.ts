import type { MemoryProvenance } from './records.ts'
export type { MemoryProvenance } from './records.ts'

/** Combine carried evidence without deciding its validity; authorization remains with the owner. */
export function combineMemoryProvenance(first: MemoryProvenance | null, second: MemoryProvenance): MemoryProvenance {
  if (!first) return second
  const dependencies = new Map([...first.dependencies, ...second.dependencies].map(item => [JSON.stringify(item), item]))
  const projects = [...new Set([...first.projects ?? [], ...second.projects ?? []])]
  return { ...(projects.length ? { projects } : {}), dependencies: [...dependencies.values()], sources: [...new Set([...first.sources, ...second.sources])], turnOnly: first.turnOnly || second.turnOnly,
    epoch: Math.min(first.epoch, second.epoch) }
}
