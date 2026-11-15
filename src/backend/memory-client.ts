import { randomUUID } from 'node:crypto'
import { t } from '../shared/i18n/translate.ts'
import { createMemoryClient, createMemoryService, MemoryServiceError } from '../memory/core/client.ts'
import { MemoryDomainError } from '../memory/core/presentation.ts'
import type { MemoryRuntime } from '../memory/core/memory-runtime.ts'
import type { MemoryMethod, MemoryOperationOutcome, MemoryRecord, MemoryResult } from '../memory/contracts/service.ts'
import type { MemoryEntry } from '../memory/core/ports/store.ts'

const capabilities = ['status', 'read', 'remember', 'revise', 'setEnabled', 'forget'] as const satisfies readonly MemoryMethod[]
const domainCodes = ['change.pending', 'credentials', 'invalid.text', 'not.found', 'operation.conflict', 'restore.explicit', 'revision.conflict'] as const
const isDomainCode = (code: string): code is typeof domainCodes[number] => domainCodes.some(value => value === code)
const memoryId = (id: number) => `memory:${id}`
function entryId(id: string) {
  const match = /^memory:([1-9]\d*)$/u.exec(id)
  const value = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(value)) throw new MemoryServiceError({ code: 'invalid-input' })
  return value
}
function record(entry: MemoryEntry): MemoryRecord {
  return {
    id: memoryId(entry.id), revision: entry.revision, text: entry.text, enabled: entry.retention === 'retained',
    scope: entry.scope.kind === 'user' ? { kind: 'user' } : { kind: entry.scope.kind === 'conversation' ? 'thread' : entry.scope.kind, id: entry.scope.id },
    sources: entry.evidence.map(source => ({ namespace: 'viva', sourceId: source.sourceId,
      ...(source.conversationId ? { occurrenceId: source.conversationId } : {}), revision: source.sourceVersion })),
  }
}
function protocolError(error: unknown): never {
  if (error instanceof MemoryDomainError) {
    const code = error.code === 'revision.conflict' ? 'revision-conflict'
      : error.code === 'operation.conflict' ? 'operation-id-conflict'
        : error.code === 'change.pending' ? 'unavailable' : 'invalid-input'
    throw new MemoryServiceError({ code, reason: error.code })
  }
  throw error
}
function localError(error: unknown): never {
  if (error instanceof MemoryServiceError) {
    const reason = error.failure.reason
    if (reason && isDomainCode(reason)) throw new MemoryDomainError(reason, t(`main.memory.${reason}`, {}))
    throw new Error(t(error.failure.code === 'revision-conflict' ? 'main.memory.revision.conflict'
      : error.failure.code === 'operation-id-conflict' ? 'main.memory.operation.conflict'
        : error.failure.code === 'invalid-input' ? 'main.memory.invalid.text' : 'main.memory.change.pending'))
  }
  throw error
}

/**
 * P1 local management connection. P2 replaces its transport/owner; the public DTO boundary already runs here.
 * Legacy UI snapshot reads stay in this thin adapter until R5a's document views. Domain writes and durable
 * operation receipts remain in the core. This endpoint is local to the authenticated Viva UI, never a model API.
 */
