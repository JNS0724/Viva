/** Host-independent domain services and their explicit ports. */
export { createMemoryRuntime } from './memory-runtime.ts'
export type { MemoryRuntime } from './memory-runtime.ts'
export type { MemoryRuntimeResources } from './ports/runtime.ts'
export type { MemoryStore } from './ports/store.ts'
export { createMemoryService, createMemoryClient, MemoryServiceError } from './client.ts'
export { createMemoryCoordination } from './coordination.ts'
