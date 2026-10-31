import { test } from './fixtures.ts'

test('setup and source management @setup', async ({ scenario }) => {
  const run = await scenario({ phase: 'setup', bridge: 'fake' })
  await run.run('setup')
})

test('walkthrough and persisted relaunch @walkthrough @relaunch', async ({ scenario }) => {
  const run = await scenario({ phase: 'walkthrough', bridge: 'fake' })
  await run.run('walkthrough')
  await run.run('relaunch')
})

test('memory and resumable tasks @memory @resume', async ({ scenario }) => {
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  await run.run('memory')
  await run.run('resume')
})

test('long timeline and review @timeline', async ({ scenario }) => {
  const run = await scenario({ phase: 'timeline', bridge: 'fake' })
  await run.run('timeline')
})

test('system and switched languages @language', async ({ scenario }) => {
  const run = await scenario({ phase: 'language', bridge: 'fake' })
  await run.run('language')
})
