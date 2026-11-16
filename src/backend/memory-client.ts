import { randomUUID } from 'node:crypto'
import type { HostMemoryApi, HostMemoryCaller, HostMemoryMethod } from '../memory/contracts/host.ts'

/** Thin Viva management adapter. Storage, mutation receipts and authorization belong to the owner. */
export function createVivaMemoryClient(call: HostMemoryCaller) {
  const method = <M extends HostMemoryMethod>(name: M) => (...args: HostMemoryApi[M]['input'] extends { args: infer A extends unknown[] } ? A : never) =>
    call(name, { args } as unknown as HostMemoryApi[M]['input'])
  return {
    recoverContext: method('recoverContext'),
    listMemories: method('listMemories'), listInvalid: method('listInvalid'), listChanges: method('listChanges'),
    profile: method('profile'), profileView: method('profileView'), revision: method('revision'), cleanupPending: method('cleanupPending'),
    onboarding: method('onboarding'), setOnboarding: method('setOnboarding'), rebuildIndexes: method('rebuildIndexes'),
    setProfile: (fields: Record<string, unknown>, operation: string = randomUUID()) => call('setProfile', { args: [fields, operation] }),
    resolveConflictPair: method('resolveConflictPair'), undoChange: method('undoChange'),
    addMemory: (text: string, category = 'fact', operation: string = randomUUID()) => call('addMemory', { args: [text, category, operation] }),
    editMemory: (id: number, text: string, revision: number, operation: string = randomUUID()) => call('editMemory', { args: [id, text, revision, operation] }),
    stopMemory: (id: number, revision: number, operation: string = randomUUID()) => call('stopMemory', { args: [id, revision, operation] }),
    restoreMemory: (id: number, revision: number, operation: string = randomUUID()) => call('restoreMemory', { args: [id, revision, operation] }),
    deleteMemory: (id: number, revision: number, operation: string = randomUUID()) => call('deleteMemory', { args: [id, revision, operation] }),
  }
}
export type VivaMemoryClient = ReturnType<typeof createVivaMemoryClient>
