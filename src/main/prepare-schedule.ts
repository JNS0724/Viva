/**
 * When background preparation may run: at the times the user picks (时段), in batches, never per item. Picked the
 * first time it is needed and changed in settings: a preset (three, two or one a day) or times of the user's own
 * (at most six, an hour apart at least), weekdays and weekends apart (weekends may be off). Something due later is
 * prepared in the last window at least an hour before it; when no window comes in time, at the next chance.
 * Nothing runs outside the active hours, or while paused from the tray.
 */
export const PRESETS = Object.freeze({
  three: Object.freeze(['08:30', '12:30', '16:30']),
  two: Object.freeze(['09:00', '17:00']),
  one: Object.freeze(['08:30']),
})
export type Preset = keyof typeof PRESETS | 'custom'
export type WeekendMode = 'same' | 'off' | 'custom'

export interface PrepareSchedule {
  /** The user has picked their windows (the first time preparation is needed, they are asked). */
  chosen: boolean
  preset: Preset
  weekday: string[]
  weekendMode: WeekendMode
  weekend: string[]
  activeFrom: string
  activeTo: string
  /** Model calls background preparation may make in a day, its own, apart from the user's tasks. */
  dailyCalls: number
  /** Paused from the tray until then (ms), or null. */
  pausedUntil: number | null
}

export const MAX_WINDOWS = 6
const MIN_GAP_MINUTES = 60
/** Prepared at least this long before what it is for. */
export const LEAD_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const LOOKAHEAD_DAYS = 8
const MAX_SLOT_DAYS = 60
const DEFAULT_DAILY_CALLS = 30
const MAX_DAILY_CALLS = 200
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const PRESET_NAMES: readonly string[] = ['three', 'two', 'one', 'custom']
const WEEKEND_MODES: readonly string[] = ['same', 'off', 'custom']

export const DEFAULT_SCHEDULE: Readonly<PrepareSchedule> = Object.freeze({
  chosen: false,
  preset: 'three',
  weekday: [...PRESETS.three],
  weekendMode: 'same',
  weekend: [],
  activeFrom: '08:00',
  activeTo: '22:00',
  dailyCalls: DEFAULT_DAILY_CALLS,
  pausedUntil: null,
})

const minutesOf = (time: string) => {
  const [, h, m] = TIME.exec(time) as RegExpExecArray
  return Number(h) * 60 + Number(m)
}

/** Times as the user typed them, checked: HH:MM, at most six, an hour apart; sorted. */
export function checkTimes(times: unknown, what = '时段'): string[] {
  if (!Array.isArray(times)) throw new Error(`${what}不对`)
  const bad = times.find((time) => typeof time !== 'string' || !TIME.test(time))
  if (bad !== undefined) throw new Error(`${what}要写成 08:30 这样：${String(bad).slice(0, 20)}`)
  const sorted = [...new Set(times as string[])].sort((a, b) => minutesOf(a) - minutesOf(b))
  if (!sorted.length) throw new Error(`${what}至少要有一个`)
  if (sorted.length > MAX_WINDOWS) throw new Error(`${what}最多 ${MAX_WINDOWS} 个`)
  const close = sorted.find((time, i) => i > 0 && minutesOf(time) - minutesOf(sorted[i - 1]) < MIN_GAP_MINUTES)
  if (close) throw new Error(`${what}相邻至少隔 1 小时：${close}`)
  return sorted
}

const freshDefault = (): PrepareSchedule => ({ ...DEFAULT_SCHEDULE, weekday: [...DEFAULT_SCHEDULE.weekday], weekend: [] })

