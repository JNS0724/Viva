import type { MemoryComputeFailure } from './memory-contract.ts'

export class MemoryComputeError extends Error {
  readonly reason: MemoryComputeFailure | 'oversize-reply' | 'missing-reply' | 'context-window-exceeded'

  constructor(reason: MemoryComputeError['reason']) {
    super('memory model computation did not finish')
    this.reason = reason
  }
}
