/**
 * viva-config: the model sets up the app's MCP servers and skills from the conversation ("帮我接入 GitHub",
 * "把这个做法存成 skill"). Every change is asked of the user first through dsh's approval card; the app then
 * performs it (src/main/config-channel.js), over the IPC channel it opened when it started dsh. Keys never
 * pass through here: the model names them, the user types them into the app's window.
 * Loaded by the app's dsh profile (src/main/dsh-profile.js).
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createConfigChannel } from './lib/channel.ts'
import { CONFIG_TOOLS } from './lib/tools.ts'

export const name = 'viva-config'
export const inject = ['tools']
export const Config = z.object({})

const log = (message) => process.stderr.write(`[${name}] ${message}\n`)

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} _config
 * @param {NodeJS.Process} [port] the channel to the app (tests pass their own)
 */
export function apply(ctx, _config, port = process) {
  if (typeof port.send !== 'function') {
    log('dsh was not started by the app: the config tools are left out')
    return
  }
  const channel = createConfigChannel(port, log)
  // The channel must not keep dsh running once its input closes.
  port.channel?.unref?.()
  ctx.effect(() => () => channel.close(), 'config channel')

  const byName = new Map(CONFIG_TOOLS.map((tool) => [tool.name, tool]))
  // Reading is free; every change waits for the user's yes on the approval card.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = byName.get(exec.name)
    if (!tool?.mutating) return next()
    const reason = tool.reason(exec.arguments ?? {})
    return { kind: 'ask', reason, displayReason: { zh: reason, en: reason } }
  })

  for (const tool of CONFIG_TOOLS) {
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args, exec) => ({ text: await channel.request(tool.op, args, String(exec?.agent?.session?.id ?? ''), exec?.signal) }),
    }))
  }
}
