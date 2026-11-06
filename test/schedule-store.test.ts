import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openScheduleStore } from '../src/backend/schedule-store.ts'

/** Schedules (schedule-store.ts): a time and a prompt, dsh-schedule's records, each occurrence taken once. */

const at = (iso: string) => Date.parse(iso)
function storeAt(start: string) {
  let now = at(start)
  let n = 0
  const store = openScheduleStore({ db: new DatabaseSync(':memory:'), now: () => now, newId: () => `s${++n}` })
  return { store, go: (iso: string) => { now = at(iso) } }
}

test('once: due at its time, taken once, then ended and no longer listed', () => {
  const { store, go } = storeAt('2026-11-06T10:00:00+08:00')
  store.create({ title: '报销', prompt: '提醒我交报销单', rule: { kind: 'at', at: '2026-11-07T16:00:00+08:00' } })
  assert.deepEqual([store.takeDue(), store.nextDueAt()], [[], at('2026-11-07T16:00:00+08:00')])
  go('2026-11-07T16:00:01+08:00')
  const taken = store.takeDue()
  assert.deepEqual(taken.map((o) => o.key), ['s1@2026-11-07T08:00:00.000Z'])
  assert.deepEqual([store.takeDue(), store.list(), store.nextDueAt()], [[], [], null], 'taken once; ended')
})

test('daily: each day its local time; days missed are one occurrence, the latest, and it goes on', () => {
  const { store, go } = storeAt('2026-11-06T10:00:00+08:00')
  store.create({ title: '日报', prompt: '写今天的日报', rule: { kind: 'daily', daily: { time: '18:00:00', time_zone: 'Asia/Shanghai' } } })
  go('2026-11-06T18:00:00+08:00')
  assert.deepEqual(store.takeDue().map((o) => o.at), ['2026-11-06T10:00:00.000Z'])
  go('2026-11-09T09:00:00+08:00')
  assert.deepEqual(store.takeDue().map((o) => o.at), ['2026-11-08T10:00:00.000Z'], 'three days off: the latest missed, once')
  assert.equal(store.nextDueAt(), at('2026-11-09T18:00:00+08:00'))
})

test('paused, it is not taken; resumed, it is; changed, its new time counts from now; removed, gone', () => {
  const { store, go } = storeAt('2026-11-06T10:00:00+08:00')
  const { id } = store.create({ title: '周报', prompt: '起草周报', rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] } } })
  assert.equal(store.setPaused(id, true)?.status, 'paused')
  go('2026-11-07T16:00:01+08:00')
  assert.deepEqual([store.takeDue(), store.nextDueAt()], [[], null], 'paused: not taken, nothing due')
  store.setPaused(id, false)
  assert.equal(store.takeDue().length, 1, 'resumed: the occurrence missed meanwhile, once')
  const moved = store.update(id, { title: '周报（周四）', rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [4] } } })
  assert.deepEqual([moved?.record.title, moved?.record.scheduledAt], ['周报（周四）', '2026-11-12T08:00:00.000Z'])
  assert.deepEqual([store.remove(id), store.list()], [true, []])
})

test('what dsh does not accept is refused, nothing kept', () => {
  const { store } = storeAt('2026-11-06T10:00:00+08:00')
  assert.throws(() => store.create({ title: '过去', prompt: 'x', rule: { kind: 'at', at: '2020-01-01T00:00:00Z' } }))
  assert.throws(() => store.create({ title: '坏', prompt: 'x', rule: { kind: 'cron', cron: { expression: '61 * * * *', time_zone: 'Asia/Shanghai' } } }))
  assert.deepEqual(store.list(), [])
})
