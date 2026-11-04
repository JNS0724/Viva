import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackendKeeper } from '../src/main/backend-keeper.ts'

type Fake = { id: number, died: (code: number | null) => void, shutdown: () => Promise<void>, stopped: boolean }

/** A keeper over fake backends, with its timers run by hand and its clock set by the test. */
function keeperOf({ failAttempts = [] as number[] } = {}) {
  let clock = 1_000_000
  let spawned = 0
  let attempts = 0
  const backends: Fake[] = []
  const timers: Array<{ at: number, run: () => void }> = []
  const ups: Array<[number, boolean]> = []
  const gaveUp: string[] = []
  const keeper = createBackendKeeper<Fake>({
    spawn: async (onExit) => {
      attempts += 1
      if (failAttempts.includes(attempts)) throw new Error('could not start')
      spawned += 1
      const fake: Fake = { id: spawned, stopped: false, died: (code) => onExit(code, null), shutdown: async () => { fake.stopped = true } }
      backends.push(fake)
      return fake
    },
    onUp: (backend, restarted) => { ups.push([backend.id, restarted]) },
    onGaveUp: (why) => { gaveUp.push(why) },
    now: () => clock,
    schedule: (run, ms) => { timers.push({ at: clock + ms, run }) },
    waitMs: 50,
  })
  const advance = async (ms: number) => {
    clock += ms
    for (const timer of timers.splice(0).filter((one) => one.at <= clock)) timer.run()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { keeper, backends, ups, gaveUp, advance, timers }
}

test('the backend is started once, and a call gets it', async () => {
  const { keeper, ups } = keeperOf()
  const first = await keeper.start()
  assert.deepEqual(ups, [[1, false]])
  assert.equal(await keeper.get(), first)
  assert.equal(keeper.running(), first)
})

test('a backend that ends on its own is started again after a while; calls meanwhile wait for the new one', async () => {
  const { keeper, backends, ups, advance } = keeperOf()
  await keeper.start()
  backends[0].died(1)
  assert.equal(keeper.running(), null)
  const waiting = keeper.get()
  await advance(1_000)
  const second = await waiting
  assert.equal(second.id, 2)
  assert.deepEqual(ups, [[1, false], [2, true]], 'the new one is up, as a restart')
})

test('a call that waits longer than it may is told the backend is restarting', async () => {
  const { keeper, backends } = keeperOf()
  await keeper.start()
  backends[0].died(1)
  await assert.rejects(keeper.get(), /restarting/)
})

test('crashing again and again, it is given up, once', async () => {
  const { keeper, backends, gaveUp, advance } = keeperOf()
  await keeper.start()
  for (const delay of [1_000, 3_000, 10_000]) {
    backends[backends.length - 1].died(1)
    await advance(delay)
  }
  assert.equal(backends.length, 4)
  backends[3].died(1)
  assert.equal(gaveUp.length, 1)
  assert.match(gaveUp[0], /exit 1/)
  await assert.rejects(keeper.get(), /stopped/)
})

test('a restart that cannot start counts as another crash and is tried again', async () => {
  const { keeper, backends, ups, advance } = keeperOf({ failAttempts: [2] })
  await keeper.start()
  backends[0].died(1)
  await advance(1_000)
  assert.deepEqual(ups.map(([id]) => id), [1], 'the second start failed')
  await advance(3_000)
  assert.deepEqual(ups.map(([id]) => id), [1, 2], 'the third went')
})

test('shutting down stops the backend and nothing is restarted after it', async () => {
  const { keeper, backends, ups, timers } = keeperOf()
  await keeper.start()
  await keeper.shutdown()
  assert.equal(backends[0].stopped, true)
  backends[0].died(0)
  assert.equal(timers.length, 0)
  assert.deepEqual(ups, [[1, false]])
})
