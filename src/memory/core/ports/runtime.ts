import type { MemorySource } from './store.ts'
import type { Effects } from './effects.ts'
import type { MemoryNotes } from './notes.ts'
import type { MemoryDocuments, DocumentReceipt, DocumentSnapshot, DocumentManagementGuard, ReadMemoryPhysicalFile } from './documents.ts'
import type { MemoryFileIndex } from './file-index.ts'

/** Stable identity generation and hashing are supplied by the host's platform adapter. */
export interface MemoryIdentity {
  newId(): string
  hash(text: string): string
}

/** The authoritative commit queues affected identities. Publication may run once it is durable. */
export interface MemoryFileIndexChanges {
  queue(input: { workspace: string, id: string }): void
  publish(workspace: string, id: string): void
}

/** Open resources belong to one owner. Core never sees a database connection or a filesystem root. */
export interface MemoryRuntimeResources {
  sourceToken(source: MemorySource): string
  sourceWorkspace(source: MemorySource): string
  identity: MemoryIdentity
  effects: Effects
  openFileIndex(onCleanupPending: () => void): MemoryFileIndex
  readFileRevisionAtCommit(workspace: string, path: string): string | undefined
  readPhysicalFile?: ReadMemoryPhysicalFile
  openNotes(readable: (id: string) => boolean, currentJob: (key: string, generation: number) => boolean, options?: { onCommitted(): void, index?: MemoryFileIndexChanges, deferRecovery?: boolean }): MemoryNotes
  openDocuments(readable: (id: string) => boolean, onCommitted: (receipt: DocumentReceipt) => void, policy?: { managementCurrent(before: DocumentSnapshot, guard: DocumentManagementGuard, after: DocumentSnapshot, staged?: MemorySource): boolean,
    manualCurrent?(source: MemorySource, beforeMarkdown?: string): boolean, index?: MemoryFileIndexChanges, deferRecovery?: boolean }): MemoryDocuments
}
