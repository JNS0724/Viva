import { test } from './fixtures.ts'

test('memory and resumable tasks @memory @resume', async ({ scenario }) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  await run.run('memory')
  await run.run('resume')
})
