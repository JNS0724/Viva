import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostMemoryApi, HostMemoryMethod, MemoryOwnerState } from '../../../src/memory/contracts/host.ts'
import type { OwnerAdapterApi, OwnerAdapterCaller, OwnerCallOptions } from '../../../src/memory/node/owner-adapter.ts'

export type OwnerHostCaller = <M extends HostMemoryMethod>(
  method: M,
  input: HostMemoryApi[M]['input'],
  options?: OwnerCallOptions,
) => Promise<HostMemoryApi[M]['output']>

export type MemoryOwnerConnection = OwnerAdapterCaller & {
  start(): Promise<void>
  close(): Promise<void>
  callHost: OwnerHostCaller
  subscribe(listener: (event: unknown) => void): () => void
  status(): MemoryOwnerState['state']
  epoch(): string | undefined
}

/** Fence sidecar calls to the owner instance that accepted them. */
export function createRemoteMemoryOwner(connection: MemoryOwnerConnection) {
  const scope = new AsyncLocalStorage<string>()
  let closed = false

  const current = (epoch: string | undefined) => !closed && epoch !== undefined && epoch === connection.epoch()
  const ready = () => current(connection.epoch()) && connection.status() === 'ready'

  async function call<M extends keyof OwnerAdapterApi>(method: M, args: Parameters<OwnerAdapterApi[M]>, options?: OwnerCallOptions): Promise<Awaited<ReturnType<OwnerAdapterApi[M]>>> {
    const epoch = scope.getStore() ?? connection.epoch()
    if (!current(epoch)) throw new Error('Memory operation belongs to a retired owner')
    const result = await connection.callAdapter(method, args, options)
    if (!current(epoch)) throw new Error('Memory operation completed for a retired owner')
    return result
  }

  async function inEpoch<T>(epoch: string | undefined, work: () => Promise<T>): Promise<T> {
    const inherited = scope.getStore()
    if (!epoch || !current(epoch) || inherited && inherited !== epoch) throw new Error('Memory operation belongs to a retired owner')
    const result = await scope.run(epoch, work)
    if (!current(epoch)) throw new Error('Memory operation completed for a retired owner')
    return result
  }

  return {
    get epoch() { return connection.epoch() },
    ready, inEpoch, call,
    handleHost: connection.callHost,
    intakeCursor: (session: string) => call('intakeCursor', [session]),
    advanceIntakeCursor: (input: Parameters<OwnerAdapterApi['advanceIntakeCursor']>[0]) => call('advanceIntakeCursor', [input]),
    beginTurn: (input: Parameters<OwnerAdapterApi['beginTurn']>[0]) => call('beginTurn', [input]),
    stageOpenTurnSources: (input: Parameters<OwnerAdapterApi['stageOpenTurnSources']>[0]) => call('stageOpenTurnSources', [input]),
    settleTurn: (input: Parameters<OwnerAdapterApi['settleTurn']>[0]) => call('settleTurn', [input]),
    bindIntakeSession: (...args: Parameters<OwnerAdapterApi['bindIntakeSession']>) => call('bindIntakeSession', args),
    rememberStandaloneFile: (session: string, input: Parameters<OwnerAdapterApi['rememberStandaloneFile']>[1], opts?: OwnerCallOptions) =>
      call('rememberStandaloneFile', [session, input], opts),
    forgetStandaloneFile: (session: string, id: string, operationId: string, opts?: OwnerCallOptions) =>
      call('forgetStandaloneFile', [session, id, operationId], opts),
    async close() { closed = true; await connection.close() },
  }
}
