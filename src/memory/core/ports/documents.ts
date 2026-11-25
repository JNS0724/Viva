import type { MemorySource } from '../../contracts/records.ts'
import type { DigestAction } from '../../contracts/memory-file-contract.ts'

export interface MemoryPhysicalFile {
  path: string
  revision: string
  markdown: string
}
export type ReadMemoryPhysicalFile = (workspace: string, path: string, signal?: AbortSignal) => Promise<MemoryPhysicalFile | null>

/** Opaque canonical source versions, issued by the Node adapter, never by a model. */
export interface DocumentSourceRef { id: string, token: string, spans?: Array<{ start: number, end: number }> }
export interface DocumentReadRef { id: string, revision: string, usageVersion: number }
export interface DocumentFileRegistration extends DocumentReadRef {
  workspace: string
  path: string
  state: 'active' | 'disabled' | 'forgotten'
}
export interface DocumentSnapshot extends DocumentReadRef {
  workspace: string
  path: string
  markdown: string
  sources: DocumentSourceRef[]
  enabled: boolean
}
export interface DocumentCommit {
  operationId: string
  workspace: string
  path: string
  expectedRevision: string | null
  markdown: string
  action: DigestAction
  sources: DocumentSourceRef[]
  reads: DocumentReadRef[]
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
  action: DigestAction | 'UNDO' | 'ENABLE' | 'DISABLE' | 'FORGET'
}
export interface DocumentRevisionEntry {
  operationId: string
  at: number
  before: DocumentSnapshot | null
  after: DocumentSnapshot | null
}

export interface MemoryDocuments {
  acceptedSnapshot(workspace: string, id: string): DocumentSnapshot | null
  revisionHistory?(workspace: string, documentId: string, limit?: number): DocumentRevisionEntry[]
  workspaces(): string[]
  indexFile(workspace: string, id: string): { path: string, revision: string, state: 'active' | 'disabled' | 'forgotten' } | null
  deleteFile(workspace: string, id: string, expectedUsageVersion: number): number
  registered(workspace: string): Array<DocumentFileRegistration & { sources: DocumentSourceRef[] }>
  /** Registry metadata for management, including forgotten entries only while a restriction remains. */
  fileRegistry(workspace: string): DocumentFileRegistration[]
  recoverDeletedFiles(): void
  deletedFileCleanupPending(workspace: string, id: string): boolean
  checkpointCleanup(): void
  needsRecovery(): boolean
  recover(): void
  /** Recover one versioned management intent. */
  recoverManagement(operationId: string): 'cancelled' | undefined
  receipt(workspace: string, operationId: string): DocumentReceipt | null
  hasPendingCleanup(sourceId: string): boolean
  pendingCleanup(): number
  read(workspace: string, path: string, options?: { includeDisabled?: boolean, physical?: MemoryPhysicalFile | null }): DocumentSnapshot | null
  list(workspace: string, options?: { includeDisabled?: boolean }): DocumentSnapshot[]
  commit(input: DocumentCommit): DocumentReceipt
  writeManual(input: DocumentManualWrite): DocumentReceipt
  undoCandidate(workspace: string, documentId: string, accepted?: DocumentSnapshot): DocumentUndoCandidate | null
  undo(input: { operationId: string, workspace: string, documentId: string, revision: string, usageVersion: number, expectedChangeId?: string, expectedPolicyToken?: string }): DocumentReceipt
  setEnabled(input: { operationId: string, workspace: string, documentId: string, expectedRevision: string, expectedUsageVersion: number, enabled: boolean, expectedPolicyToken?: string }): DocumentReceipt
  /** Caller excludes the canonical source before invoking physical cleanup. */
}
