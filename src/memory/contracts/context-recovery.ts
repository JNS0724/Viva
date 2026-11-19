/** Trusted host context replacement protocol, independent of native session/event formats.
 * A persisted acknowledgement means the complete model-visible non-system history was replaced.
 * Original audit/UI events may remain, but must not be replayed into active model history. */
export type MemoryContextRecoveryTicket = {
  ticketId: string
  sessionId: string
  generation: number
  baseSurfaceHash: string
  state: 'prepared' | 'bound' | 'committed'
  retainedMessageIds: string[]
  replacementMessageId?: string
  replacementHash?: string
}
export type PrepareMemoryContextRecovery = {
  sessionId: string
  baseSurfaceHash: string
  nativeParentSessionId?: string
  /** Original native message content, used transiently to authenticate its existing owner identity. */
  candidates: readonly { messageId: string, content: string, contentDigest?: string, inherited?: true }[]
}
export type BindMemoryContextRecovery = { ticketId: string, replacementMessageId: string, replacementHash: string }
export type CommitMemoryContextRecovery = BindMemoryContextRecovery & { baseSurfaceHash: string, persisted: true }
export interface MemoryContextRecoveryOwner {
  contextGeneration(sessionId: string): number
  contextRecovery(sessionId: string): MemoryContextRecoveryTicket | null
  needsContextRecovery(sessionId: string): boolean
  prepareContextRecovery(input: PrepareMemoryContextRecovery): Promise<MemoryContextRecoveryTicket>
  bindContextRecovery(input: BindMemoryContextRecovery): MemoryContextRecoveryTicket
  commitContextRecovery(input: CommitMemoryContextRecovery, stillCurrent: () => boolean | Promise<boolean>): Promise<MemoryContextRecoveryTicket>
}
