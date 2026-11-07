import { test } from './fixtures.ts'

test('system and switched languages @language', async ({ scenario }) => {
  const run = await scenario({ phase: 'language', bridge: 'fake' })
  await run.run('language')
})
