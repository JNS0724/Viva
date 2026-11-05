import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openAppDb, transaction } from '../src/backend/app-db.ts'
import { createEffects, RETRY_MS, type Effect, type Outcome } from '../src/backend/effects.ts'

/**
 * The effects queue (system-design §11.4) on a real app database: queued with the change that calls for it, run after,
 * kept across a restart; a try acts on the generation it was given only.
 */

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effects-'))
  const app = openAppDb({ file: path.join(dir, 'app.db') })
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  let clock = 1_000
  let timers: Array<{ run: () => void, ms: number }> = []
  const make = () => createEffects({
    db: app.db, now: () => clock,
    later: (run, ms) => { const timer = { run, ms }; timers = [...timers, timer]; return timer },
    cancel: (timer) => { timers = timers.filter((entry) => entry !== timer) },
  })
  return { app, make, effects: make(), advance: (ms: number) => { clock += ms }, timers: () => timers }
}

/** A runner that answers each effect as told, and keeps what it was given. */
function runner(answer: (effect: Effect) => Outcome) {
  const seen: Effect[][] = []
  const run = async (effects: readonly Effect[]) => {
    seen.push([...effects])
    return new Map(effects.map((effect) => [effect.key, answer(effect)]))
  }
  return { run, seen }
}

test('an effect is queued with its change: undone with it, kept with it', (t) => {
  const { app, effects } = setup(t)
  assert.throws(() => transaction(app.db, () => {
    effects.queue('report', 'task-1:run-1', { n: 1 })
    throw new Error('the change failed')
  }))
  assert.deepEqual(effects.list(), [], 'undone with its change')
  transaction(app.db, () => effects.queue('report', 'task-1:run-1', { n: 1 }))
  assert.deepEqual(effects.list().map(({ key, payload, generation }) => [key, payload, generation]), [['task-1:run-1', { n: 1 }, 1]])
})

test('done, the effect goes; not now, it stays as it was; failed, it is tried again after a growing wait', async (t) => {
  const { effects, advance, timers } = setup(t)
  effects.queue('report', 'a', {})
  effects.queue('report', 'b', {})
  effects.queue('report', 'c', {})
  const { run, seen } = runner((effect) => ({ a: 'done', b: 'wait', c: 'retry' } as const)[effect.key as 'a' | 'b' | 'c'])
  effects.runs('report', run)
  await effects.wake()
  assert.deepEqual(seen.map((batch) => batch.map((effect) => effect.key)), [['a', 'b', 'c']], 'those due, together')
  assert.deepEqual(effects.list().map(({ key, attempts }) => [key, attempts]), [['b', 0], ['c', 1]])
  assert.deepEqual(timers().map((timer) => timer.ms), [RETRY_MS[0]], 'woken again when the failed one is due')
  advance(RETRY_MS[0])
  await effects.wake()
  assert.deepEqual(seen.at(-1)?.map((effect) => effect.key), ['b', 'c'])
  assert.equal(effects.list().find((effect) => effect.key === 'c')?.attempts, 2)
  assert.deepEqual(timers().map((timer) => timer.ms), [RETRY_MS[1]])
})

test('a try settles only the generation it was given: queued again meanwhile, the new payload stays', async (t) => {
  const { effects } = setup(t)
  effects.queue('report', 'a', { n: 1 })
  let release: () => void = () => {}
  effects.runs('report', async (batch) => {
    await new Promise<void>((resolve) => { release = resolve })
    return new Map(batch.map((effect) => [effect.key, 'done' as const]))
  })
  const running = effects.wake()
  await Promise.resolve()
  effects.queue('report', 'a', { n: 2 })
  release()
  await running
  const [left] = effects.list()
  assert.deepEqual([left?.payload, left?.generation], [{ n: 2 }, 2], 'the try for generation 1 did not settle generation 2')
})

test('what is not done yet is there after a restart; a runner that fails is a try that failed', async (t) => {
  const { effects, make } = setup(t)
  effects.queue('report', 'a', { n: 1 })
  const later = make()
  later.runs('report', async () => { throw new Error('dsh away') })
  await later.wake()
  assert.deepEqual(later.list().map(({ key, attempts }) => [key, attempts]), [['a', 1]])
  effects.cancel('report', 'a')
  assert.deepEqual(later.list(), [], 'cancelled: gone whatever its generation')
})

test('woken while a pass runs, another pass follows: nothing queued meanwhile waits for the next wake', async (t) => {
  const { effects } = setup(t)
  effects.queue('report', 'a', {})
  const { run, seen } = runner(() => 'done')
  let first = true
  effects.runs('report', async (batch) => {
    if (first) { first = false; effects.queue('report', 'b', {}); void effects.wake() }
    return run(batch)
  })
  await effects.wake()
  assert.deepEqual(seen.map((batch) => batch.map((effect) => effect.key)), [['a'], ['b']])
  assert.deepEqual(effects.list(), [])
})

test('a key cancelled and queued again gets a generation never given before: a try for the old one settles nothing', async (t) => {
  const { effects } = setup(t)
  effects.queue('report', 'a', { n: 1 })
  const first = effects.list()[0].generation
  let release: () => void = () => {}
  effects.runs('report', async (batch) => {
    await new Promise<void>((resolve) => { release = resolve })
    return new Map(batch.map((effect) => [effect.key, 'done' as const]))
  })
  const running = effects.wake()
  await Promise.resolve()
  effects.cancel('report', 'a')
  effects.queue('report', 'a', { n: 2 })
  const second = effects.list()[0].generation
  assert.ok(second > first, `${second} after ${first}`)
  release()
  await running
  assert.deepEqual(effects.list().map(({ payload, generation }) => [payload, generation]), [[{ n: 2 }, second]], 'the old try did not settle the new row')
})

test('a pass the queue cannot finish (its database refusing a write) runs again after a growing wait', async (t) => {
  const { app, effects, advance, timers } = setup(t)
  effects.queue('report', 'a', {})
  effects.runs('report', async (batch) => new Map(batch.map((effect) => [effect.key, 'done' as const])))
  app.db.exec("CREATE TRIGGER refuse BEFORE DELETE ON effects BEGIN SELECT RAISE(FAIL, 'disk full'); END")
  await effects.wake()
  assert.equal(effects.list().length, 1, 'not done: the row could not go')
  assert.deepEqual(timers().map((timer) => timer.ms), [RETRY_MS[0]], 'woken again although the row is due already')
  await effects.wake()
  assert.deepEqual(timers().map((timer) => timer.ms), [RETRY_MS[1]], 'failing again: a longer wait')
  app.db.exec('DROP TRIGGER refuse')
  advance(RETRY_MS[1])
  const [timer] = timers()
  timer.run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(effects.list(), [], 'done once the database takes it')
  assert.deepEqual(timers().filter((entry) => entry !== timer), [], 'and nothing more to wake for (the one that fired aside)')
})

test('cancelling by a key\'s start takes every run of that task, and no other task\'s', (t) => {
  const { effects } = setup(t)
  for (const key of ['task-1:run-1', 'task-1:run-2', 'task-10:run-1', 'task-2:run-1']) effects.queue('report', key, {})
  effects.queue('other', 'task-1:run-1', {})
  effects.cancelStarting('report', 'task-1:')
  assert.deepEqual(effects.list().map(({ kind, key }) => `${kind} ${key}`), ['report task-10:run-1', 'report task-2:run-1', 'other task-1:run-1'])
})
