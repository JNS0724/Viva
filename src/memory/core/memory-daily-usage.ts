import type { MemoryFileMutation, MemoryFileMutationResult } from '../contracts/file-management.ts'
import type { createMemoryFileManagement } from './memory-file-management.ts'
import type { MemorySourceReference } from '../contracts/service.ts'
import type { DocumentSourceRef } from './ports/documents.ts'
import type { FileUseTarget, MemoryFileRestrictions } from './ports/file-restrictions.ts'
import type { MemoryNotes } from './ports/notes.ts'
import { MemoryDomainError } from './presentation.ts'

type Validated = ReturnType<ReturnType<typeof createMemoryFileManagement>['validate']>

/** Called only inside the runtime's send fence. The ledger, version and rebuild queue share one transaction. */
export function createMemoryDailyUsage({ ledger, notes, sourceReferences, hash, now, transaction, revisionChanged, queueRebuild, queueRestrictedRebuilds }: {
  ledger: MemoryFileRestrictions,
  notes: Pick<MemoryNotes, 'references' | 'advanceUseVersion'>,
  sourceReferences(refs: readonly DocumentSourceRef[]): MemorySourceReference[] | null,
  hash(text: string): string,
  now(): number,
  transaction<T>(work: () => T): T,
  revisionChanged(): void,
  queueRebuild(key: string): void,
  queueRestrictedRebuilds(): void,
}) {
  function command(input: MemoryFileMutation, validate: () => Validated): { result: MemoryFileMutationResult, sources: MemorySourceReference[], changed: boolean } {
    if (input.identity.kind !== 'daily' || input.action !== 'setEnabled') throw new MemoryDomainError('invalid.text')
    const fingerprint = hash(JSON.stringify(input))
    return transaction(() => {
      const prior = ledger.receipt(input.operationId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new MemoryDomainError('operation.conflict')
        return { result: prior.result, sources: prior.sources, changed: false }
      }
      const { view, restriction } = validate()
      const allocation = view.daily?.allocation
      if (!allocation) throw new MemoryDomainError('not.found')
      const target: FileUseTarget = { workspace: allocation.workspace, kind: 'daily', key: allocation.key }
      const refs = restriction?.sources ?? notes.references(target.key)
      const sources = sourceReferences(refs)
      if (!sources?.length) throw new MemoryDomainError('revision.conflict')
      if (!notes.advanceUseVersion(target.key, allocation.revision, now())) throw new MemoryDomainError('revision.conflict')
      const usageVersion = allocation.revision + 1
      const restrictionId = restriction?.id ?? input.operationId
      if (input.enabled) {
        if (!restriction || !ledger.release(target, restrictionId)) throw new MemoryDomainError('revision.conflict')
      } else {
        ledger.add({ ...target, id: restrictionId, contentRevision: view.revision, usageVersion, sources: refs }, view.markdown)
      }
      queueRebuild(target.key)
      if (!input.enabled) queueRestrictedRebuilds()
      revisionChanged()
      const result: MemoryFileMutationResult = { operationId: input.operationId, identity: input.identity,
        contentRevision: input.version.contentRevision, usageVersion, restrictionId, action: input.enabled ? 'ENABLE' : 'DISABLE' }
      ledger.complete(input.operationId, { fingerprint, result, sources })
      return { result, sources, changed: true }
    })
  }
  return { command }
}