/** A whole schedule, checked; throws in the user's words. Presets take their own times. */
export function checkSchedule(input: Partial<PrepareSchedule>): PrepareSchedule {
  const merged = { ...freshDefault(), ...input }
  const preset = (PRESET_NAMES.includes(merged.preset) ? merged.preset : 'three') as Preset
  const weekday = preset === 'custom' ? checkTimes(merged.weekday, '工作日的时段') : [...PRESETS[preset]]
  const weekendMode = (WEEKEND_MODES.includes(merged.weekendMode) ? merged.weekendMode : 'same') as WeekendMode
  const weekend = weekendMode === 'custom' ? checkTimes(merged.weekend, '周末的时段') : []
  const { activeFrom, activeTo } = merged
  if (!TIME.test(activeFrom) || !TIME.test(activeTo) || minutesOf(activeFrom) >= minutesOf(activeTo)) throw new Error('活跃时间段不对')
  const dailyCalls = Number.isInteger(merged.dailyCalls) && merged.dailyCalls > 0 ? Math.min(merged.dailyCalls, MAX_DAILY_CALLS) : DEFAULT_DAILY_CALLS
  const pausedUntil = typeof merged.pausedUntil === 'number' && Number.isFinite(merged.pausedUntil) ? merged.pausedUntil : null
  return { chosen: merged.chosen === true, preset, weekday, weekendMode, weekend, activeFrom, activeTo, dailyCalls, pausedUntil }
}

/** A schedule as kept (preferences.json), checked; what does not fit falls back to the default. */
export function scheduleOf(raw: unknown): PrepareSchedule {
  if (!raw || typeof raw !== 'object') return freshDefault()
  try {
    return checkSchedule(raw as Partial<PrepareSchedule>)
  } catch {
    return freshDefault()
  }
}

const atTime = (day: Date, time: string) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutesOf(time) / 60), minutesOf(time) % 60).getTime()
const isWeekend = (day: Date) => day.getDay() === 0 || day.getDay() === 6

/** The window times of the local day `day` falls on. */
export function windowsOn(day: number, schedule: PrepareSchedule): number[] {
  const date = new Date(day)
  if (!isWeekend(date) || schedule.weekendMode === 'same') return schedule.weekday.map((time) => atTime(date, time))
  return schedule.weekendMode === 'off' ? [] : schedule.weekend.map((time) => atTime(date, time))
}

/** Every window from `from` (inclusive) for the next `days` days, in order. */
function windowsFrom(from: number, schedule: PrepareSchedule, days = LOOKAHEAD_DAYS): number[] {
  const start = new Date(from)
  const all: number[] = []
  for (let i = 0; i < days; i += 1) all.push(...windowsOn(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime(), schedule))
  return all.filter((at) => at >= from)
}

/** The next window after `now`, or null when none comes in the next days. */
export function nextWindow(now: number, schedule: PrepareSchedule): number | null {
  return windowsFrom(now + 1, schedule)[0] ?? null
}

/**
 * When something due at `deadline` is prepared: the last window between `since` (when it was agreed) and an hour
 * before the deadline; `since` itself (as soon as may be) when no window falls in between.
 */
export function slotFor(deadline: number, since: number, schedule: PrepareSchedule): number {
  const latest = deadline - LEAD_MS
  if (latest <= since) return since
  // Far off, only the days before it are looked at: prepared near the time, not two months early.
  const from = Math.max(since, latest - (MAX_SLOT_DAYS - 1) * DAY_MS)
  const days = Math.ceil((latest - from) / DAY_MS) + 1
  return windowsFrom(from, schedule, days).filter((at) => at <= latest).at(-1) ?? since
}

/** Inside the active hours of `now`'s day. */
export function isActive(now: number, schedule: PrepareSchedule): boolean {
  const date = new Date(now)
  return now >= atTime(date, schedule.activeFrom) && now < atTime(date, schedule.activeTo)
}

/** When the next active hours start, from `now` (now itself when inside them). */
export function nextActive(now: number, schedule: PrepareSchedule): number {
  if (isActive(now, schedule)) return now
  const date = new Date(now)
  const today = atTime(date, schedule.activeFrom)
  return now < today ? today : atTime(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1), schedule.activeFrom)
}
