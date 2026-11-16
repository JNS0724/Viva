import type { MemoryRuntime } from '../../../src/memory/core/memory-runtime.ts'
import type { createMemoryCoordination } from '../../../src/memory/core/coordination.ts'
import type { createMemoryDispatch } from '../../../src/memory/core/memory-dispatch.ts'

/** Adapter-owned identities and chronology, never inferred from model-visible prose. */
export type ReceivedSource = {
  contentDigest?: string
  nativeMessageDigest?: string
  contextGeneration?: number
  sessionId: string
  messageId: string
  text: string
  at: number
  timezone: string
  turn: number
  step: number
  eventSeq?: number
  admitted: boolean
  live?: boolean
  inherited: boolean
  project?: string
  derived?: boolean
}
export type MemoryControlReceipt = { operationId: string, kind: 'stop' | 'correct', targetId: number }
export type SourceReceipt = { sourceId: string, text: string, handledIntent?: boolean, retrievalQuery?: string, controlReceipt?: MemoryControlReceipt }
export type CompletedTurn = {
  contextGeneration?: number
  sessionId: string
  turn: number
  eventSeq: number
  sourceIds: readonly string[]
  assistant: string
  completed: boolean
  at: number
  timezone: string
}
export type DerivedSource = {
  /** Set only by the native adapter after matching a captured causal delivery receipt. */
  verifiedDelivery?: true
  contentDigest?: string
  nativeMessageDigest?: string
  nativeUserSource?: string
  contextGeneration?: number
  senderContextGeneration?: number
  sessionId: string
  messageId: string
  eventSeq?: number
  sourceIds: readonly string[]
  inherited?: boolean
  senderSessionId?: string
}
export type SessionContext = Parameters<MemoryRuntime['handle']>[1]
export interface PluginMemoryOwner {
  runtime: MemoryRuntime
  dispatch: ReturnType<typeof createMemoryDispatch>
  coordination: ReturnType<typeof createMemoryCoordination>
  epoch: string
  ready(): boolean
  status(): 'ready' | 'recovering' | 'unavailable'
  recover(): Promise<void>
  initializeSession(input: { sessionId: string, cwd?: string, parentSessionId?: string }): void
  noteInheritedNativeCut?(input: Pick<ReceivedSource, 'sessionId' | 'messageId' | 'text' | 'contentDigest' | 'inherited'>): boolean
  receiveSource(input: ReceivedSource): Promise<SourceReceipt>
  completeTurn(input: CompletedTurn): Promise<void>
  sessionContext(sessionId: string): SessionContext
  registerDerived(input: DerivedSource): Promise<void> | void
  close(): Promise<void>
}
