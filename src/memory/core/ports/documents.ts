import type { MemorySource } from '../../contracts/records.ts'
import type { DigestAction, DreamUnit } from '../../contracts/memory-file-contract.ts'

/** Opaque canonical source versions, issued by the Node adapter, never by a model. */
export interface DocumentSourceRef { id: string, token: string, spans?: Array<{ start: number, end: number }> }
export interface DocumentSourceCut extends DocumentSourceRef {
  spans: NonNullable<DocumentSourceRef['spans']>
  /** Canonical UTF-16 length and version before the erasure. */
  length: number
  version: number
  hash: string
}
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
  /** Storage-issued provenance of the old quotation, separate from the replacement's sources. */
  anchorSources?: DocumentSourceRef[]
  /** Body-free exclusion after erasing a quotation; applies only where its source still contributes. */
  erasedAnchorSources?: DocumentSourceRef[]
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
/** Latest reversible semantic edit; excludes private historical Markdown. */
export interface DocumentUndoCandidate { changeId: string, revision: string, usageVersion: number }
/** Policy validation for a prepared management operation, including journal recovery. */
export type DocumentManagementGuard = { policyToken: string, changeId?: string }
/** The trusted runtime supplies the user-authored source. The journal publishes it with the revision. */
export interface DocumentManualWrite {
  operationId: string
  workspace: string
  path: string
  markdown: string
  source: MemorySource | null
  expected?: DocumentReadRef & { policyToken: string }
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
  files: Array<{ path: string, revision: string, policyToken?: string }>
  /** Applicability state of dynamically read files, retained across clarification waits. */
  readPolicies?: Array<{ path: string, policyToken: string }>
  status: 'pending_clarification' | 'ready' | 'resolved' | 'expired'
  answer?: { operationId: string, source: DocumentSourceRef, text: string }
}
export interface DocumentTagAttempt { workspace: string, operationId: string, path: string, revision: string, state: 'attempted' | 'failed' | 'completed', reason?: string }
export interface DocumentRename { operationId: string, workspace: string, id: string, from: string, to: string, revision: string, usageVersion: number }
export interface DocumentExternalEdit {
  path: string
  operationId: string
  workspace: string
  id: string
  expectedRevision: string
  expectedUsageVersion: number
  observedRevision: string
  sources: DocumentSourceRef[]
  action?: 'REFINE' | 'CORRECT'
  reads?: DocumentReadRef[]
  files?: Array<{ path: string, revision: string }>
  corrections?: DocumentCorrection[]
  policyToken: string
}
export interface MemoryDocuments {
  reconciliationState(operationId: string, kind: 'edit' | 'rename'): string | undefined
  reconcileEdit(input: DocumentExternalEdit): DocumentReceipt | null
  acceptedSnapshot(workspace: string, id: string): DocumentSnapshot | null
  reconcileRename(input: DocumentRename): boolean
  aliases(workspace: string): Array<{ path: string, id: string }>
  workspaces(): string[]
  registered(workspace: string): Array<DocumentReadRef & { workspace: string, path: string, sources: DocumentSourceRef[], state: 'active' | 'disabled' | 'forgotten' }>
  recordTagAttempt(input: DocumentTagAttempt): void
  tagAttempt(workspace: string, operationId: string): DocumentTagAttempt | null
  sourceRestrictions(workspace: string): DocumentSourceRef[]
  recover(): void
  /** Recover one authorized management intent after host withdrawal recovery. */
  recoverManagement(operationId: string): 'cancelled' | undefined
  receipt(workspace: string, operationId: string): DocumentReceipt | null
  hasPendingCleanup(sourceId: string): boolean
  pendingCleanup(): number
  projectErasedLocators(workspace: string, markdown: string): string
  read(workspace: string, path: string, options?: { includeDisabled?: boolean }): DocumentSnapshot | null
  list(workspace: string, options?: { includeDisabled?: boolean }): DocumentSnapshot[]
  commit(input: DocumentCommit): DocumentReceipt
  writeManual(input: DocumentManualWrite): DocumentReceipt
  undoCandidate(workspace: string, documentId: string): DocumentUndoCandidate | null
  undo(input: { operationId: string, workspace: string, documentId: string, revision: string, usageVersion: number, expectedChangeId?: string, expectedPolicyToken?: string }): DocumentReceipt
  setEnabled(input: { operationId: string, workspace: string, documentId: string, expectedRevision: string, expectedUsageVersion: number, enabled: boolean, expectedPolicyToken?: string }): DocumentReceipt
  /** Caller excludes the canonical source before invoking physical cleanup. */
  withdraw(sourceId: string): string[]
  eraseSource(cut: DocumentSourceCut): string[]
  supersessions(workspace: string, path: string, options?: { includeEvidence?: boolean }): DocumentSupersession[]
  defer(input: Omit<DeferredDocumentWork, 'status' | 'answer'>, previousOperationId?: string): DeferredDocumentWork
  deferred(workspace: string, operationId: string): DeferredDocumentWork | null
  pending(workspace: string): DeferredDocumentWork[]
  /** Canonical replies derived from this exact evidence, including resolved work. */
  dependentAnswerIds(sourceId: string, cut?: DocumentSourceCut): string[]
  answerDependencies(answerId: string): DocumentSourceRef[]
  answer(input: { operationId: string, workspace: string, deferredId: string, source: DocumentSourceRef, text: string }): DeferredDocumentWork
  resolve(workspace: string, operationId: string): void
  expire(workspace: string, operationId: string): void
}
