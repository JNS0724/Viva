/** Browser-safe service protocol. No host identity is accepted from an untrusted payload. */
export * from './service.ts'
export * from './memory-file-contract.ts'
export * from './embedding.ts'
export type { MemoryScope, MemorySpan, MemoryCompute } from './memory-contract.ts'

// Host schemas are public contracts, not authorization: only a trusted adapter may invoke them.
export * from './host.ts'
export * from './domain-error.ts'
export type * from './records.ts'
export { combineMemoryProvenance, memoryFileDependencySchema, memoryProvenanceSchema } from './provenance.ts'
export * from './text-limits.ts'
export type { MemoryComputeTools } from './compute.ts'

export * from './context-recovery.ts'
export * from './file-management.ts'
