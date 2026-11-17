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
import type { MemoryFileDependency, MemoryProvenance } from '../src/memory/contracts/records.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'

/** Schedules run when due (schedule-runs.ts): one timer, runs kept with what was taken, each answer one item in 动态. */

const at = (iso: string) => Date.parse(iso)
type Timer = { run: () => void, ms: number }
const UNAVAILABLE: RunResult = { ok: false, problem: 'unavailable', unavailable: true }
const ONCE = { kind: 'at', at: '2026-11-06T11:00:00+08:00' } as const

test('schedule retry diagnostics are published only after the durable retry and keep their identity across restart', async t => {
  const events: DiagnosticEvent[] = []
  const restore = installDiagnosticPort({ emit(event) { events.push(event); return undefined } })
  t.after(restore)
  const app = setup([{ ok: false, problem: 'SECRET_SCHEDULE_FAILURE' }, { ok: true, text: 'SECRET_SCHEDULE_RESULT' }])
  app.store.create({ title: 'SECRET_SCHEDULE_TITLE', prompt: 'SECRET_SCHEDULE_PROMPT', cwd: '/PRIVATE_PATH', rule: ONCE })
  app.go('2026-11-06T11:00:00+08:00')
  let runner = app.make()
  t.after(() => { runner.close(); app.db.close() })
  app.fail('schedule.retry', 1)
  runner.wake(); await app.settle()
  assert.equal(events.filter(event => event.operation === 'schedule' && event.event === 'retry.scheduled').length, 0)
  app.go('2026-11-06T11:00:02+08:00')
  runner.wake(); await app.settle()
  const retry = events.find(event => event.operation === 'schedule' && event.event === 'retry.scheduled')
  assert.ok(retry)
  assert.equal(retry.metrics?.attempt, 1)
  runner.close(); runner = app.make()
  app.go('2026-11-06T11:02:00+08:00')
  runner.wake(); await app.settle()
  assert.equal(app.feed.list()[0]?.body, 'SECRET_SCHEDULE_RESULT')
  assert.ok(events.some(event => event.operation === 'schedule' && event.event === 'operation.start' && event.stage === 'recovering'
    && event.identities?.jobId === retry.identities?.jobId && event.identities?.generation === retry.identities?.generation))
  assert.doesNotMatch(JSON.stringify(events), /SECRET_SCHEDULE|PRIVATE_PATH/)
})

test('file dependencies survive saved schedules, retry recovery, result merging and feed continuation', async t => {
  const ref: MemoryFileDependency = { workspace: 'a'.repeat(64), id: 'node', path: 'digest/wiki/report.md',
    revision: 'body', usageVersion: 1, policyToken: 'policy', sourceRanges: [{ sourceId: 'schedule-source' }] }
  const initial: MemoryProvenance = { sources: [], turnOnly: false, epoch: 0,
    files: [ref, { ...ref, workspace: 'b'.repeat(64) }] }
  const result: MemoryProvenance = { ...initial, files: [{ ...ref, id: 'related', path: 'digest/wiki/related.md' }] }
  const app = setup([{ ok: false, problem: 'temporary transport failure' }, { ok: true, text: 'Current report', memory: result }])
  const schedule = app.store.create({ title: 'Report', prompt: 'Summarize', cwd: '/work', rule: ONCE, memory: initial })
  assert.deepEqual(app.store.get(schedule.id)?.memory, initial)
  app.go('2026-11-06T11:00:00+08:00')
  let runner = app.make()
  t.after(() => { runner.close(); app.db.close() })
  runner.wake(); await app.settle()
  const parked = app.db.prepare('SELECT memory FROM schedule_runs').get() as { memory: string }
  assert.deepEqual((JSON.parse(parked.memory) as MemoryProvenance).files, initial.files)
  runner.close()
  runner = app.make()
  app.go('2026-11-06T11:02:00+08:00')
  runner.wake(); await app.settle()
  assert.equal(app.asked.length, 2)
  const item = app.feed.list()[0]!
  assert.equal(item.body, 'Current report')
  assert.deepEqual(app.feed.continuation(item.id)?.memory?.files, [...initial.files!, ...result.files!])
})

