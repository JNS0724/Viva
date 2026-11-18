import { randomUUID } from 'node:crypto'
import type { HostMemoryApi, HostMemoryCaller, HostMemoryMethod } from '../memory/contracts/host.ts'
import type { MemoryProject } from '../memory/contracts/host.ts'
export type MemoryReadBatch = <T>(work: (call: HostMemoryCaller) => Promise<T>, options?: { budgetMs?: number, signal?: AbortSignal }) => Promise<T>

/** Thin Viva management adapter. Storage, mutation receipts and authorization belong to the owner. */
export function createVivaMemoryClient(call: HostMemoryCaller, readBatch: MemoryReadBatch = work => work(call)) {
  const method = <M extends HostMemoryMethod>(name: M) => (...args: HostMemoryApi[M]['input'] extends { args: infer A extends unknown[] } ? A : never) =>
    call(name, { args } as unknown as HostMemoryApi[M]['input'])
  return {
    readPage: (project?: MemoryProject, options?: { budgetMs?: number, signal?: AbortSignal }) => readBatch(async read => {
      const profile = await read('profile', { args: [] })
      const onboarding = await read('onboarding', { args: [] })
      const cleanupPending = await read('cleanupPending', { args: [] })
      const revision = await read('revision', { args: [] })
      const fileProfile = await read('fileProfile', { args: [project] })
      return { profile, onboarding, cleanupPending, revision, fileProfile }
    }, options),
    listFiles: method('listFiles'), readFile: method('readFile'),
    createFile: method('createFile'), editFile: method('editFile'),
    setFileEnabled: method('setFileEnabled'), undoFile: method('undoFile'), forgetFile: method('forgetFile'),
    fileOperation: (operationId: string) => call('getOperation', { operationId }),
    recoverContext: method('recoverContext'),
    profile: method('profile'), fileProfile: method('fileProfile'),
    revision: method('revision'), cleanupPending: method('cleanupPending'),
    onboarding: method('onboarding'), setOnboarding: method('setOnboarding'), rebuildIndexes: method('rebuildIndexes'),
    setProfile: (fields: Record<string, unknown>, operation: string = randomUUID()) => call('setProfile', { args: [fields, operation] }),
  }
}
export type VivaMemoryClient = ReturnType<typeof createVivaMemoryClient>
