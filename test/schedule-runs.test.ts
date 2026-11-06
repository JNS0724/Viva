import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openFeedStore, type FeedItem } from '../src/backend/feed-store.ts'
import { MAX_ATTEMPTS, MAX_WAIT_MS, RETRY_MS, createScheduleRuns } from '../src/backend/schedule-runs.ts'
import { openScheduleStore } from '../src/backend/schedule-store.ts'
import type { RunResult } from '../src/backend/unattended-runs.ts'

/** Schedules run when due (schedule-runs.ts): one timer, runs kept with what was taken, each answer one item in 动态. */

const at = (iso: string) => Date.parse(iso)
type Timer = { run: () => void, ms: number }
const UNAVAILABLE: RunResult = { ok: false, problem: 'unavailable', unavailable: true }

function setup(answers: RunResult[] = []) {
  let now = at('2026-11-06T10:00:00+08:00')
  const db = new DatabaseSync(':memory:')
  const store = openScheduleStore({ db, now: () => now, newId: () => 's1' })
  const feed = openFeedStore({ db, now: () => now })
  const asked: string[] = []
  const delivered: FeedItem[] = []
  let timers: Timer[] = []
  let changes = 0
  let queue = [...answers]
  const make = () => createScheduleRuns({
    db, store, feed,
    run: async (prompt) => {
      asked.push(prompt)
      const [next, ...rest] = queue
      queue = rest
      return next ?? { ok: true, text: `答：${prompt}` }
    },
    delivered: (item) => { delivered.push(item) },
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
    db, store, feed, asked, delivered, make,
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
  }
}

test('one timer, for the soonest; due, the prompt runs and its answer is one item in 动态 and a notice', async () => {
  const { store, asked, delivered, timers, fire, make, settle, go, changes } = setup()
  store.create({ title: '报销', prompt: '提醒我交报销单', rule: { kind: 'at', at: '2026-11-06T16:00:00+08:00' } })
  make().arm()
  assert.deepEqual(timers().map((timer) => timer.ms), [MAX_WAIT_MS], 'six hours away: it looks again in an hour, never longer')
  go('2026-11-06T16:00:00+08:00')
  fire()
  await settle()
  assert.deepEqual(asked, ['提醒我交报销单'])
  assert.deepEqual(delivered.map((item) => [item.source, item.key, item.title, item.body]), [['schedule', 's1@2026-11-06T08:00:00.000Z', '报销', '答：提醒我交报销单']])
  assert.equal(changes(), 1, 'the one that runs once has ended')
  assert.deepEqual([store.list(), timers()], [[], []], 'nothing left to wait for')
})

test('dsh not there: the run is kept with what was taken, runs once it is, and makes one item however often woken', async () => {
  const { db, store, feed, asked, delivered, make, settle, go } = setup([UNAVAILABLE])
  store.create({ title: '日报', prompt: '写今天的日报', rule: { kind: 'daily', daily: { time: '18:00:00', time_zone: 'Asia/Shanghai' } } })
  go('2026-11-06T18:00:01+08:00')
  make().wake()
  await settle()
  assert.deepEqual([asked.length, delivered.length], [1, 0], 'nothing made')
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schedule_runs').get() as { n: number }).n, 1, 'kept')

  // The next launch, on the same database.
  make().wake()
  await settle()
  assert.deepEqual(delivered.map((item) => item.key), ['s1@2026-11-06T10:00:00.000Z'])
  make().wake()
  await settle()
  assert.deepEqual([asked.length, feed.list().length], [2, 1], 'one item for the occurrence')
})

test('a run that fails is tried again later, waiting longer each time; one that keeps failing is an item saying so', async () => {
  const { store, asked, delivered, timers, fire, make, settle, go } = setup(Array(MAX_ATTEMPTS).fill({ ok: false, problem: '模型出错' }))
  store.create({ title: '汇总', prompt: '汇总本周进展', rule: { kind: 'at', at: '2026-11-06T11:00:00+08:00' } })
  go('2026-11-06T11:00:00+08:00')
  make().wake()
  await settle()
  assert.deepEqual([asked.length, delivered.length, timers().map((timer) => timer.ms)], [1, 0, [RETRY_MS]])
  go('2026-11-06T11:01:00+08:00')
  fire()
  await settle()
  assert.deepEqual([asked.length, timers().map((timer) => timer.ms)], [2, [RETRY_MS * 2]])
  go('2026-11-06T11:03:00+08:00')
  fire()
  await settle()
  assert.equal(asked.length, MAX_ATTEMPTS)
  assert.deepEqual(delivered.map((item) => item.title), ['汇总'])
  assert.match(delivered[0].body, /模型出错/)
  assert.deepEqual(timers(), [])
})

test('dsh away: the run waits to be woken, not on the timer (no spinning); woken with dsh back, it runs', async () => {
  const { store, asked, timers, make, settle, go, answer } = setup([UNAVAILABLE])
  store.create({ title: '周报', prompt: '起草周报', rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] } } })
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
