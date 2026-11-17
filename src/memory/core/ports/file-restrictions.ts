import type { MemoryFileMutationResult } from '../../contracts/file-management.ts'
import type { MemorySourceReference } from '../../contracts/service.ts'
import type { DocumentSourceCut, DocumentSourceRef } from './documents.ts'

export interface FileUseTarget {
  kind: 'daily' | 'digest'
  workspace: string
  /** Storage identity. Daily keys are never exposed to a caller. */
  key: string
}

export interface FileUseRestriction extends FileUseTarget {
  id: string
  contentRevision: string
  usageVersion: number
  sources: DocumentSourceRef[]
}

/** Retained use restrictions own evidence ranges, independently of the current file body. */
export interface FileUseReceipt {
  fingerprint: string
  result: MemoryFileMutationResult
  sources: MemorySourceReference[]
}

export interface MemoryFileRestrictions {
  forTarget(target: FileUseTarget): FileUseRestriction[]
  sources(workspace: string, except?: FileUseTarget): DocumentSourceRef[]
  add(restriction: FileUseRestriction, snapshot?: string): void
  snapshot(target: FileUseTarget, id: string): string | null
  release(target: FileUseTarget, id: string): boolean
  removeTarget(target: FileUseTarget): void
  withdrawSource(sourceId: string): void
  eraseSource(cut: DocumentSourceCut): void
  receipt(operationId: string): FileUseReceipt | null
  complete(operationId: string, receipt: FileUseReceipt): void
}
