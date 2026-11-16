import type { MemorySource } from './store.ts'
import type { Effects } from './effects.ts'
import type { MemoryIndex } from './index.ts'
import type { MemorySemanticIndex } from './semantic.ts'
import type { MemoryProfileStore } from './profile-store.ts'
import type { MemoryNotes } from './notes.ts'
import type { MemoryCleanup } from './cleanup.ts'
import type { MemoryDocuments, DocumentReceipt, DocumentRename, DocumentExternalEdit, DocumentSnapshot, DocumentManagementGuard } from './documents.ts'
import type { MemoryFileRestrictions } from './file-restrictions.ts'
import type { MemoryFileIndex, MemoryFileCatalog } from './file-index.ts'

/** Stable identity generation and hashing are supplied by the host's platform adapter. */
export interface MemoryIdentity {
  newId(): string
  hash(text: string): string
}

/** Open resources belong to one owner. Core never sees a database connection or a filesystem root. */
export interface MemoryRuntimeResources {
  sourceToken(source: MemorySource): string
  sourceWorkspace(source: MemorySource): string
  identity: MemoryIdentity
  effects: Effects
  projectionStore: MemoryProfileStore
  lexical: MemoryIndex
  openSemantic(): MemorySemanticIndex | null
  hasFileStorage(): boolean
  openFileRestrictions(): MemoryFileRestrictions
  openFileIndex(): MemoryFileIndex
  openFileCatalog(): MemoryFileCatalog
  semanticCopiesCleared(ids: readonly number[], revision: number): boolean
  openNotes(readable: (id: string) => boolean, currentJob: (key: string, generation: number) => boolean, onRenamed?: (input: DocumentRename) => void, external?: { current(input: DocumentExternalEdit): boolean, committed(input: DocumentExternalEdit): void, noteCommitted(): void }): MemoryNotes
  openDocuments(readable: (id: string) => boolean, onCommitted: (receipt: DocumentReceipt) => void, onRenamed?: (input: DocumentRename) => void, policy?: { current(input: DocumentExternalEdit): boolean, managementCurrent(before: DocumentSnapshot, guard: DocumentManagementGuard, after: DocumentSnapshot): boolean, deferRecovery?: boolean }): MemoryDocuments
  createCleanup(callbacks: {
    clearSemantic(ids: readonly number[], revision: number): boolean
    clearProfile(revision: number): boolean
    onCleared?: () => void
  }): MemoryCleanup
}
