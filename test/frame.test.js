import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrameScheduler, FRAME_DEADLINE_MS } from '../src/renderer/view/frame.ts'
import { createLayoutQueue } from '../src/renderer/view/reconcile.ts'

function scheduler() {
  const frames = [], cancelled = []
  const schedule = createFrameScheduler({ request: run => frames.push(run), cancel: id => cancelled.push(id), now: () => 123 })
  return { schedule, frames, cancelled }
}

test('a paused animation frame falls back to a timer once, and a late frame cannot repeat the work', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { schedule, frames, cancelled } = scheduler(), times = []
  schedule(time => times.push(time))
  t.mock.timers.tick(FRAME_DEADLINE_MS - 1)
  assert.deepEqual(times, [])
  t.mock.timers.tick(1)
  assert.deepEqual(times, [123])
  assert.deepEqual(cancelled, [1])
  frames[0](456)
  assert.deepEqual(times, [123])
})

test('a normal frame cancels its deadline, and cancellation stops both paths', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { schedule, frames } = scheduler(), times = []
  schedule(time => times.push(time))
  frames[0](10)
  const cancel = schedule(time => times.push(time))
  cancel(); frames[1](20)
  t.mock.timers.tick(FRAME_DEADLINE_MS * 2)
  assert.deepEqual(times, [10])
})

test('layout deadlines coalesce updates and keep all reads before writes when no frames arrive', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { schedule, frames } = scheduler(), seen = [], a = {}, b = {}
  const queue = createLayoutQueue(schedule)
  queue(a, () => { throw Error('stale measurement') })
  queue(a, () => { seen.push('read a'); return () => { seen.push('write a'); queue(a, () => { seen.push('next') }) } })
  queue(b, () => { seen.push('read b'); return () => { seen.push('write b') } })
  t.mock.timers.tick(FRAME_DEADLINE_MS)
  assert.deepEqual(seen, ['read a', 'read b', 'write a', 'write b'])
  frames[0](1)
  t.mock.timers.tick(FRAME_DEADLINE_MS)
  assert.deepEqual(seen, ['read a', 'read b', 'write a', 'write b', 'next'])
})
