import type { Effects } from './effects.ts'
import type { MemoryIndex } from './index.ts'
import type { MemorySemanticIndex } from './semantic.ts'
import type { MemoryProfileStore } from './profile-store.ts'
import type { MemoryNotes } from './notes.ts'
import type { MemoryCleanup } from './cleanup.ts'

/** Stable identity generation and hashing are supplied by the host's platform adapter. */
export interface MemoryIdentity {
  newId(): string
  hash(text: string): string
}

/** Open resources belong to one owner. Core never sees a database connection or a filesystem root. */
export interface MemoryRuntimeResources {
  identity: MemoryIdentity
  effects: Effects
  projectionStore: MemoryProfileStore
  lexical: MemoryIndex
  openSemantic(): MemorySemanticIndex | null
  semanticCopiesCleared(ids: readonly number[], revision: number): boolean
  openNotes(readable: (id: string) => boolean, currentJob: (key: string, generation: number) => boolean): MemoryNotes
  createCleanup(callbacks: {
    clearSemantic(ids: readonly number[], revision: number): boolean
    clearProfile(revision: number): boolean
    onCleared?: () => void
  }): MemoryCleanup
}
