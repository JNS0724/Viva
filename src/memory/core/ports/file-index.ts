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
export interface MemoryFileSnapshot extends MemoryFileIdentity {
  name: string
  description: string
  chunks: MemoryFileChunk[]
}
export interface MemoryFileChunkRef extends MemoryFileVersion { workspace: string, fileId: string, ordinal: number }
export interface MemoryFilePassage extends MemoryFileChunk { ref: MemoryFileChunkRef, file: MemoryFileIdentity }
export interface MemoryFileHit extends MemoryFilePassage { score: number }
export interface MemoryVectorSpace { fingerprint: string, dimensions: number }
export interface MemoryVectorState { space: MemoryVectorSpace | null, generation: number, active: boolean }
export interface MemoryFileQueryScope {
  workspaces: readonly string[]
  from?: string
  through?: string
  asOf?: number
  kind?: 'daily' | 'digest'
  dedupeByFile?: boolean
}
export interface MemoryFilePage<T> { rows: T[], incomplete: boolean }
export interface MemoryFileNode extends MemoryFileIdentity {
  name: string
  description: string
}
export interface MemoryFileIndex {
  accept(snapshot: MemoryFileSnapshot, expected: MemoryFileVersion | null): boolean
  remove(identity: MemoryFileIdentity): boolean
  files(workspaces: readonly string[]): MemoryFileIdentity[]
  snapshot(workspace: string, id: string): MemoryFileNode | null
  chunks(authorized: readonly MemoryFileIdentity[]): MemoryFilePassage[]
  /** Candidate pages contain trusted projections. Current access and revision are checked by core. */
  lexicalCandidates(query: string, scope: MemoryFileQueryScope, limit: number, offset?: number): MemoryFilePage<MemoryFileHit> & { mode: 'fts' | 'fallback' }
  nodeCandidates(query: string, scope: MemoryFileQueryScope, limit: number, offset?: number): MemoryFilePage<MemoryFileNode> & { mode?: 'fts' | 'fallback' }
  vectorCandidates(query: Float32Array, space: MemoryVectorSpace, scope: MemoryFileQueryScope, limit: number, current?: () => boolean, deadline?: number): Promise<MemoryFilePage<MemoryFileHit> | null>
  digestNodes(workspace: string): MemoryFileNode[]
  nodeAt(workspace: string, path: string): MemoryFileNode | null
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