export function createVivaMemoryClient(runtime: MemoryRuntime, changingMemory: <T>(work: () => T | Promise<T>) => Promise<T>) {
  const instanceEpoch = randomUUID()
  const transport = createMemoryService({
    binding: { clientId: 'viva-ui', namespace: 'viva', kind: 'user-interface', capabilities },
    epoch: () => instanceEpoch, state: () => 'ready', supported: capabilities,
    authorize: (_binding, command) => {
      // The local UI manages this single owner's entire database. Do not advertise model/source/host commands.
      if (command.method === 'remember') return command.input.input.kind === 'explicit-user' && command.input.scope.kind === 'user'
      if (command.method === 'revise') return command.input.sources.length === 0
      return true
    },
    async execute(command) {
      try {
        const completed = (operationId: string, entry?: MemoryEntry | null): MemoryOperationOutcome => ({
          operationId, state: 'completed', revision: runtime.revision(), ...(entry ? { targetId: memoryId(entry.id) } : {}),
        })
        const perform = async (): Promise<MemoryResult> => {
          switch (command.method) {
            case 'read': {
              const entry = runtime.readManagementEntry(entryId(command.input.id))
              if (entry && command.input.expectedRevision !== undefined && entry.revision !== command.input.expectedRevision) {
                throw new MemoryServiceError({ code: 'revision-conflict', reason: 'revision.conflict' })
              }
              return entry ? record(entry) : null
            }
            case 'remember': return completed(command.input.operationId,
              runtime.addMemory(command.input.text, command.input.category, command.input.operationId))
            case 'revise': return completed(command.input.operationId,
              await runtime.editMemory(entryId(command.input.id), command.input.text, command.input.expectedRevision, command.input.operationId))
            case 'setEnabled': {
              const input = command.input
              if (input.enabled) return completed(input.operationId,
                runtime.restore(entryId(input.id), input.expectedRevision, input.operationId))
              await runtime.forget(entryId(input.id), input.expectedRevision, 'forget', input.operationId)
              return completed(input.operationId)
            }
            case 'forget': {
              const input = command.input
              const outcome = await runtime.deleteMemory(entryId(input.id), input.expectedRevision, input.operationId)
              return { operationId: input.operationId, state: outcome.status === 'cleared' ? 'completed' : 'cleanup-pending',
                revision: runtime.revision(), sendFence: 'complete', cleanup: outcome.status === 'cleared' ? 'complete' : 'pending' }
            }
            default: throw new MemoryServiceError({ code: 'unauthorized' })
          }
        }
        return await (command.method === 'read' ? perform() : changingMemory(perform))
      } catch (error) { return protocolError(error) }
    },
  })
  const client = createMemoryClient({ transport, requestId: randomUUID })
  let connection: Promise<unknown> | undefined
  async function call<M extends MemoryMethod>(method: M, input: Parameters<typeof client.call<M>>[1]) {
    try {
      connection ??= client.connect().catch(error => { connection = undefined; throw error })
      await connection
      return await client.call(method, input)
    } catch (error) { return localError(error) }
  }
  const snapshot = (result: MemoryOperationOutcome) => result.targetId ? runtime.readManagementEntry(entryId(result.targetId)) : null
  return {
    // Temporary local snapshot/domain-management facade. P2 replaces local ownership and R5a replaces fact DTOs.
    listMemories: runtime.listMemories,
    listInvalid: runtime.listInvalid,
    listChanges: runtime.listChanges,
    profile: runtime.profile,
    profileView: runtime.profileView,
    revision: runtime.revision,
    cleanupPending: runtime.cleanupPending,
    onboarding: runtime.onboarding,
    setOnboarding: runtime.setOnboarding,
    rebuildIndexes: runtime.rebuildIndexes,
    setProfile: (...args: Parameters<MemoryRuntime['setProfile']>) => changingMemory(() => runtime.setProfile(...args)),
    resolveConflictPair: (...args: Parameters<MemoryRuntime['resolveConflictPair']>) => changingMemory(() => runtime.resolveConflictPair(...args)),
    undoChange: (...args: Parameters<MemoryRuntime['undoChange']>) => changingMemory(() => runtime.undoChange(...args)),
    async addMemory(text: string, category = 'fact', operationId: string = randomUUID()) {
      return snapshot(await call('remember', { operationId, text, category, scope: { kind: 'user' }, input: { kind: 'explicit-user' } }))
    },
    async editMemory(id: number, text: string, expectedRevision: number, operationId: string = randomUUID()) {
      return snapshot(await call('revise', { operationId, id: memoryId(id), expectedRevision, text, sources: [] }))
    },
    async stopMemory(id: number, expectedRevision: number, operationId: string = randomUUID()) {
      await call('setEnabled', { operationId, id: memoryId(id), expectedRevision, enabled: false })
      return true
    },
    async restoreMemory(id: number, expectedRevision: number, operationId: string = randomUUID()) {
      return snapshot(await call('setEnabled', { operationId, id: memoryId(id), expectedRevision, enabled: true }))
    },
    async deleteMemory(id: number, expectedRevision: number, operationId: string = randomUUID()): Promise<{ status: 'cleared' | 'stopped' }> {
      const outcome = await call('forget', { operationId, id: memoryId(id), expectedRevision })
      return { status: outcome.cleanup === 'complete' ? 'cleared' : 'stopped' }
    },
  }
}

export type VivaMemoryClient = ReturnType<typeof createVivaMemoryClient>
