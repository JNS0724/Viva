import { test } from './fixtures.ts'

test('persisted tasks resume after a real restart @resume', async ({ scenario }) => {
  const run = await scenario({ phase: 'resume', bridge: 'real' })
  await run.run('resume-prepare')
  await run.run('resume')
})
