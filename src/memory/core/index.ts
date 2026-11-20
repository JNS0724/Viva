/** Host-independent domain services and their explicit ports. */
export { createMemoryRuntime } from './memory-runtime.ts'
export type { MemoryRuntime } from './memory-runtime.ts'
export type { MemoryRuntimeResources } from './ports/runtime.ts'
export type { MemoryStore } from './ports/store.ts'
export { createMemoryService, createMemoryClient, MemoryServiceError } from './client.ts'
export { createMemoryCoordination } from './coordination.ts'
export { createMemoryDreamJobs } from './memory-dream-jobs.ts'
export type { MemoryDocuments } from './ports/documents.ts'

export { createMemoryDocumentReadPolicy } from './memory-document-read-policy.ts'
export { parseMemoryMarkdown } from './memory-markdown.ts'
export type { MemoryFileIndex } from './ports/file-index.ts'
