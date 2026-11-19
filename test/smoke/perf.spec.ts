import { test } from './fixtures.ts'
import { checkExpansionInteractions } from './smoke-answer-expansion.ts'

test('performance contract @perf', async ({ scenario }) => {
  const run = await scenario({ phase: 'perf', bridge: 'fake' })
  await run.run('perf')
  await test.step('long answer focus, reference links and Worker recovery', () => checkExpansionInteractions(run.current!.page))
})
