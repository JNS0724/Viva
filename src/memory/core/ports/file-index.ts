import type { DocumentSourceRef } from './documents.ts'

export interface MemoryFileVersion { revision: string, usageVersion: number, policyToken: string }
/** Selected by core after authorization and provenance checks; paths never confer identity. */
export interface MemoryFileIdentity extends MemoryFileVersion {
  workspace: string
  id: string
  path: string
  kind: 'daily' | 'digest'
  day?: string
  updatedAt: number
  sources: DocumentSourceRef[]
}
export interface MemoryFileChunk {
  text: string
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  headingPath: string[]
  searchText: string
}
export interface MemoryFileLink { path: string, line: number, label?: string, anchor?: string }
export interface MemoryFileSnapshot extends MemoryFileIdentity {
  name: string
  description: string
  chunks: MemoryFileChunk[]
  links: MemoryFileLink[]
}
export interface MemoryFileChunkRef extends MemoryFileVersion { workspace: string, fileId: string, ordinal: number }
export interface MemoryFilePassage extends MemoryFileChunk { ref: MemoryFileChunkRef, file: MemoryFileIdentity }
export interface MemoryFileHit extends MemoryFilePassage { score: number }
export interface MemoryVectorSpace { fingerprint: string, dimensions: number }
export interface MemoryVectorState { space: MemoryVectorSpace | null, generation: number, active: boolean }
export interface MemoryFileIndex {
  accept(snapshot: MemoryFileSnapshot, expected: MemoryFileVersion | null): boolean
  remove(identity: MemoryFileIdentity): boolean
  files(workspaces: readonly string[]): MemoryFileIdentity[]
  snapshot(workspace: string, id: string): MemoryFileSnapshot | null
  chunks(authorized: readonly MemoryFileIdentity[]): MemoryFilePassage[]
  lexical(query: string, authorized: readonly MemoryFileIdentity[], limit: number): { hits: MemoryFileHit[], mode: 'fts' | 'fallback' }
  beginVectors(space: MemoryVectorSpace): number
  vectorState(): MemoryVectorState
  missingVectors(generation: number): MemoryFilePassage[]
  stageVectors(generation: number, records: readonly { ref: MemoryFileChunkRef, vectors: readonly Float32Array[] }[]): number
  finishVectors(generation: number, expected: readonly MemoryFileChunkRef[]): boolean
  vector(query: Float32Array, space: MemoryVectorSpace, authorized: readonly MemoryFileIdentity[], limit: number): MemoryFileHit[] | null
  /** Rebuild derived indexes from accepted snapshots only. Never touches filesystem. */
  reindex(): { lexical: boolean, vectorGeneration: number }
  withdraw(sourceId: string): void
  recover(): void
  pendingCleanup(): number
}
export interface MemoryCatalogFile { path: string, revision: string, markdown: string }
export type MemoryCatalogChange =
  | { kind: 'unchanged', identity: MemoryFileIdentity, file: MemoryCatalogFile }
  | { kind: 'modified', identity: MemoryFileIdentity, file: MemoryCatalogFile }
  | { kind: 'missing', identity: MemoryFileIdentity }
  | { kind: 'added', file: MemoryCatalogFile }
  | { kind: 'rename', identity: MemoryFileIdentity, file: MemoryCatalogFile }
  | { kind: 'quarantined', path: string, reason: 'ambiguous-rename' | 'duplicate-content' | 'symlink' | 'invalid-path' | 'unreadable' }
export interface MemoryFileCatalog {
  scan(workspace: string, accepted: readonly MemoryFileIdentity[]): MemoryCatalogChange[]
}
