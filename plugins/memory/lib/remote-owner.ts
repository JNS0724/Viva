import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'
import type { HostMemoryCaller, MemoryOwnerState } from '../../../src/memory/contracts/host.ts'
import type { OwnerAdapterApi, OwnerAdapterCaller, OwnerCallOptions, RemoteToolReadScope } from '../../../src/memory/node/owner-adapter.ts'
import type { NativeToolReadScope } from '../../../src/memory/node/native-tool-reads.ts'
import type { BindMemoryContextRecovery, CommitMemoryContextRecovery } from '../../../src/memory/contracts/context-recovery.ts'
import { objectOf } from '../../../src/memory/contracts/unknown-value.ts'
import type { MemoryTransportOrigin } from './transport.ts'

export type MemoryOwnerConnection = OwnerAdapterCaller & {
  start(): Promise<void>
  close(): Promise<void>
  reconciled?(epoch: string, ready: boolean): void
  callHost: HostMemoryCaller
  subscribe(listener: (event: unknown) => void): () => void
  status(): MemoryOwnerState['state']
  epoch(): string | undefined
}
type View = Awaited<ReturnType<OwnerAdapterApi['sessionView']>>
type Send = { epoch: string, controller: AbortController, done: Promise<void>, finish(): void }

export function createRemoteMemoryOwner(connection: MemoryOwnerConnection, report: (error: unknown) => void) {
  const scope = new AsyncLocalStorage<{ epoch: string }>()
  const views = new Map<string, View>()
  const checks = new Map<string, () => boolean | Promise<boolean>>()
  const sends = new Map<string, Send>()
  type ReceiptFailure = { error: unknown, observedThrough?: number }
  type Receipts = { epoch: string, queue: Promise<ReceiptFailure | undefined> }
  let barrierSequence = 0
  const completions = new Map<string, Receipts>()
  let epoch: string | undefined
  let closed = false

  function syncEpoch() {
    const next = connection.epoch()
    if (next !== epoch) {
      for (const send of sends.values()) send.controller.abort(new Error('Memory owner changed'))
      views.clear()
      checks.clear()
      completions.clear()
      epoch = next
    }
    return epoch
  }

  const unsubscribe = connection.subscribe(value => {
    syncEpoch()
    const event = objectOf(value)
    if (event?.type === 'memory_owner_send_revoked' && typeof event.id === 'string') {
      const send = sends.get(event.id)
      if (send && send.epoch === event.epoch) send.controller.abort(new Error('Memory send permit was revoked'))
    } else if (event?.type === 'memory_owner_state' && event.state !== 'ready') {
      views.clear()
      for (const send of sends.values()) send.controller.abort(new Error('Memory owner is unavailable'))
    }
  })

  function current(expected: string | undefined) {
    return !closed && expected !== undefined && expected === syncEpoch()
  }

  function ready() { return !!syncEpoch() && !closed && connection.status() === 'ready' }

  async function call<M extends keyof OwnerAdapterApi>(method: M, args: Parameters<OwnerAdapterApi[M]>, options?: OwnerCallOptions): Promise<Awaited<ReturnType<OwnerAdapterApi[M]>>> {
    const expected = scope.getStore()?.epoch ?? syncEpoch()
    if (!current(expected)) throw new Error('Memory operation belongs to a retired owner')
    const result = await connection.callAdapter(method, args, options)
    if (!current(expected)) throw new Error('Memory operation completed for a retired owner')
    return result
  }

  async function inEpoch<T>(expected: string | undefined, work: () => Promise<T>): Promise<T> {
    const inherited = scope.getStore()
    if (!expected || !current(expected) || inherited && inherited.epoch !== expected) throw new Error('Memory operation belongs to a retired owner')
    const result = await scope.run({ epoch: expected }, work)
    if (!current(expected)) throw new Error('Memory operation completed for a retired owner')
    return result
  }

  function defer<M extends 'finishNativeToolRead' | 'finishNativeOutput'>(session: string, method: M, args: Parameters<OwnerAdapterApi[M]>) {
    const captured = scope.getStore()?.epoch ?? syncEpoch()
    if (!captured || !current(captured)) return
    const pending = completions.get(session)
    const item: Receipts = pending?.epoch === captured ? pending : { epoch: captured, queue: Promise.resolve(undefined) }
    completions.set(session, item)
    const queue = item.queue.then(async (prior): Promise<ReceiptFailure | undefined> => {
      try { await inEpoch(captured, () => call(method, args)); return prior }
      catch (error) { report(error); return { error } }
    })
    item.queue = queue
    void queue.then(failure => {
      if ((!failure || failure.observedThrough !== undefined) && item.queue === queue && completions.get(session) === item) completions.delete(session)
    })
  }

  async function readContext(session: string, options?: OwnerCallOptions) {
    const view = await call('sessionView', [session], options)
    if (view.contextGeneration >= (views.get(session)?.contextGeneration ?? 0)) views.set(session, view)
    return view
  }

  async function drainSends(retiredEpoch: string) {
    const pending = [...sends.values()].filter(send => send.epoch === retiredEpoch)
    for (const send of pending) send.controller.abort(new Error('Memory owner retired the send permit'))
    await Promise.all(pending.map(send => send.done))
  }

  async function acquireSend(id: string, origin: MemoryTransportOrigin, payload: string, signal?: AbortSignal) {
    const expected = scope.getStore()?.epoch ?? syncEpoch()
    if (!expected || !current(expected)) throw new Error('Memory send belongs to a retired owner')
    const controller = new AbortController()
    let acknowledge!: () => void
    const done = new Promise<void>(resolve => { acknowledge = resolve })
    const send = { epoch: expected, controller, done, finish() {
      if (sends.get(id) !== send) return
      sends.delete(id)
      acknowledge()
      if (current(expected)) void inEpoch(expected, () => call('settleSend', [id])).catch(report)
    } }
    sends.set(id, send)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const canSend = () => current(expected) && ready() && !combined.aborted && sends.get(id) === send
    try {
      if ('session' in origin) await completion(origin.session)
      await inEpoch(expected, () => call('acquireSend', [id, origin, payload], { signal: combined }))
      if (!canSend()) throw new Error('Memory send permit was revoked')
    } catch (error) {
      send.finish()
      throw error
    }
    return { id, payload, signal: controller.signal, current: canSend, settled: send.finish,
      recordBody: () => inEpoch(expected, () => call('recordSendBody', [id], { signal: combined })) }
  }

  function serializableScope(lease: NativeToolReadScope): RemoteToolReadScope {
    if (!lease.current()) throw new Error('Native tool execution is no longer active')
    return { call: lease.call, calls: lease.calls, readCut: lease.readCut?.() }
  }

  function completion(session: string) {
    const item = completions.get(session)
    if (!item || item.epoch !== syncEpoch()) return Promise.resolve()
    const sequence = ++barrierSequence
    const queue = item.queue
    return queue.then(failure => {
      if (item.queue === queue && completions.get(session) === item) completions.delete(session)
      if (!failure) return
      // All barriers already waiting when the failure is first delivered must
      // see it, including one which also waits for a later successful receipt.
      failure.observedThrough ??= barrierSequence
      if (sequence <= failure.observedThrough) throw failure.error
    })
  }

  return {
    get epoch() { return syncEpoch() },
    ready, inEpoch, call,
    readContext,
    cachedGeneration: (session: string) => ready() ? views.get(session)?.contextGeneration : undefined,
    cachedContextRewritten: (session: string) => ready() && views.get(session)?.nativeContextRewritten,
    release: (session: string) => { views.delete(session) },
    contextGeneration: async (session: string) => (await readContext(session)).contextGeneration,
    contextRecovery: async (session: string) => (await readContext(session)).contextRecovery,
    needsContextRecovery: async (session: string) => (await readContext(session)).needsContextRecovery,
    initializeSession: (input: Parameters<OwnerAdapterApi['initializeSession']>[0]) => call('initializeSession', [input]),
    noteInheritedNativeCut: (input: Parameters<OwnerAdapterApi['noteInheritedNativeCut']>[0]) => call('noteInheritedNativeCut', [input]),
    receiveSource: (input: Parameters<OwnerAdapterApi['receiveSource']>[0]) => call('receiveSource', [input]),
    registerDerived: (input: Parameters<OwnerAdapterApi['registerDerived']>[0]) => call('registerDerived', [input]),
    completeTurn: (input: Parameters<OwnerAdapterApi['completeTurn']>[0]) => call('completeTurn', [input]),
    dispatch: { snapshot: (...args: Parameters<OwnerAdapterApi['snapshot']>) => call('snapshot', args) },
    prepareContextRecovery: (input: Parameters<OwnerAdapterApi['prepareContextRecovery']>[0]) => call('prepareContextRecovery', [input]),
    bindContextRecovery: (input: BindMemoryContextRecovery) => call('bindContextRecovery', [input]),
    async commitContextRecovery(input: CommitMemoryContextRecovery, stillCurrent: () => boolean | Promise<boolean>) {
      const checkId = randomUUID()
      checks.set(checkId, stillCurrent)
      try { return await call('commitContextRecovery', [input, checkId]) } finally { checks.delete(checkId) }
    },
    async checkRecovery(checkId: string) { return await checks.get(checkId)?.() === true },
    rememberStandaloneFile: (session: string, input: Parameters<OwnerAdapterApi['rememberStandaloneFile']>[1], opts?: OwnerCallOptions) =>
      call('rememberStandaloneFile', [session, input], opts),
    forgetStandaloneFile: (session: string, id: string, operationId: string, opts?: OwnerCallOptions) =>
      call('forgetStandaloneFile', [session, id, operationId], opts),
    async modelRequest(input: MemoryRequest, session: string, generation: number, lease?: NativeToolReadScope, options?: OwnerCallOptions) {
      await completion(session)
      const result = await call('modelRequest', lease ? [input, session, generation, serializableScope(lease)] : [input, session, generation], options)
      options?.signal?.throwIfAborted()
      if (input.op !== 'remember' && connection.status() === 'unavailable') throw new Error('Memory owner became unavailable during retrieval')
      if (lease && !lease.current()) throw new Error('Native tool execution changed before memory resolved')
      return result
    },
    finishNativeOutput: (...args: Parameters<OwnerAdapterApi['finishNativeOutput']>) => defer(args[0].session, 'finishNativeOutput', args),
    finishNativeToolRead: (...args: Parameters<OwnerAdapterApi['finishNativeToolRead']>) => defer(args[0].session, 'finishNativeToolRead', args),
    drainSession: completion,
    nativeToolEvidence: (calls: Parameters<OwnerAdapterApi['nativeToolEvidence']>[0]) => call('nativeToolEvidence', [calls]),
    async inheritNativeToolRead(lease: NativeToolReadScope, evidence: Parameters<OwnerAdapterApi['inheritNativeToolRead']>[1]) {
      await call('inheritNativeToolRead', [serializableScope(lease), evidence])
    },
    nativeSpillGoverned: (callIdentity: Parameters<OwnerAdapterApi['nativeSpillGoverned']>[0]) => call('nativeSpillGoverned', [callIdentity]),
    beginNativeSpill: (input: Parameters<OwnerAdapterApi['beginNativeSpill']>[0]) => call('beginNativeSpill', [input]),
    finishNativeSpill: (...args: Parameters<OwnerAdapterApi['finishNativeSpill']>) => call('finishNativeSpill', args),
    nativeSpillCandidates: () => call('nativeSpillCandidates', []),
    async admitNativeSpillRead(id: string, lease: NativeToolReadScope, signal?: AbortSignal) {
      const expected = scope.getStore()?.epoch ?? syncEpoch()
      const saved = serializableScope(lease)
      const currentRead = () => current(expected) && ready() && lease.current() && !signal?.aborted
      const revalidate = async () => currentRead()
        && await inEpoch(expected, () => call('admitNativeSpillRead', [id, saved], { signal })) && currentRead()
      if (!await revalidate()) throw new Error('Native spill source or scope was retired')
      return { current: currentRead, revalidate }
    },
    acquireSend, drainSends,
    handleHost: connection.callHost,
    async close() {
      await Promise.allSettled([...completions.values()].map(item => item.queue))
      await Promise.all([...new Set([...sends.values()].map(send => send.epoch))].map(drainSends))
      closed = true
      unsubscribe()
      await connection.close()
    },
  }
}
