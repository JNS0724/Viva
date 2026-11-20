import { randomUUID } from 'node:crypto'
import { createMemoryRuntime as createCoreMemoryRuntime, publicationEffectKinds } from '../core/memory-runtime.ts'
import type { MemoryRuntimeResources } from '../core/ports/runtime.ts'
import type { MemoryStore } from './memory-store.ts'
import { memoryHash } from './memory-store.ts'
import { createEffects } from './effects.ts'
import { emitDiagnosticFailure } from '../../diagnostics/node/context.ts'
import { openMemoryNotes } from './memory-note-store.ts'
import { openMemoryDocuments } from './memory-document-store.ts'
import { openMemoryFileIndex } from './memory-file-index.ts'
import { openMemoryFileRestrictions } from './memory-file-restrictions.ts'
import { createMemoryPhysicalFileReader, readMemoryFileAtCommit } from './memory-file-store.ts'
import { erasedDocumentSource } from '../core/memory-document-restrictions.ts'
import { memorySourceToken, memorySourceWorkspace } from './source-identity.ts'

export type NodeMemoryRuntimeOptions = Omit<Parameters<typeof createCoreMemoryRuntime>[0], 'store' | 'resources'> & { store: MemoryStore }

/** Open the platform resources consumed through explicit core ports. */
export function openMemoryRuntimeResources({ store, now }: { store: MemoryStore, now?: () => number }): MemoryRuntimeResources {
  // Both runners use the same durable rows and generation checks. A pending model
  // request cannot occupy the runner that publishes or cleans committed indexes.
  const options = { db: store.db, now, onError: (error: unknown) => emitDiagnosticFailure('effects', error) }
  const jobs = createEffects(options)
  const publications = createEffects(options)
  let publicationPass: Promise<void> | undefined
  const readPhysicalFile = createMemoryPhysicalFileReader(() => store.fileRoot)
  const effects: typeof jobs = {
    ...jobs,
    runs(kind, run, delay) { (publicationEffectKinds.has(kind) ? publications : jobs).runs(kind, run, delay) },
    queue(kind, key, payload, dueAt) {
      jobs.queue(kind, key, payload, dueAt)
      // wake() schedules its pass in a microtask after the enclosing SQLite transaction.
      if (publicationEffectKinds.has(kind)) publicationPass = publications.wake()
    },
    async wake() {
      await Promise.all([publications.wake(), jobs.wake()])
      // A note or Dream job may have committed an index change during this wake.
      await publicationPass
    },
    close() { readPhysicalFile.close(); publications.close(); jobs.close() },
  }
  const resources: MemoryRuntimeResources = {
    sourceToken: memorySourceToken, sourceWorkspace: memorySourceWorkspace,
    identity: { newId: randomUUID, hash: memoryHash },
    effects,
    openFileRestrictions: () => openMemoryFileRestrictions(store.db),
    openFileIndex: () => openMemoryFileIndex({ db: store.db, now }),
    readFileRevisionAtCommit: (workspace, path) => readMemoryFileAtCommit(store.fileRoot, workspace, path)?.revision,
    readPhysicalFile,
    openNotes: (readable, currentJob, options) => openMemoryNotes(store, readable, undefined, currentJob, options),
    openDocuments: (readable, onCommitted, policy) => openMemoryDocuments({ db: store.db, root: store.fileRoot, now, onCommitted, erasures: store.fileErasures,
      managementCurrent: policy?.managementCurrent, deferRecovery: policy?.deferRecovery,
      expandRestrictions: policy?.expandRestrictions, locatorCleaned: policy?.locatorCleaned, index: policy?.index,
      manual: policy?.manualCurrent && { current: policy.manualCurrent, token: memorySourceToken, workspace: memorySourceWorkspace,
        commit: store.insertManualFileSource, retainsText: store.manualFileRetainsText },
      source(id) {
        const source = store.readSource(id)
        return source?.text && readable(id) ? { token: memorySourceToken(source), workspace: memorySourceWorkspace(source),
          text: source.text, erasure: erasedDocumentSource(source) } : undefined
      },
    }),
  }
  return resources
}

/** Default Node assembly. No Electron, Viva translation, DSH or parent-process bridge is required. */
export function createMemoryRuntime(options: NodeMemoryRuntimeOptions) {
  const resources = openMemoryRuntimeResources(options)
  try {
    return createCoreMemoryRuntime({ ...options, resources })
  } catch (error) {
    resources.effects.close()
    throw error
  }
}
export { MAX_RECALL_CHARS, MAX_DEEP_RECALL_CHARS } from '../core/memory-runtime.ts'
export type { MemoryWithdrawal, MemoryRuntime } from '../core/memory-runtime.ts'