function setup(answers: Array<RunResult | Promise<RunResult>> = [], memoryCurrent: NonNullable<Parameters<typeof createScheduleRuns>[0]['memoryCurrent']> = () => true) {
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
    db, apply, store, feed, memoryCurrent,
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

test('a cached schedule result is rechecked on storage retry and refreshed from the original prompt', async () => {
  let current = true
  const memory = { sources: ['schedule-source'], turnOnly: false, epoch: 0 }
  const app = setup([{ ok: true, text: '旧地址', memory }, { ok: true, text: '新地址' }], async () => current)
  app.store.create({ title: '周报', prompt: '核对当前地址', cwd: '/work', rule: ONCE })
  app.go('2026-11-06T11:00:00+08:00')
  app.fail('schedule.ran', 1)
  app.make().wake()
  await app.settle()
  assert.deepEqual([app.asked.length, app.feed.list().length, app.runs()], [1, 0, 1])
  current = false
  app.go('2026-11-06T11:00:01+08:00')
  app.fire()
  await app.settle()
  assert.deepEqual([app.asked.length, app.feed.list().length, app.runs()], [1, 0, 1])
  app.go('2026-11-06T11:01:02+08:00')
  app.fire()
  await app.settle()
  assert.deepEqual([app.asked.length, app.feed.list().map(item => item.body), app.runs()], [2, ['新地址'], 0])
})

test('a parked occurrence cannot replay or pause a rewritten recurring schedule after reconnect', async () => {
  let current = true
  const memory = { sources: ['schedule-source'], turnOnly: false, epoch: 0 }
  const app = setup([{ ...UNAVAILABLE, memoryUnavailable: true }], async () => current)
  const { id } = app.store.create({ title: '原定时', prompt: '旧指令', cwd: '/work', memory,
    rule: { kind: 'daily', daily: { time: '18:00:00', time_zone: 'Asia/Shanghai' } } })
  app.go('2026-11-06T18:00:01+08:00')
  const runner = app.make()
  runner.wake()
  await app.settle()
  assert.equal(app.runs(), 1)
  app.store.setPaused(id, true)
  app.store.update(id, { title: '新定时', prompt: '新指令', memory: { ...memory, sources: [] } })
  app.store.setPaused(id, false)
  current = false
  runner.wake()
  await app.settle()
  assert.deepEqual(app.asked.map(run => run.prompt), ['旧指令'])
  assert.equal(app.runs(), 0)
  assert.equal(app.store.get(id)?.status, 'active')
  assert.equal(app.feed.list().length, 0)
})

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

test('a failed try whose retry is not kept: the retry is kept later without asking the model again, so the tries stay counted', async () => {
  const fail: RunResult = { ok: false, problem: '模型出错' }
  const { store, asked, kept, timers, fire, make, settle, go, fail: refuse } = setup(Array(MAX_ATTEMPTS).fill(fail))
  store.create({ title: '汇总', prompt: '汇总本周进展', cwd: '/work', rule: ONCE })
  go('2026-11-06T11:00:00+08:00')
  refuse('schedule.retry', 2)
  make().wake()
  await settle()
  assert.deepEqual([asked.length, timers().map((timer) => timer.ms)], [1, [HOLD_MS[0]]])
  go('2026-11-06T11:00:05+08:00')
  fire()
  await settle()
  go('2026-11-06T11:00:35+08:00')
  fire()
  await settle()
  assert.deepEqual([asked.length, timers().map((timer) => timer.ms)], [1, [RETRY_MS]], 'kept the third time, the model asked once; the next try a minute on')
  for (const minute of ['01:35', '03:35']) {
    go(`2026-11-06T11:${minute}+08:00`)
    fire()
    await settle()
  }
  assert.deepEqual([asked.length, kept.length], [MAX_ATTEMPTS, 1], 'three tries in all, then the item saying so')
})

test('an answer that reads "unavailable" is an answer like any other', async () => {
  const { store, asked, kept, fire, make, settle, go, fail: refuse } = setup([{ ok: true, text: 'unavailable' }])
  store.create({ title: '状态', prompt: '服务现在怎样', cwd: '/work', rule: ONCE })
  go('2026-11-06T11:00:00+08:00')
  refuse('schedule.ran', 1)
  make().wake()
  await settle()
  go('2026-11-06T11:00:05+08:00')
  fire()
  await settle()
  assert.deepEqual([asked.length, kept.map((item) => item.body)], [1, ['unavailable']])
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

test('an asynchronous stale creation check prevents a scheduled model request', async t => {
  const memory = { sources: ['schedule-source'], turnOnly: false, epoch: 0 }
  const app = setup([], async () => false)
  t.after(() => app.db.close())
  app.store.create({ title: '周报', prompt: '过期的地址', cwd: '/work', rule: ONCE, memory })
  app.go('2026-11-06T11:00:00+08:00')
  const runner = app.make()
  t.after(() => runner.close())
  runner.wake()
  await app.settle()
  assert.equal(app.asked.length, 0)
  assert.equal(app.feed.list().length, 1)
  assert.ok(!app.feed.list()[0]!.body.includes('答：'))
  assert.equal(app.runs(), 0)
})

test('a schedule changed while the remote admission check waits does not run its old prompt', async t => {
  const memory = { sources: ['schedule-source'], turnOnly: false, epoch: 0 }
  let release!: (current: boolean) => void
  const current = new Promise<boolean>(resolve => { release = resolve })
  const app = setup([], async () => current)
  t.after(() => app.db.close())
  const { id } = app.store.create({ title: '周报', prompt: '旧指令', cwd: '/work', memory,
    rule: { kind: 'daily', daily: { time: '18:00:00', time_zone: 'Asia/Shanghai' } } })
  app.go('2026-11-06T18:00:01+08:00')
  const runner = app.make()
  t.after(() => runner.close())
  runner.wake()
  app.store.update(id, { prompt: '新指令' })
  release(true)
  await app.settle()
  assert.equal(app.asked.length, 0)
  assert.equal(app.feed.list().length, 0)
  assert.equal(app.runs(), 0)
})

test('closing a schedule runner while its remote result check waits prevents delivery', async t => {
  const memory = { sources: ['schedule-source'], turnOnly: false, epoch: 0 }
  let release!: (current: boolean) => void
  const current = new Promise<boolean>(resolve => { release = resolve })
  const app = setup([{ ok: true, text: '旧结果', memory }], async () => current)
  t.after(() => app.db.close())
  app.store.create({ title: '周报', prompt: '汇总', cwd: '/work', rule: ONCE })
  app.go('2026-11-06T11:00:00+08:00')
  const runner = app.make()
  runner.wake()
  await app.settle()
  assert.equal(app.asked.length, 1)
  runner.close()
  release(true)
  await app.settle()
  assert.equal(app.feed.list().length, 0)
  assert.equal(app.runs(), 1)
})

test('erasing one queued occurrence while it is in flight prevents its result and notice from returning', async t => {
  let finish!: (result: RunResult) => void
  const running = new Promise<RunResult>(resolve => { finish = resolve })
  const app = setup([running])
  const runner = app.make()
  t.after(() => { runner.close(); app.db.close() })
  const schedule = app.store.create({ title: 'Independent weekly job', prompt: 'Keep this', cwd: '/work', rule: ONCE })
  app.go('2026-11-06T11:00:00+08:00')
  runner.wake()
  assert.equal(app.asked.length, 1)
  app.db.prepare('DELETE FROM schedule_runs WHERE schedule_id=?').run(schedule.id)
  finish({ ok: true, text: 'Late erased result' })
  await app.settle()
  assert.deepEqual([app.feed.list(), app.kept, app.delivered()], [[], [], 0])
  assert(app.store.get(schedule.id), 'the independent schedule itself is retained')
})

test('erasure retires an in-flight cached result during the commit authorization RPC', async t => {
  const memory: MemoryProvenance = { sources: ['selected-source'], turnOnly: false, epoch: 0 }
  let allow!: (current: boolean) => void
  const checking = new Promise<boolean>(resolve => { allow = resolve })
  const app = setup([{ ok: true, text: 'Selected-source result', memory }], () => checking)
  const runner = app.make()
  t.after(() => { runner.close(); app.db.close() })
  const schedule = app.store.create({ title: 'Independent weekly job', prompt: 'Keep this', cwd: '/work', rule: ONCE })
  app.go('2026-11-06T11:00:00+08:00')
  runner.wake()
  await app.settle()
  assert.equal(app.runs(), 1)
  assert(runner.discardMemory(result => result.sources.includes('selected-source')))
  allow(true)
  await app.settle()
  assert.deepEqual([app.runs(), app.feed.list(), app.kept], [0, [], []])
  assert(app.store.get(schedule.id))
})
