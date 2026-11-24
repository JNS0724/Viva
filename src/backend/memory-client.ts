import { randomUUID } from 'node:crypto'
import type { HostMemoryApi, HostMemoryCaller, HostMemoryMethod } from '../memory/contracts/host.ts'
import type { MemoryProject } from '../memory/contracts/host.ts'
export type MemoryReadBatch = <T>(work: (call: HostMemoryCaller) => Promise<T>, options?: { budgetMs?: number, signal?: AbortSignal }) => Promise<T>

/** Thin Viva management adapter. Storage, mutation receipts and authorization belong to the owner. */
export function createVivaMemoryClient(call: HostMemoryCaller, readBatch: MemoryReadBatch = work => work(call)) {
  const method = <M extends HostMemoryMethod>(name: M) => (...args: HostMemoryApi[M]['input'] extends { args: infer A extends unknown[] } ? A : never) =>
    call(name, { args } as unknown as HostMemoryApi[M]['input'])
  return {
    readPage: (project?: MemoryProject, options?: { budgetMs?: number, signal?: AbortSignal }) =>
      readBatch(read => read('profilePage', { args: project ? [project] : [] }), options),
    dreamStatus: method('dreamStatus'), requestDream: method('requestDream'),
    listFiles: (request: HostMemoryApi['listFiles']['input']['args'][0], options?: Parameters<MemoryReadBatch>[1]) =>
      readBatch(read => read('listFiles', { args: [request] }), options),
    readFile: (identity: HostMemoryApi['readFile']['input']['args'][0], options?: Parameters<MemoryReadBatch>[1]) =>
      readBatch(read => read('readFile', { args: [identity] }), options),
    createFile: method('createFile'), editFile: method('editFile'),
    setFileEnabled: method('setFileEnabled'), undoFile: method('undoFile'), forgetFile: method('forgetFile'),
    fileOperation: (operationId: string) => call('getOperation', { operationId }),
    profile: method('profile'), fileProfile: method('fileProfile'),
    revision: method('revision'), cleanupPending: method('cleanupPending'),
    onboarding: method('onboarding'), setOnboarding: method('setOnboarding'), rebuildIndexes: method('rebuildIndexes'),
    setProfile: (fields: Record<string, unknown>, operation: string = randomUUID()) => call('setProfile', { args: [fields, operation] }),
  }
}
export type VivaMemoryClient = ReturnType<typeof createVivaMemoryClient>
