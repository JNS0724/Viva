import { test } from './fixtures.ts'

test('long timeline and review @timeline', async ({ scenario }) => {
  const run = await scenario({ phase: 'timeline', bridge: 'fake' })
  await run.run('timeline')
})
