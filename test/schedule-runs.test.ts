import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { transaction } from '../src/backend/app-db.ts'
import { RETRY_MS as HOLD_MS } from '../src/backend/effects.ts'
import { openFeedStore, type FeedItem } from '../src/backend/feed-store.ts'
import type { Apply } from '../src/backend/journal.ts'
import { MAX_ATTEMPTS, MAX_WAIT_MS, RETRY_MS, createScheduleRuns } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'
import type { RunResult } from '../src/backend/unattended-runs.ts'

/** Schedules run when due (schedule-runs.ts): one timer, runs kept with what was taken, each answer one item in 动态. */

const at = (iso: string) => Date.parse(iso)
type Timer = { run: () => void, ms: number }
const UNAVAILABLE: RunResult = { ok: false, problem: 'unavailable', unavailable: true }
const ONCE = { kind: 'at', at: '2026-11-06T11:00:00+08:00' } as const

function setup(answers: Array<RunResult | Promise<RunResult>> = []) {
  let now = at('2026-11-06T10:00:00+08:00')
  const db = new DatabaseSync(':memory:')
  const store = openScheduleStore({ db, now: () => now, newId: () => 's1' })
  const feed = openFeedStore({ db, now: () => now })
  const asked: Array<{ prompt: string, cwd: string }> = []
  const kept: FeedItem[] = []
  let delivered = 0
  let timers: Timer[] = []
  let changes = 0
  let queue = [...answers]
  /** Changes of these kinds fail, as many times as given. */
  let failing: Record<string, number> = {}
  const apply: Apply = (kind, _data, write) => {
    if (failing[kind]) {
      failing = { ...failing, [kind]: failing[kind] - 1 }
      throw new Error('database is locked')
    }
    return { value: transaction(db, write) }
  }
  const make = () => createScheduleRuns({
    db, apply, store, feed,
    run: async (prompt, cwd) => {
      asked.push({ prompt, cwd })
      const [next, ...rest] = queue
      queue = rest
      return next ?? { ok: true, text: `答：${prompt}` }
    },
    keep: (item) => { kept.push(item) },
    delivered: () => { delivered++ },
    changed: () => { changes++ },
    now: () => now,
    later: (run, ms) => {
      const timer = { run, ms }
      timers = [...timers, timer]
      return timer
    },
    cancel: (timer) => { timers = timers.filter((item) => item !== (timer as unknown as Timer)) },
  })
  return {
    db, store, feed, asked, kept, make,
    delivered: () => delivered,
    timers: () => timers,
    /** Fires the one timer set. */
    fire: () => {
      const [timer] = timers
      timers = timers.slice(1)
      timer.run()
    },
    /** Lets the runs' promises settle. */
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    changes: () => changes,
    go: (iso: string) => { now = at(iso) },
    answer: (more: RunResult[]) => { queue = [...queue, ...more] },
    fail: (kind: string, times: number) => { failing = { ...failing, [kind]: times } },
    runs: () => (db.prepare('SELECT COUNT(*) AS n FROM schedule_runs').get() as { n: number }).n,
  }
}

test('one timer, for the soonest; due, the prompt runs in the folder it was made in, its answer one item, its notice kept with it', async () => {
  const { store, asked, kept, delivered, timers, fire, make, settle, go, changes } = setup()
  store.create({ title: '报销', prompt: '提醒我交报销单', cwd: '/work/a', rule: { kind: 'at', at: '2026-11-06T16:00:00+08:00' } })
  make().arm()
  assert.deepEqual(timers().map((timer) => timer.ms), [MAX_WAIT_MS], 'six hours away: it looks again in an hour, never longer')
  go('2026-11-06T16:00:00+08:00')
  fire()
  await settle()
  assert.deepEqual(asked, [{ prompt: '提醒我交报销单', cwd: '/work/a' }], 'its own folder, whatever the window is on')
  assert.deepEqual(kept.map((item) => [item.source, item.key, item.title, item.body]), [['schedule', 's1@2026-11-06T08:00:00.000Z', '报销', '答：提醒我交报销单']])
  assert.equal(delivered(), 1)
  assert.equal(changes(), 1, 'the one that runs once has ended')
  assert.deepEqual([store.list(), timers()], [[], []], 'nothing left to wait for')
})

test('dsh not there: the run is kept with what was taken, runs once it is, and makes one item however often woken', async () => {
  const { store, feed, asked, kept, make, settle, go, runs } = setup([UNAVAILABLE])
  store.create({ title: '日报', prompt: '写今天的日报', cwd: '/work', rule: { kind: 'daily', daily: { time: '18:00:00', time_zone: 'Asia/Shanghai' } } })
  go('2026-11-06T18:00:01+08:00')
  make().wake()
  await settle()
  assert.deepEqual([asked.length, kept.length, runs()], [1, 0, 1], 'nothing made; the run kept')

  // The next launch, on the same database.
  make().wake()
  await settle()
  assert.deepEqual(kept.map((item) => item.key), ['s1@2026-11-06T10:00:00.000Z'])
  make().wake()
  await settle()
  assert.deepEqual([asked.length, feed.list().length], [2, 1], 'one item for the occurrence')
})

