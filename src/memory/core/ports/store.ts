// Domain storage port. Implementations live in memory/node.
import type { DocumentSourceRef, DocumentSourceCut } from './documents.ts'
import type { MemorySourceErasure, MemoryFileDependency, MemoryProvenance, MemorySource } from '../../contracts/records.ts'
export type { MemoryFileDependency, MemoryProvenance, MemorySource } from '../../contracts/records.ts'

type ProfileValues = Record<string, { value: string, updatedAt: number, revision: number, source: string }>

export interface MemoryStore {
  tx<T>(work: () => T): T
  revision(): number
  epoch(): number
  nextRevision(invalidate?: boolean): number
  readSource(id: string): MemorySource | null
  insertSource(source: MemorySource): void
  /** Body-free ties from a manually edited draft to the exact proof it reused. */
  insertManualFileSource(source: MemorySource, parents: readonly DocumentSourceRef[]): void
  manualFileParents(source: string): DocumentSourceRef[]
  manualFileCopies(parent: string): Array<{ source: string, reference: DocumentSourceRef }>
  manualFileSources(): MemorySource[]
  trimManualFileParents(cuts: readonly DocumentSourceCut[]): void
  outcome(id: string, state: string): void
  withdrawSource(id: string): void
  eraseFileSource(target: DocumentSourceRef, version: number): MemorySourceErasure | null
  fileErasures(workspace: string): DocumentSourceRef[]
  sourceExcluded(id: string): boolean
  excludeSource(id: string): void
  sourceIds(conversation: string): string[]
  answerSourceIds(conversation: string, request: string): string[]
  deliveredSourceIds(conversation: string): string[]
  deliveredSource(id: string): { conversation: string, derived: number } | undefined
  recordDeliveredSource(id: string, conversation: string, derived: boolean): void
  dispatch: {
    /** Only after a durable host context replacement, under the owner send fence. */
    replace(session: string, sources: readonly string[]): void
    files(session: string, files: readonly MemoryFileDependency[], sources?: readonly string[]): void
    source(session: string, source: string): void
    turnOnly(session: string): void
    offerFileClarification(session: string, work: string): void
    settleFileClarification(session: string, work: string): void
    snapshot(session: string): MemoryProvenance
  }
  sessionEpoch(id: string): number
  recordSession(id: string): void
  sessionProject(id: string): string | undefined
  recordSessionProject(id: string, project: string): void
  meta(key: string): string | undefined
  setMeta(key: string, value: string): void
  profile(): ProfileValues
  setProfile(fields: Record<string, string>): ProfileValues
  command(key: string): { kind: string, payload: string, result: number | null } | undefined
  recordCommand(key: string, kind: string, payload: string, result: number | null): void
  close(): void
}
