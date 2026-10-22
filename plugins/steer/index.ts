/**
 * viva-steer: what the user says while the agent works reaches the turn that is running, at its next step,
 * instead of waiting for it to end. dsh's agents take such steering (`agent.steer`), but its ACP front end
 * runs one prompt at a time and refuses a second; so the app hands the words to this plugin over the IPC
 * channel it opened when it started dsh (lib/channel.js), and the plugin gives them to the session's agent.
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createSteerChannel, REASONS } from './lib/channel.ts'
import { OFFERED, OFFER_TOOL } from './lib/offer.ts'

export const name = 'viva-steer'
export const inject = ['agents', 'tools']
export const Config = z.object({})

const log = (message: string) => process.stderr.write(`[${name}] ${message}\n`)

/** @param port the channel to the app (tests pass their own) */
export function apply(ctx: Context, _config: object, port: NodeJS.Process = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: nothing to steer from')
    return
  }
  /** Only a running turn takes steering; an idle agent would start a turn of its own, outside the app's prompt. */
  function steer(sessionId: string, text: string) {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!agent) return REASONS.missing
    if (agent.status !== 'running') return REASONS.idle
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    return null
  }
  const channel = createSteerChannel({ send: port.send.bind(port), on: port.on.bind(port), off: port.off.bind(port) }, steer, log)
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
