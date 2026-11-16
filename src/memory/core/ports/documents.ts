import type { DigestAction, DreamUnit } from '../../contracts/memory-file-contract.ts'

/** Opaque canonical source versions, issued by the Node adapter, never by a model. */
export interface DocumentSourceRef { id: string, token: string, spans?: Array<{ start: number, end: number }> }
export interface DocumentReadRef { id: string, revision: string, usageVersion: number }
/** Exact old fragment and applicability supplied by semantic verification, then checked against the read snapshot. */
export interface DocumentCorrection {
  path: string
  revision: string
  startLine: number
  endLine: number
  text: string
  condition: string
  time: string
}
export interface DocumentSupersession extends DocumentCorrection {
  sourceDocumentId: string
  documentId: string
  replacementRevision: string
  operationId: string
}
export interface DocumentSnapshot extends DocumentReadRef {
  workspace: string
  path: string
  markdown: string
  sources: DocumentSourceRef[]
  enabled: boolean
  corrections: DocumentSupersession[]
}
export interface DocumentCommit {
  operationId: string
  workspace: string
  path: string
  expectedRevision: string | null
  markdown: string
  action: DigestAction | 'TAG'
  sources: DocumentSourceRef[]
  reads: DocumentReadRef[]
  corrections?: DocumentCorrection[]
  files?: Array<{ path: string, revision: string }>
}
export interface DocumentReceipt {
  operationId: string
  documentId: string
  path: string
  revision: string | null
  usageVersion: number
  action: DigestAction | 'TAG' | 'UNDO' | 'ENABLE' | 'DISABLE' | 'FORGET'
}
export interface DeferredDocumentWork {
  operationId: string
  workspace: string
  unit: DreamUnit
  reason: string
  sources: DocumentSourceRef[]
  reads: DocumentReadRef[]
  /** Daily versions are part of the readset even though they are not digest identities. */
  files: Array<{ path: string, revision: string }>
  status: 'pending_clarification' | 'ready' | 'resolved' | 'expired'
  answer?: { operationId: string, source: DocumentSourceRef, text: string }
}
export interface DocumentTagAttempt { workspace: string, operationId: string, path: string, revision: string, state: 'attempted' | 'failed' | 'completed', reason?: string }
export interface MemoryDocuments {
  recordTagAttempt(input: DocumentTagAttempt): void
  tagAttempt(workspace: string, operationId: string): DocumentTagAttempt | null
  sourceRestrictions(workspace: string): DocumentSourceRef[]
  recover(): void
  receipt(workspace: string, operationId: string): DocumentReceipt | null
  hasPendingCleanup(sourceId: string): boolean
  pendingCleanup(): number
  read(workspace: string, path: string, options?: { includeDisabled?: boolean }): DocumentSnapshot | null
  list(workspace: string, options?: { includeDisabled?: boolean }): DocumentSnapshot[]
  commit(input: DocumentCommit): DocumentReceipt
  undo(input: { operationId: string, workspace: string, documentId: string, revision: string, usageVersion: number }): DocumentReceipt
  setEnabled(input: { operationId: string, workspace: string, documentId: string, expectedRevision: string, expectedUsageVersion: number, enabled: boolean }): DocumentReceipt
  /** Caller excludes the canonical source before invoking physical cleanup. */
  withdraw(sourceId: string): string[]
  supersessions(workspace: string, path: string): DocumentSupersession[]
  defer(input: Omit<DeferredDocumentWork, 'status' | 'answer'>, previousOperationId?: string): DeferredDocumentWork
  deferred(workspace: string, operationId: string): DeferredDocumentWork | null
  pending(workspace: string): DeferredDocumentWork[]
  answer(input: { operationId: string, workspace: string, deferredId: string, source: DocumentSourceRef, text: string }): DeferredDocumentWork
  resolve(workspace: string, operationId: string): void
}
