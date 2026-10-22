import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_TIMEOUT_MS, replies, startHarness } from './fixtures/dsh-harness.js'

/** A question sent while a model switch is still on its way is answered, not lost (reported on Windows). */

test('a question sent during a model switch still gets its answer', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, bridge } = await startHarness(t)
  const agent = bridge()
  const info = await agent.start()
  const other = info.models.find((model) => model.value !== info.modelValue)
  assert.ok(other, `a second model to switch to: ${JSON.stringify(info.models)}`)

  const switching = agent.setConfig('model', other.value)
  const asked = agent.prompt('你好')
  const [switched] = await Promise.all([switching, asked])

  assert.equal(switched.modelValue, other.value)
  assert.deepEqual(events.filter((event) => event.type === 'error'), [])
  assert.deepEqual(events.filter((event) => event.type === 'turn_end').map((event) => event.stopReason), ['end_turn'])
  assert.match(replies(events).join(''), /你好/, 'the question was answered')
})
