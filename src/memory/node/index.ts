/** Default Node adapters. Resource locations are supplied by the embedding host. */
export { createMemoryRuntime } from './runtime.ts'
export type { NodeMemoryRuntimeOptions } from './runtime.ts'
export { openMemoryStore } from './memory-store.ts'
export { openMemoryFileStore } from './memory-file-store.ts'
export { openMemoryFileJournal } from './memory-file-journal.ts'
export { openMemoryDocuments } from './memory-document-store.ts'
export { createMemoryEmbedder } from './memory-embedder.ts'

export { openMemoryOwner } from './owner.ts'

export { memoryProjectScope } from './project-scope.ts'

export { openMemoryFileIndex } from './memory-file-index.ts'
export { openMemoryFileCatalog } from './memory-file-catalog.ts'
