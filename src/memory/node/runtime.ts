import { randomUUID } from 'node:crypto'
import { createMemoryRuntime as createCoreMemoryRuntime } from '../core/memory-runtime.ts'
import type { MemoryRuntimeResources } from '../core/ports/runtime.ts'
import type { MemoryStore } from './memory-store.ts'
import { memoryHash } from './memory-store.ts'
import { createEffects } from './effects.ts'
import { openMemoryIndex } from './memory-index.ts'
import { openMemorySemanticIndex, memorySemanticCopiesCleared } from './memory-semantic.ts'
import { openMemoryProfileStore } from './memory-profile-store.ts'
import { openMemoryNotes } from './memory-note-store.ts'
import { createMemoryCleanup } from './memory-cleanup.ts'
import { openMemoryDocuments } from './memory-document-store.ts'
import { openMemoryFileIndex } from './memory-file-index.ts'
import { openMemoryFileCatalog } from './memory-file-catalog.ts'
import { memorySourceToken, memorySourceWorkspace } from './source-identity.ts'

export type NodeMemoryRuntimeOptions = Omit<Parameters<typeof createCoreMemoryRuntime>[0], 'store' | 'resources'> & { store: MemoryStore }

/** Open the platform resources consumed through explicit core ports. */
export function openMemoryRuntimeResources({ store, now }: { store: MemoryStore, now?: () => number }): MemoryRuntimeResources {
  const effects = createEffects({ db: store.db, now, onError: () => console.error('[memory] durable memory queue failed') })
  const lexical = openMemoryIndex(store.db)
  const resources: MemoryRuntimeResources = {
    sourceToken: memorySourceToken, sourceWorkspace: memorySourceWorkspace,
    identity: { newId: randomUUID, hash: memoryHash },
    effects, lexical,
    projectionStore: openMemoryProfileStore(store.db),
    openSemantic: () => openMemorySemanticIndex(store.db),
    openFileIndex: () => openMemoryFileIndex({ db: store.db, now }),
    openFileCatalog: () => openMemoryFileCatalog({ root: store.fileRoot }),
    semanticCopiesCleared: (ids, revision) => memorySemanticCopiesCleared(store.db, ids, revision),
    openNotes: (readable, currentJob, onRenamed, external) => openMemoryNotes(store, readable, undefined, currentJob, onRenamed, external?.committed, external?.current, { onCommitted: external?.noteCommitted }),
    openDocuments: (readable, onCommitted, onRenamed, external) => openMemoryDocuments({ db: store.db, root: store.fileRoot, now, onCommitted, onRenamed,
      externalCurrent: external?.current, deferRecovery: external?.deferRecovery,
      source(id) {
        const source = store.readSource(id)
        return source?.text && readable(id) ? { token: memorySourceToken(source), workspace: memorySourceWorkspace(source), text: source.text } : undefined
      },
    }),
    createCleanup: callbacks => createMemoryCleanup({ db: store.db, effects, lexical, hasCandidateReference: store.hasCandidateReference, ...callbacks }),
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
