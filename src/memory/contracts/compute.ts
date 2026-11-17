import type { MemoryComputeFailure } from './memory-contract.ts'
import type { MemoryModelJob, MemoryToolExecutor } from './service.ts'

/** Local capability, never serialized over the host protocol. Core owns every tool execution. */
export interface MemoryComputeTools {
  tools: MemoryModelJob['tools']
  executeTool: MemoryToolExecutor
}

export class MemoryComputeError extends Error {
  readonly reason: MemoryComputeFailure | 'oversize-reply' | 'missing-reply'

  constructor(reason: MemoryComputeError['reason']) {
    super('memory model computation did not finish')
    this.reason = reason
  }
}
