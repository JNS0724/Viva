import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryCompute } from '../../../src/memory/contracts/memory-contract.ts'
import { isDailyMemoryStage, memoryComputeFailure } from '../../../src/memory/contracts/memory-contract.ts'
import { memorySource } from './source.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'

/** A disconnected stream can leave BlockAssembler.finish at its default stop value. */
export async function completeMemoryModel(ctx: Pick<Context, 'llm'>, job: MemoryCompute, signal: AbortSignal): Promise<string> {
  const assembler = new BlockAssembler()
  let terminal = false
  for await (const chunk of ctx.llm.stream({ provider: job.provider, model: job.model, system: job.system,
    messages: [createUserMessage({ content: [{ type: 'text', text: job.input }], source: memorySource })],
    ...(job.stage === 'extract' || job.stage === 'note' || job.stage === 'dream' ? {} : { maxTokens: 2000 }), signal })) {
    signal.throwIfAborted()
    if (terminal) throw new MemoryComputeError('call-failed')
    assembler.push(chunk)
    terminal = chunk.type === 'finish'
  }
  signal.throwIfAborted()
  if (!terminal) throw new MemoryComputeError('missing-finish')
  if (assembler.finish?.kind !== 'stop') {
    const parsed = memoryComputeFailure.safeParse(assembler.finish?.kind)
    throw new MemoryComputeError(parsed.success ? parsed.data : 'call-failed')
  }
  const text = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (!isDailyMemoryStage(job.stage) && text.length >= 20_000) throw new MemoryComputeError('oversize-reply')
  return text
}
