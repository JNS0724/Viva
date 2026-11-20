import { CONTEXT_WINDOW_EXCEEDED_CODE, BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryCompute } from '../../../src/memory/contracts/memory-contract.ts'
import { isDailyMemoryStage, memoryComputeFailure } from '../../../src/memory/contracts/memory-contract.ts'
import { memorySource } from './source.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'

export function memoryProviderFailure(code: unknown) {
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return new MemoryComputeError('context-window-exceeded')
  if (code === 'TIMEOUT') return new MemoryComputeError('timeout')
}

/** Single-turn structured completion for background memory jobs. */
export async function completeMemoryModel(ctx: Pick<Context, 'llm'>, job: MemoryCompute, signal: AbortSignal): Promise<string> {
  const messages: Message[] = [createUserMessage({ content: [{ type: 'text', text: job.input }], source: memorySource })]
  signal.throwIfAborted()
  const assembler = new BlockAssembler()
  let terminal = false
  for await (const chunk of ctx.llm.stream({ provider: job.provider, model: job.model, system: job.system,
    messages, ...(job.stage === 'note' || job.stage === 'dream' ? {} : { maxTokens: 2000 }), signal })) {
    signal.throwIfAborted()
    if (terminal) throw new MemoryComputeError('call-failed')
    assembler.push(chunk)
    terminal = chunk.type === 'finish'
  }
  signal.throwIfAborted()
  // BlockAssembler defaults to stop even if the network ended before its terminal event.
  if (!terminal) throw new MemoryComputeError('missing-finish')
  const blocks = assembler.blocks()
  if (assembler.finish?.kind === 'stop' && !blocks.some(block => block.type === 'tool-call')) {
    const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    if (!isDailyMemoryStage(job.stage) && text.length >= 20_000) throw new MemoryComputeError('oversize-reply')
    return text
  }
  if (assembler.finish?.kind === 'error') {
    const error = memoryProviderFailure(assembler.finish.failure.code)
    if (error) throw error
  }
  const parsed = memoryComputeFailure.safeParse(assembler.finish?.kind)
  throw new MemoryComputeError(parsed.success ? parsed.data : 'call-failed')
}
