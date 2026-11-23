import type { MemoryComputeTools } from '../contracts/compute.ts'
import type { MemoryRequest } from '../contracts/memory-contract.ts'
import type { NativeToolReadCut, NativeToolReadScope } from './native-tool-reads.ts'
import type { openMemoryOwner } from './owner.ts'

type Owner = ReturnType<typeof openMemoryOwner>
export type OwnerSendOrigin = Parameters<Owner['acquireSend']>[1]
export type RemoteToolReadScope = Pick<NativeToolReadScope, 'call' | 'calls'> & { readCut?: NativeToolReadCut }
export type OwnerActiveTurn = { sessionId: string, turn: number }
export type OwnerCallOptions = { signal?: AbortSignal, budgetMs?: number, waitForCompletion?: boolean }
export type OwnerAdapterApi = Pick<Owner,
  'noteInheritedNativeCut' | 'receiveSource'
  | 'prepareContextRecovery' | 'bindContextRecovery' | 'rememberStandaloneFile'
  | 'finishNativeOutput' | 'finishNativeToolRead' | 'nativeToolEvidence' | 'nativeSpillGoverned'
  | 'beginNativeSpill' | 'finishNativeSpill' | 'nativeSpillCandidates'
  | 'intakeWatermark' | 'advanceIntake'
> & {
  forgetStandaloneFile(session: string, id: string, operationId: string): ReturnType<Owner['forgetStandaloneFile']>
  initializeSession(input: Parameters<Owner['initializeSession']>[0]): Promise<void>
  registerDerived(input: Parameters<Owner['registerDerived']>[0]): Promise<void>
  completeTurn(input: Parameters<Owner['completeTurn']>[0]): Promise<void>
  sessionView(session: string): Promise<{
    contextGeneration: ReturnType<Owner['contextGeneration']>
    contextRecovery: ReturnType<Owner['contextRecovery']>
    needsContextRecovery: boolean
    nativeContextRewritten: boolean
    allowsSession: boolean
    sessionContext: ReturnType<Owner['sessionContext']>
  }>
  snapshot(...args: Parameters<Owner['dispatch']['snapshot']>): ReturnType<Owner['dispatch']['snapshot']>
  commitContextRecovery(input: Parameters<Owner['commitContextRecovery']>[0], checkId: string): ReturnType<Owner['commitContextRecovery']>
  inheritNativeToolRead(scope: RemoteToolReadScope, evidence: Parameters<Owner['inheritNativeToolRead']>[1]): void
  admitNativeSpillRead(id: string, scope: RemoteToolReadScope): Promise<boolean>
  modelRequest(input: MemoryRequest, session: string, generation: number, scope?: RemoteToolReadScope, unknownProject?: boolean): ReturnType<Owner['runtime']['handleModelRequest']>
  acquireSend(id: string, origin: OwnerSendOrigin, digest: string): Promise<void>
  outputCurrent(origin: OwnerSendOrigin): Promise<boolean>
  recordSendBody(id: string): Promise<void>
  settleSend(id: string): void
  setRoute(route: { provider: string, model: string } | null): void
  reconcileActiveTurns(turns: readonly OwnerActiveTurn[]): void
  computeTool(jobId: string, input: Parameters<MemoryComputeTools['executeTool']>[0]): ReturnType<MemoryComputeTools['executeTool']>
}

export type OwnerAdapterCaller = {
  callAdapter<M extends keyof OwnerAdapterApi>(
    method: M, args: Parameters<OwnerAdapterApi[M]>, options?: OwnerCallOptions
  ): Promise<Awaited<ReturnType<OwnerAdapterApi[M]>>>
}
