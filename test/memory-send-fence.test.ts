import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'

test('mutation aborts, but waits for actual transport acknowledgement before committing', async () => {
  const fence = createMemorySendFence({ epoch: 'first', admit: () => ({ current: () => true, deadline: null }) })
  const permit = fence.acquire('attempt', { session: 'session' }, 'payload')
  let committed = false
  const mutation = fence.mutate(() => { committed = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(permit.signal.aborted, true)
  assert.equal(committed, false)
  assert.throws(() => fence.acquire('retry', { session: 'session' }, 'new-payload'))
  permit.settled(); await mutation
  assert.equal(committed, true)
  await fence.close()
})
test('expiry aborts a pending transport and old epoch cannot acquire a lease', async () => {
  const fence = createMemorySendFence({ epoch: 'current', admit: () => ({ current: () => true, deadline: Date.now() + 15 }) })
  assert.throws(() => fence.acquire('stale', { jobId: 'job' }, 'body', 'old'))
  const permit = fence.acquire('current', { jobId: 'job' }, 'body')
  await delay(25)
  assert.equal(permit.signal.aborted, true)
  assert.equal(permit.current(), false)
  assert.equal(fence.pending(), 1)
  permit.settled(); await fence.close()
})
test('concurrent mutations keep admission closed until the last mutation finishes', async () => {
  const fence = createMemorySendFence({ epoch: 'epoch', admit: () => ({ current: () => true, deadline: null }) })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const first = fence.mutate(() => undefined)
  const second = fence.mutate(() => pending)
  await first
  assert.equal(fence.blocked(), true)
  release(); await second
  assert.equal(fence.blocked(), false)
  await fence.close()
})
test('a deadline beyond the platform timer limit never expires after one millisecond', async () => {
  const fence = createMemorySendFence({ epoch: 'epoch', admit: () => ({ current: () => true, deadline: Date.now() + 30 * 86_400_000 }) })
  const permit = fence.acquire('long', { session: 'session' }, 'body')
  await delay(10)
  assert.equal(permit.signal.aborted, false)
  assert.equal(permit.current(), true)
  permit.settled()
  assert.equal(permit.current(), false)
  await fence.close()
})
