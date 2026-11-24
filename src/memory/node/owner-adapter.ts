import type { MemoryComputeTools } from '../contracts/compute.ts'
import type { MemoryRequest } from '../contracts/memory-contract.ts'
import type { openMemoryOwner } from './owner.ts'

type Owner = ReturnType<typeof openMemoryOwner>
export type OwnerActiveTurn = { sessionId: string, turn: number }
export type OwnerCallOptions = { signal?: AbortSignal, budgetMs?: number, deadlineAt?: number, waitForCompletion?: boolean }
export type OwnerAdapterApi = Pick<Owner, 'receiveSource' | 'intakeWatermark' | 'advanceIntake' | 'bindIntakeSession' | 'rememberStandaloneFile'> & {
  forgetStandaloneFile(session: string, id: string, operationId: string): ReturnType<Owner['forgetStandaloneFile']>
  completeTurn(input: Parameters<Owner['completeTurn']>[0]): ReturnType<Owner['completeTurn']>
  sidecarRequest(input: MemoryRequest, cwd?: string | null, originals?: readonly { id: string, text: string }[]): Promise<string | null>
  setRoute(route: { provider: string, model: string } | null): void
  computeTool(jobId: string, input: Parameters<MemoryComputeTools['executeTool']>[0]): ReturnType<MemoryComputeTools['executeTool']>
}

export type OwnerAdapterCaller = {
  callAdapter<M extends keyof OwnerAdapterApi>(
    method: M, args: Parameters<OwnerAdapterApi[M]>, options?: OwnerCallOptions
  ): Promise<Awaited<ReturnType<OwnerAdapterApi[M]>>>
}
