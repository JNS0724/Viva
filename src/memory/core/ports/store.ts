// Domain storage port. Implementations live in memory/node.
import type { DocumentSourceRef } from './documents.ts'
import type { MemorySource } from '../../contracts/records.ts'
export type { MemoryFileDependency, MemorySource } from '../../contracts/records.ts'

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
  outcome(id: string, state: string): void
  meta(key: string): string | undefined
  setMeta(key: string, value: string): void
  profile(): ProfileValues
  setProfile(fields: Record<string, string>): ProfileValues
  command(key: string): { kind: string, payload: string, result: number | null } | undefined
  recordCommand(key: string, kind: string, payload: string, result: number | null): void
  close(): void
}
