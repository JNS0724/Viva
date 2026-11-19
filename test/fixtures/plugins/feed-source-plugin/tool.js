// A data source plugin as Viva expects one (test/feed-source-dsh.test.ts): its read-only tool says so on its
// definition (defineTool keeps only dsh's own fields, so the hint is added to what it returns).
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'feed-source-dsh-plugin'
export const inject = ['tools']

const textOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export function apply(ctx) {
  ctx.tools.register({
    ...defineTool({
      name: 'feed_fixture_read',
      description: 'Test fixture: reads the latest entries.',
      parameters: {},
      output: textOutput,
      execute: async () => ({ text: 'fixture entries' }),
    }),
    annotations: { readOnlyHint: true },
  })
  ctx.tools.register(defineTool({
    name: 'feed_fixture_write',
    description: 'Test fixture: writes something.',
    parameters: {},
    output: textOutput,
    execute: async () => ({ text: 'written' }),
  }))
}
