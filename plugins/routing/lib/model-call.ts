import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { FAST_SYSTEM } from './fast-lane.ts'

const name = 'viva-routing'
const FAST_MAX_TOKENS = 1500

/** One text-only call on the main agent's own route, without thinking, as the memory plugin's background pass does. */
export async function completeFastRouting(ctx: Context, agent: Agent, input: string, signal: AbortSignal, current: () => boolean): Promise<string> {
  // The route in use now: since dsh 0.2.1 agent.options is only the fallback once the user switched models.
  const { provider, model } = agent.model.current() ?? agent.options
  if (!provider || !model) throw new Error('the agent has no model route to reuse')
  if (!current()) throw new Error('Routing context changed before sending')
  const context = new AbortController()
  const unbind = ctx.on('session/event', session => { if (session === agent.session && !current()) context.abort(new Error('Routing context changed')) })
  const combined = AbortSignal.any([signal, context.signal])
  const assembler = new BlockAssembler()
  try {
    const stream = ctx.llm.stream({
      provider, model, system: FAST_SYSTEM, maxTokens: FAST_MAX_TOKENS, signal: combined, sessionId: agent.session.id,
      reasoningEffort: 'off' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['reasoningEffort']>,
      purpose: 'routing-fast-lane' as unknown as NonNullable<Parameters<Context['llm']['stream']>[0]['purpose']>,
      messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: name } as unknown as MessageSource })],
    })
    for await (const chunk of stream) {
      if (!current()) throw new Error('Routing context changed while receiving')
      assembler.push(chunk)
    }
    if (combined.aborted || !current()) throw new Error('Routing context changed before completion')
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  } finally { unbind() }
}
