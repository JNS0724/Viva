// A host-side tool, imported the way community plugins import dsh: by package name.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'demo-dsh-plugin'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'demo_dsh_echo',
    description: 'Test fixture: echoes its input.',
    parameters: { text: { type: 'string', description: 'what to echo' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => ({ text: String(args?.text ?? '') }),
  }))
}
