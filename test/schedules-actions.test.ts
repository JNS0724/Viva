import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScheduleActions } from '../src/renderer/schedules-actions.ts'
import type { ScheduleView } from '../src/shared/ipc-results.ts'

const sample: ScheduleView = {
  id: 'sc-1',
  title: '周五周报',
  prompt: '整理本周周报',
  kind: 'weekly',
  nextAt: '2026-11-06T16:00:00Z',
  status: 'active',
}

test('schedules-actions: openSchedules opens the page and refreshes schedules', async () => {
  const actions: Array<Record<string, unknown>> = []
  const schedules = createScheduleActions({
    api: { listSchedules: async () => [sample] },
    dispatch: (action) => { actions.push(action as unknown as Record<string, unknown>) },
    errorMessage: (err) => String((err as Error)?.message ?? err),
  })

  schedules.openSchedules('sc-1')
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(actions, [
    { type: 'schedules_open', id: 'sc-1' },
    { type: 'schedules_loaded', schedules: [sample] },
  ])
})

test('schedules-actions: pauseSchedule and deleteSchedule serialize mutations and surface errors', async () => {
  const actions: Array<Record<string, unknown>> = []
  let pausedArg: [string, boolean] | null = null
  let deletedArg: string | null = null
  let current: ScheduleView[] = [sample]

  const schedules = createScheduleActions({
    api: {
      listSchedules: async () => current,
      pauseSchedule: async (id, paused) => {
        pausedArg = [id, paused]
        current = [{ ...sample, status: paused ? 'paused' : 'active' }]
        return current[0]
      },
      deleteSchedule: async (id) => {
        deletedArg = id
        throw new Error('删除失败')
      },
    },
    dispatch: (action) => { actions.push(action as unknown as Record<string, unknown>) },
    errorMessage: (err) => String((err as Error)?.message ?? err),
  })

  await schedules.pauseSchedule('sc-1', true)
  assert.deepEqual(pausedArg, ['sc-1', true])
  assert.deepEqual(actions.slice(0, 3), [
    { type: 'schedules_busy' },
    { type: 'schedules_loaded', schedules: [{ ...sample, status: 'paused' }] },
    { type: 'schedules_done' },
  ])

  await schedules.deleteSchedule('sc-1')
  assert.equal(deletedArg, 'sc-1')
  assert.deepEqual(actions.slice(3), [
    { type: 'schedules_busy' },
    { type: 'schedules_failed', message: '删除失败' },
  ])
})

test('schedules-actions: ignores stale out-of-order loadSchedules responses after a mutation', async () => {
  const actions: Array<Record<string, unknown>> = []
  let resolveStale!: (items: ScheduleView[]) => void
  let callCount = 0
  const schedules = createScheduleActions({
    api: {
      listSchedules: () => {
        callCount += 1
        if (callCount === 1) return new Promise<ScheduleView[]>((resolve) => { resolveStale = resolve })
        return Promise.resolve([{ ...sample, status: 'paused' }])
      },
      pauseSchedule: async () => ({ ...sample, status: 'paused' }),
    },
    dispatch: (action) => { actions.push(action as unknown as Record<string, unknown>) },
    errorMessage: (err) => String((err as Error)?.message ?? err),
  })

  const staleLoad = schedules.loadSchedules()
  await schedules.pauseSchedule('sc-1', true)
  resolveStale([sample])
  await staleLoad

  assert.deepEqual(actions, [
    { type: 'schedules_busy' },
    { type: 'schedules_loaded', schedules: [{ ...sample, status: 'paused' }] },
    { type: 'schedules_done' },
  ])
})

test('schedules-actions: a slow post-mutation refresh error does not overwrite a newer successful refresh', async () => {
  const actions: Array<Record<string, unknown>> = []
  let rejectPostMutationRefresh!: (err: Error) => void
  let callCount = 0
  const schedules = createScheduleActions({
    api: {
      listSchedules: () => {
        callCount += 1
        if (callCount === 1) return new Promise<ScheduleView[]>((_resolve, reject) => { rejectPostMutationRefresh = reject })
        return Promise.resolve([{ ...sample, status: 'paused' }])
      },
      pauseSchedule: async () => ({ ...sample, status: 'paused' }),
    },
    dispatch: (action) => { actions.push(action as unknown as Record<string, unknown>) },
    errorMessage: (err) => String((err as Error)?.message ?? err),
  })

  const mutation = schedules.pauseSchedule('sc-1', true)
  await new Promise((resolve) => setImmediate(resolve))
  await schedules.loadSchedules()
  rejectPostMutationRefresh(new Error('过期刷新失败'))
  await mutation

  assert.deepEqual(actions, [
    { type: 'schedules_busy' },
    { type: 'schedules_loaded', schedules: [{ ...sample, status: 'paused' }] },
    { type: 'schedules_done' },
  ])
})
