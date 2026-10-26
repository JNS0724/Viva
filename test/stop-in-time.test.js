import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STOP_GRACE_MS, stopInTime } from '../src/main/stop-in-time.ts'

test('a task that stops when asked is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let running = true
  const gaveUp = []
  await stopInTime({ cancel: async () => { running = false }, stillRunning: () => running, giveUp: () => gaveUp.push('let go') })
  t.mock.timers.tick(STOP_GRACE_MS * 2)
  assert.deepEqual(gaveUp, [])
})

test('a task that ends within the grace period is left alone too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let running = true
  const gaveUp = []
  await stopInTime({ cancel: async () => {}, stillRunning: () => running, giveUp: () => gaveUp.push('let go') })
  t.mock.timers.tick(STOP_GRACE_MS - 1)
  running = false
  t.mock.timers.tick(1)
  assert.deepEqual(gaveUp, [])
})

test('a task still going after the grace period is let go, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gaveUp = []
  // As dsh with a PowerShell command it does not stop: the cancel is sent, and nothing ends.
  await stopInTime({ cancel: async () => {}, stillRunning: () => true, giveUp: () => gaveUp.push('let go') })
  t.mock.timers.tick(STOP_GRACE_MS - 1)
  assert.deepEqual(gaveUp, [], 'not before the grace period is over')
  t.mock.timers.tick(1)
  assert.deepEqual(gaveUp, ['let go'])
  t.mock.timers.tick(STOP_GRACE_MS * 3)
  assert.deepEqual(gaveUp, ['let go'])
})

test('a cancel that fails is no reason to keep waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gaveUp = []
  await stopInTime({ cancel: async () => { throw new Error('dsh is gone') }, stillRunning: () => true, giveUp: () => gaveUp.push('let go') })
  t.mock.timers.tick(STOP_GRACE_MS)
  assert.deepEqual(gaveUp, ['let go'])
})
