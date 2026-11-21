import { CONTEXT_WINDOW_EXCEEDED_CODE, BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { withOperation } from '../../../src/diagnostics/node/context.ts'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { MemoryCompute } from '../../../src/memory/contracts/memory-contract.ts'
import { isDailyMemoryStage, memoryComputeFailure } from '../../../src/memory/contracts/memory-contract.ts'
import { memorySource } from './source.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'
import type { MemoryComputeTools } from '../../../src/memory/contracts/compute.ts'

export function memoryProviderFailure(code: unknown) {
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return new MemoryComputeError('context-window-exceeded')
  if (code === 'TIMEOUT') return new MemoryComputeError('timeout')
}

/** Each job owns native message/reasoning replay; no state is shared across dream units. */
export async function completeMemoryModel(ctx: Pick<Context, 'llm'>, job: MemoryCompute, signal: AbortSignal,
  capability?: MemoryComputeTools): Promise<string> {
  const messages: Message[] = [createUserMessage({ content: [{ type: 'text', text: job.input }], source: memorySource })]
  const tools: ToolSchema[] = (capability?.tools ?? []).map(tool => ({ name: tool.name, description: tool.description,
    parameters: z.record(z.string(), z.unknown()).parse(tool.schema) }))
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new MemoryComputeError('call-failed')
  const names = new Set(tools.map(tool => tool.name))
  const seenCalls = new Set<string>()
  const maxToolRounds = 12
  for (let round = 0; ; round++) {
    signal.throwIfAborted()
    const assembler = new BlockAssembler()
    let terminal = false
    for await (const chunk of ctx.llm.stream({ provider: job.provider, model: job.model, system: job.system,
      messages, ...(tools.length ? { tools } : {}),
      ...(job.stage === 'note' || job.stage === 'dream' ? {} : { maxTokens: 2000 }), signal })) {
      signal.throwIfAborted()
      if (terminal) throw new MemoryComputeError('call-failed')
      assembler.push(chunk)
      terminal = chunk.type === 'finish'
    }
    signal.throwIfAborted()
    // BlockAssembler defaults to stop even if the network ended before its terminal event.
    if (!terminal) throw new MemoryComputeError('missing-finish')
    const blocks = assembler.blocks()
    const calls = blocks.filter(block => block.type === 'tool-call')
    if (assembler.finish?.kind === 'stop' && !calls.length) {
      const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      if (!isDailyMemoryStage(job.stage) && text.length >= 20_000) throw new MemoryComputeError('oversize-reply')
      return text
    }
    if (assembler.finish?.kind !== 'tool-calls' || !capability || !calls.length) {
      if (assembler.finish?.kind === 'error') {
        const error = memoryProviderFailure(assembler.finish.failure.code)
        if (error) throw error
      }
      const parsed = memoryComputeFailure.safeParse(assembler.finish?.kind)
      throw new MemoryComputeError(parsed.success ? parsed.data : 'call-failed')
    }
    if (new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => seenCalls.has(call.id)) || round >= maxToolRounds) {
      throw new MemoryComputeError('call-failed')
    }
    for (const call of calls) seenCalls.add(call.id)
    messages.push(assembler.message({ provider: job.provider, model: job.model,
      ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) }))
    for (const call of calls) {
      signal.throwIfAborted()
      let content = 'Tool invocation rejected: unknown tool or invalid JSON arguments.'
      let isError = true
      let input: z.infer<ReturnType<typeof z.json>> | undefined
      try { input = z.json().parse(JSON.parse(call.arguments)) } catch { /* The model can repair its arguments. */ }
      if (names.has(call.name) && input !== undefined) {
        const result = await withOperation('tool', () => capability.executeTool({ callId: call.id, name: call.name, input }), {
          identities: { requestId: call.id, methodId: call.name, jobId: job.id, generation: job.generation } })
        signal.throwIfAborted()
        if (result.callId !== call.id) throw new MemoryComputeError('call-failed')
        content = result.content
        isError = result.state !== 'completed'
      }
      // executeTool records dynamic dependencies before its result can enter the next fenced send.
      messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: content }], isError }))
    }
  }
}
