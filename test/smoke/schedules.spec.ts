import { test } from './fixtures.ts'

test('scheduled work runs when its real timer is due @schedules', async ({ scenario }) => {
  const run = await scenario({ phase: 'schedules', bridge: 'real' })
  await run.run('schedules')
})
