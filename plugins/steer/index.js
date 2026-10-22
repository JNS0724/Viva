/**
 * viva-steer: what the user says while the agent works reaches the turn that is running, at its next step,
 * instead of waiting for it to end. dsh's agents take such steering (`agent.steer`), but its ACP front end
 * runs one prompt at a time and refuses a second; so the app hands the words to this plugin over the IPC
 * channel it opened when it started dsh (lib/channel.js), and the plugin gives them to the session's agent.
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createSteerChannel, REASONS } from './lib/channel.js'
import { OFFERED, OFFER_TOOL } from './lib/offer.js'
import { ROUTE_MAX_TOKENS, ROUTE_SYSTEM, ROUTE_TIMEOUT_MS, routeInput, routeOf } from './lib/route.js'

export const name = 'viva-steer'
export const inject = ['agents', 'tools', 'llm']
export const Config = z.object({})

const log = (message) => process.stderr.write(`[${name}] ${message}\n`)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} _config
 * @param {NodeJS.Process} [port] the channel to the app (tests pass their own)
 */
export function apply(ctx, _config, port = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: nothing to steer from')
    return
  }
  /** Only a running turn takes steering; an idle agent would start a turn of its own, outside the app's prompt. */
  function steer(sessionId, text) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) return REASONS.missing
    if (agent.status !== 'running') return REASONS.idle
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return null
  }
  /** Asks the session's own model where words typed now would go (lib/route.js); null when it cannot say. */
  async function route(sessionId, words, text) {
    const agent = ctx.agents.get(sessionId)
    const { provider, model } = agent?.options ?? {}
    if (!provider || !model) return null
    const assembler = new BlockAssembler()
    const stream = ctx.llm.stream({
      provider,
      model,
      system: ROUTE_SYSTEM,
      messages: [createUserMessage({ content: [{ type: 'text', text: routeInput(words, text) }], source: { kind: name } })],
      maxTokens: ROUTE_MAX_TOKENS,
      sessionId,
      purpose: 'steer-route',
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
    })
    for await (const chunk of stream) assembler.push(chunk)
    return routeOf(assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join(''))
  }

  const channel = createSteerChannel(port, steer, log, route)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'steer channel')

  // A job that will take long, said before it starts: the window offers 放到后台 beside it (lib/offer.js).
  ctx.tools.register(defineTool({
    ...OFFER_TOOL,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async () => ({ text: OFFERED }),
  }))
}
