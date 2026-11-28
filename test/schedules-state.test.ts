import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubPage } from '../src/renderer/hub-state.ts'
import { scheduleGroups, selectedSchedule, shownScheduleId, sortedSchedules } from '../src/renderer/schedules-state.ts'
import type { ScheduleView } from '../src/shared/ipc-results.ts'
import { initialState, reduce } from './fixtures/task-window.ts'

type WindowState = Parameters<typeof reduce>[0]
type TestAction = Parameters<typeof reduce>[1]

const run = (actions: readonly TestAction[], start: WindowState = initialState as WindowState): WindowState =>
  actions.reduce((state, action) => reduce(state, action), start)

const schedule = (id: string, title: string, nextAt: string, status: 'active' | 'paused' = 'active'): ScheduleView => ({
  id, title, prompt: `执行 ${title}`, kind: 'daily', nextAt, status,
})

test('schedules-state: orders active schedules by nextAt before paused schedules and groups them', () => {
  const paused = schedule('sc-paused', '暂停周报', '2026-11-06T09:00:00Z', 'paused')
  const later = schedule('sc-later', '晚报', '2026-11-06T18:00:00Z', 'active')
  const soon = schedule('sc-soon', '晨会提醒', '2026-11-06T10:00:00Z', 'active')

  const state = run([{ type: 'schedules_loaded', schedules: [paused, later, soon] }])
  assert.deepEqual(sortedSchedules(state).map((item) => item.id), ['sc-soon', 'sc-later', 'sc-paused'])
  assert.deepEqual(scheduleGroups(state).map((group) => [group.key, group.items.map((item) => item.id)]), [
    ['active', ['sc-soon', 'sc-later']],
    ['paused', ['sc-paused']],
  ])
  assert.equal(shownScheduleId(state), 'sc-soon')
})

test('schedules-state: opens as a hub sub-page, closes sibling hub pages, and falls back when selected schedule is deleted', () => {
  const paused = schedule('sc-paused', '暂停周报', '2026-11-06T09:00:00Z', 'paused')
  const soon = schedule('sc-soon', '晨会提醒', '2026-11-06T10:00:00Z', 'active')

  const opened = run([
    { type: 'tasks_page_open' },
    { type: 'schedules_loaded', schedules: [paused, soon] },
    { type: 'schedules_open', id: 'sc-paused' },
  ])
  assert.equal(hubPage(opened), 'schedules')
  assert.equal(opened.tasks.page.open, false, 'opening 定时任务 closes 后台')
  assert.equal(opened.hub.last, 'schedules')
  assert.equal(selectedSchedule(opened)?.id, 'sc-paused')

  const afterEndedRefresh = reduce(opened, { type: 'schedules_loaded', schedules: [soon] })
  assert.equal(selectedSchedule(afterEndedRefresh), null, 'stale cached schedule that ended shows gone state instead of another schedule')
  assert.equal(afterEndedRefresh.schedules.explicit, true)

  const afterDelete = reduce(opened, { type: 'schedules_loaded', schedules: [soon], clearExplicit: true })
  assert.equal(selectedSchedule(afterDelete)?.id, 'sc-soon', 'explicit user delete falls back to first schedule')

  const closed = reduce(afterDelete, { type: 'hub_close' })
  assert.equal(hubPage(closed), null)
  assert.equal(closed.schedules.open, false)
})

test('schedules-state: tracks busy and error flags around schedule mutations', () => {
  const busy = run([{ type: 'schedules_busy' }])
  assert.equal(busy.schedules.busy, true)
  assert.equal(busy.schedules.error, null)

  const refreshedDuringMutation = reduce(busy, { type: 'schedules_loaded', schedules: [] })
  assert.equal(refreshedDuringMutation.schedules.busy, true, 'background list refresh does not clear mutation busy flag')

  const done = reduce(refreshedDuringMutation, { type: 'schedules_done' })
  assert.equal(done.schedules.busy, false)

  const failed = reduce(busy, { type: 'schedules_failed', message: '找不到定时' })
  assert.equal(failed.schedules.busy, false)
  assert.equal(failed.schedules.error, '找不到定时')
})

test('schedules-state: explicit navigation to an ended or deleted schedule does not silently select another schedule', () => {
  const active = schedule('s2', '每日晨报', '2026-11-06T09:00:00Z', 'active')
  const state = run([
    { type: 'schedules_loaded', schedules: [active] },
    { type: 'schedules_open', id: 's1' },
    { type: 'schedules_loaded', schedules: [active] },
  ])
  assert.equal(state.schedules.selected, 's1')
  assert.equal(state.schedules.explicit, true)
  assert.equal(shownScheduleId(state), null, 'does not fall back to s2 when s1 was explicitly requested')
  assert.equal(selectedSchedule(state), null)

  const picked = reduce(state, { type: 'schedules_select', id: 's2' })
  assert.equal(selectedSchedule(picked)?.id, 's2')
  assert.equal(picked.schedules.explicit, false)

  const afterNewTopic = reduce(picked, { type: 'new_session', at: 1_000 })
  assert.equal(afterNewTopic.schedules.schedules.length, 1, 'starting a new topic preserves cached schedules for the Home Today card')

  const coldOpen = reduce(initialState as WindowState, { type: 'schedules_open', id: 's-pending' })
  assert.equal(coldOpen.schedules.loaded, false)
  assert.equal(coldOpen.schedules.loading, true, 'opening before initial load marks loading instead of confirmed gone')
  const coldFailed = reduce(coldOpen, { type: 'schedules_failed', message: 'IPC 断开' })
  assert.equal(coldFailed.schedules.loaded, false)
  assert.equal(coldFailed.schedules.loading, false)
  assert.equal(coldFailed.schedules.error, 'IPC 断开')
})
