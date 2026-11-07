import { test } from './fixtures.ts'

test('walkthrough and persisted relaunch @walkthrough @relaunch', async ({ scenario }) => {
  const run = await scenario({ phase: 'walkthrough', bridge: 'fake' })
  await run.run('walkthrough')
  await run.run('relaunch')
})
