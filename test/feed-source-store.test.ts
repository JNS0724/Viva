import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { openFeedSourceStore } from '../src/backend/feed-source-store.ts'

const at = (iso: string) => Date.parse(iso)

function storeAt(start: string) {
  let now = at(start)
  let n = 0
  const store = openFeedSourceStore({ db: new DatabaseSync(':memory:'), now: () => now, newId: () => `fs${++n}` })
  return { store, go: (iso: string) => { now = at(iso) } }
}

test('multiple data sources can bind the same dsh plugin with distinct schedules and instructions', () => {
  const { store } = storeAt('2026-11-19T12:00:00+08:00')
  const urgent = store.create({
    pluginName: '@company/dsh-plugin-mail',
    name: '客户紧急邮件',
    instruction: '筛选紧急客户邮件',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  const digest = store.create({
    pluginName: '@company/dsh-plugin-mail',
    instruction: '每天早上汇总邮件',
    schedule: { kind: 'daily', time: '08:30', timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  assert.equal(urgent.name, '客户紧急邮件')
  assert.equal(digest.name, '@company/dsh-plugin-mail')
  assert.equal(store.list().length, 2)
  assert.equal(urgent.record.scheduledAt, '2026-11-19T04:30:00.000Z')
  assert.equal(digest.record.scheduledAt, '2026-11-20T00:30:00.000Z')
})

test('interval and weekly sources advance on takeDue and collapse missed intervals into one latest occurrence', () => {
  const { store, go } = storeAt('2026-11-19T12:00:00+08:00')
  store.create({
    pluginName: '@company/dsh-plugin-github',
    name: 'PR 审查',
    instruction: '检查待审查 PR',
    schedule: { kind: 'interval', minutes: 30, timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  assert.deepEqual(store.takeDue(), [])
  go('2026-11-19T14:05:00+08:00')
  const taken = store.takeDue()
  assert.equal(taken.length, 1)
  assert.equal(taken[0].at, '2026-11-19T06:00:00.000Z')
  assert.equal(store.nextDueAt(), at('2026-11-19T14:30:00+08:00'))
})

test('update, pause, recordRun cursor persistence and remove work cleanly', () => {
  const { store, go } = storeAt('2026-11-19T12:00:00+08:00')
  const created = store.create({
    pluginName: '@company/dsh-plugin-rss',
    name: '行业资讯',
    instruction: '只看 AI 方向',
    schedule: { kind: 'weekly', weekdays: [1, 3, 5], time: '09:00', timeZone: 'Asia/Shanghai' },
    cwd: '/work',
  })
  const paused = store.setPaused(created.id, true)
  assert.equal(paused?.status, 'paused')
  assert.equal(paused?.revision, 1)
  assert.equal(store.nextDueAt(), null)

  const updated = store.update(created.id, {
    name: 'AI 资讯',
    instruction: '只看基础设施更新',
    schedule: { kind: 'cron', expression: '0 */2 * * *', timeZone: 'Asia/Shanghai' },
    paused: false,
  })
  assert.equal(updated?.name, 'AI 资讯')
  assert.equal(updated?.status, 'active')
  assert.equal(updated?.revision, 2)

  go('2026-11-19T12:15:00+08:00')
  const recorded = store.recordRun(created.id, {
    ranAt: at('2026-11-19T12:15:00+08:00'),
    status: 'published',
    message: null,
    publishedCount: 2,
    cursor: { lastId: 'rss-99' },
  })
  assert.equal(recorded?.lastStatus, 'published')
  assert.equal(recorded?.lastPublishedCount, 2)
  assert.deepEqual(recorded?.cursor, { lastId: 'rss-99' })
  assert.equal(recorded?.revision, 2, 'recordRun does not bump config revision')

  assert.equal(store.remove(created.id), true)
  assert.deepEqual(store.list(), [])
})

test('invalid plugin, instruction or schedule is refused', () => {
  const { store } = storeAt('2026-11-19T12:00:00+08:00')
  assert.throws(() => store.create({ pluginName: '', instruction: 'ok', schedule: { kind: 'interval', minutes: 30 }, cwd: '/work' }))
  assert.throws(() => store.create({ pluginName: 'p', instruction: '   ', schedule: { kind: 'interval', minutes: 30 }, cwd: '/work' }))
  assert.throws(() => store.create({ pluginName: 'p', instruction: 'ok', schedule: { kind: 'interval', minutes: 7 }, cwd: '/work' }))
  assert.throws(() => store.create({ pluginName: 'p', instruction: 'ok', schedule: { kind: 'cron', expression: '61 * * * *', timeZone: 'Asia/Shanghai' }, cwd: '/work' }))
  assert.deepEqual(store.list(), [])
})
