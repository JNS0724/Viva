import { test } from './fixtures.ts'

test('memory, capabilities and background tasks @memory', async ({ scenario }) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  await run.run('memory')
})