test('paused or deleted after it was taken, before it ran: that occurrence is let go, not run', async () => {
  for (const after of ['pause', 'delete'] as const) {
    const { store, asked, kept, make, settle, go, runs, answer } = setup([UNAVAILABLE])
    const { id } = store.create({ title: '日报', prompt: '写日报', cwd: '/work', rule: { kind: 'daily', daily: { time: '18:00:00', time_zone: 'Asia/Shanghai' } } })
    go('2026-11-06T18:00:01+08:00')
    const scheduled = make()
    scheduled.wake()
    await settle()
    assert.equal(runs(), 1, 'taken while dsh was away')
    if (after === 'pause') store.setPaused(id, true)
    else store.remove(id)
    answer([{ ok: true, text: '不该出现' }])
    scheduled.wake()
    await settle()
    assert.deepEqual([asked.length, kept.length, runs()], [1, 0, 0], `${after}: not run again, nothing made, the run gone`)
  }
})

test('a run that fails is tried again later, waiting longer each time; one that keeps failing is an item saying so', async () => {
  const { store, asked, kept, timers, fire, make, settle, go } = setup(Array(MAX_ATTEMPTS).fill({ ok: false, problem: '模型出错' }))
  store.create({ title: '汇总', prompt: '汇总本周进展', cwd: '/work', rule: ONCE })
  go('2026-11-06T11:00:00+08:00')
  make().wake()
  await settle()
  assert.deepEqual([asked.length, kept.length, timers().map((timer) => timer.ms)], [1, 0, [RETRY_MS]])
  go('2026-11-06T11:01:00+08:00')
  fire()
  await settle()
  assert.deepEqual([asked.length, timers().map((timer) => timer.ms)], [2, [RETRY_MS * 2]])
  go('2026-11-06T11:03:00+08:00')
  fire()
  await settle()
  assert.equal(asked.length, MAX_ATTEMPTS)
  assert.deepEqual(kept.map((item) => item.title), ['汇总'])
  assert.match(kept[0].body, /模型出错/)
  assert.deepEqual(timers(), [])
})

test('its item not kept (the database refusing): tried again after a growing wait, with the answer got, the model not asked again', async () => {
  const { store, asked, kept, timers, fire, make, settle, go, fail, runs } = setup()
  store.create({ title: '周报', prompt: '起草周报', cwd: '/work', rule: ONCE })
  go('2026-11-06T11:00:00+08:00')
  fail('schedule.ran', 2)
  make().wake()
  await settle()
  assert.deepEqual([asked.length, kept.length, runs(), timers().map((timer) => timer.ms)], [1, 0, 1, [HOLD_MS[0]]], 'not at once: after a wait')
  go('2026-11-06T11:00:05+08:00')
  fire()
  await settle()
  assert.deepEqual([asked.length, timers().map((timer) => timer.ms)], [1, [HOLD_MS[1]]], 'longer the second time; still the one answer')
  go('2026-11-06T11:00:35+08:00')
  fire()
  await settle()
  assert.deepEqual([asked.length, kept.map((item) => item.body), runs()], [1, ['答：起草周报'], 0])
})

test('woken while a run was finding no dsh: it looks again, so a one-off is not left waiting for good', async () => {
  let unavailable!: (result: RunResult) => void
  const first = new Promise<RunResult>((resolve) => { unavailable = resolve })
  const { store, asked, kept, make, settle, go } = setup([first])
  store.create({ title: '提醒', prompt: '提醒我开会', cwd: '/work', rule: ONCE })
  go('2026-11-06T11:00:00+08:00')
  const scheduled = make()
  scheduled.wake()
  await settle()
  assert.equal(asked.length, 1, 'under way')
  scheduled.wake()
  unavailable(UNAVAILABLE)
  await settle()
  await settle()
  assert.deepEqual([asked.length, kept.map((item) => item.title)], [2, ['提醒']], 'asked again, and made')
})

test('dsh away: the run waits to be woken, not on the timer (no spinning); woken with dsh back, it runs', async () => {
  const { store, asked, timers, make, settle, go, answer } = setup([UNAVAILABLE])
  store.create({ title: '周报', prompt: '起草周报', cwd: '/work', rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] } } })
  go('2026-11-06T16:00:00+08:00')
  const runs = make()
  runs.wake()
  await settle()
  assert.equal(asked.length, 1)
  assert.deepEqual(timers().map((timer) => timer.ms), [MAX_WAIT_MS], 'only next week\'s time is waited for')
  answer([{ ok: true, text: '周报草稿' }])
  runs.wake()
  await settle()
  assert.equal(asked.length, 2)
})
