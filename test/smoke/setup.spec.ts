import { test } from './fixtures.ts'

test('setup and source management @setup', async ({ scenario }) => {
  const run = await scenario({ phase: 'setup', bridge: 'fake' })
  await run.run('setup')
})
