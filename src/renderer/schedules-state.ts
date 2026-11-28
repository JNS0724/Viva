import type { ScheduleView } from '../shared/ipc-results.ts'
import type { ActionHandlers } from './action-types.ts'

/**
 * 定时任务 (view/schedules-page.ts): saved conversational schedules in their own hub sub-page, separate from 后台 tasks.
 * Pure and immutable like `state.ts`, which merges these in.
 */
export const initialSchedules = Object.freeze({
  open: false,
  schedules: Object.freeze([]) as readonly ScheduleView[],
  selected: null as string | null,
  explicit: false,
  loaded: false,
  loading: false,
  busy: false,
  error: null as string | null,
})

const sortedCache = new WeakMap<readonly ScheduleView[], readonly ScheduleView[]>()
sortedCache.set(initialSchedules.schedules, initialSchedules.schedules)

function orderScheduleList(list: readonly ScheduleView[]): readonly ScheduleView[] {
  const cached = sortedCache.get(list)
  if (cached) return cached
  if (list.length <= 1) {
    const frozen = Object.freeze([...list])
    sortedCache.set(list, frozen)
    sortedCache.set(frozen, frozen)
    return frozen
  }
  const keyed = list.map((item, index) => ({
    item,
    paused: item.status === 'paused' ? 1 : 0,
    at: Date.parse(item.nextAt),
    index,
  }))
  keyed.sort((a, b) => a.paused - b.paused || a.at - b.at || a.index - b.index)
  const frozen = Object.freeze(keyed.map(({ item }) => item))
  sortedCache.set(list, frozen)
  sortedCache.set(frozen, frozen)
  return frozen
}

export const sortedSchedules = (state: Pick<State, 'schedules'>): ScheduleView[] =>
  orderScheduleList(state.schedules.schedules as readonly ScheduleView[]).slice()

export function scheduleGroups(state: Pick<State, 'schedules'>): Array<{ key: 'active' | 'paused', items: ScheduleView[] }> {
  const ordered = orderScheduleList(state.schedules.schedules as readonly ScheduleView[])
  const active: ScheduleView[] = []
  const paused: ScheduleView[] = []
  for (const schedule of ordered) {
    if (schedule.status === 'paused') paused.push(schedule)
    else active.push(schedule)
  }
  const groups: Array<{ key: 'active' | 'paused', items: ScheduleView[] }> = []
  if (active.length > 0) groups.push({ key: 'active', items: active })
  if (paused.length > 0) groups.push({ key: 'paused', items: paused })
  return groups
}

export function shownScheduleId(state: Pick<State, 'schedules'>): string | null {
  const ordered = orderScheduleList(state.schedules.schedules as readonly ScheduleView[])
  const selected = state.schedules.selected
  if (selected && ordered.some((schedule) => schedule.id === selected)) return selected
  if (state.schedules.explicit && selected) return null
  return ordered[0]?.id ?? null
}

export function selectedSchedule(state: Pick<State, 'schedules'>): ScheduleView | null {
  const ordered = orderScheduleList(state.schedules.schedules as readonly ScheduleView[])
  const id = shownScheduleId(state)
  return id ? ordered.find((schedule) => schedule.id === id) ?? null : null
}

const withSchedules = (state: State, changes: Partial<State['schedules']>): State => ({
  ...state,
  schedules: { ...state.schedules, ...changes },
})

export const SCHEDULES_ACTIONS: ActionHandlers = {
  schedules_open: (state, { id = null }) => {
    const loading = !state.schedules.loaded
    if (typeof id === 'string' && id.length > 0) {
      return withSchedules({ ...state, island: false }, { open: true, selected: id, explicit: true, loading, error: null })
    }
    const ordered = orderScheduleList(state.schedules.schedules as readonly ScheduleView[])
    const selected = state.schedules.selected && ordered.some((item) => item.id === state.schedules.selected)
      ? state.schedules.selected : ordered[0]?.id ?? null
    return withSchedules({ ...state, island: false }, { open: true, selected, explicit: false, loading, error: null })
  },
  schedules_close: (state) => (state.schedules.open ? withSchedules(state, { open: false }) : state),
  schedules_select: (state, { id }) => withSchedules(state, { selected: id, explicit: false, error: null }),
  schedules_loaded: (state, { schedules, clearExplicit = false }) => {
    const ordered = Array.isArray(schedules) ? orderScheduleList(schedules) : orderScheduleList(state.schedules.schedules as readonly ScheduleView[])
    const found = Boolean(state.schedules.selected && ordered.some((item) => item.id === state.schedules.selected))
    if (!clearExplicit && state.schedules.explicit && state.schedules.selected) {
      return withSchedules(state, { schedules: ordered, loaded: true, loading: false, error: null })
    }
    const selected = found ? state.schedules.selected : ordered[0]?.id ?? null
    return withSchedules(state, { schedules: ordered, selected, explicit: false, loaded: true, loading: false, error: null })
  },
  schedules_busy: (state) => withSchedules(state, { busy: true, error: null }),
  schedules_done: (state) => withSchedules(state, { busy: false }),
  schedules_failed: (state, { message }) => withSchedules(state, { loading: false, busy: false, error: typeof message === 'string' ? message : null }),
}
