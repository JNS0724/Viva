import { test } from './fixtures.ts'

test('performance contract @perf', async ({ scenario }) => {
  const run = await scenario({ phase: 'perf', bridge: 'fake' })
  await run.run('perf')
})
