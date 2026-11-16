import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryHostRecovery } from '../src/backend/memory-host-recovery.ts'
import type { MemoryOwnerState } from '../src/memory/contracts/host.ts'
const initial = (): MemoryOwnerState => ({ type: 'memory_owner_state', protocol: 1, epoch: 'owner', state: 'ready', revision: 3, coreEpoch: 0, effectsRevision: 0 })

test('durable effects published after an early same-revision state still trigger host replay', async () => {
  let state = initial(), pending = false, passes = 0, erased = 0
  const recovery = createMemoryHostRecovery({ state: () => state, recover: async () => { passes++; if (pending) { erased++; pending = false } }, onError: assert.fail })
  await recovery.notify() // runtime.changed reached host before durable host effect insertion
  assert.equal(passes, 1)
  await recovery.notify()
  assert.equal(passes, 1, 'ordinary identical metadata does not create a read/recovery loop')
  pending = true
  state = { ...state, effectsRevision: 1 }
  await recovery.notify()
  assert.equal(erased, 1)
  assert.equal(passes, 2)
  recovery.close()
})

test('an effects notification during an active recovery is replayed before settling', async () => {
  let state = initial(), passes = 0, release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const recovery = createMemoryHostRecovery({ state: () => state, recover: async () => { if (++passes === 1) await wait }, onError: assert.fail })
  const first = recovery.notify()
  await Promise.resolve()
  state = { ...state, effectsRevision: 1 }
  const second = recovery.notify()
  release()
  await Promise.all([first, second])
  assert.equal(passes, 2)
  recovery.close()
})
