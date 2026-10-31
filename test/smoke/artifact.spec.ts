import { test, expect } from './fixtures.ts'

test('installed artifact completes memory and restart acceptance', async ({ scenario }) => {
  expect(process.env.VIVA_SMOKE_EXECUTABLE, 'Set VIVA_SMOKE_EXECUTABLE to the installed application').toBeTruthy()
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  await run.run('memory')
  await run.run('resume')
})
