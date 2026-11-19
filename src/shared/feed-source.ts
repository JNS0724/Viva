/**
 * Plugin-backed data sources for 动态 (system-design §12.2): explicit schedule shape, shared views,
 * and conversion into dsh-schedule rules. Pure TypeScript with no Node/DOM dependencies so both
 * backend and renderer share the same validation and formatting contract.
 */

export const FEED_SOURCE_INTERVALS = Object.freeze([15, 30, 60, 120, 240] as const)
export const MAX_SOURCE_NAME_CHARS = 120
export const MAX_SOURCE_PLUGIN_CHARS = 214
export const MAX_SOURCE_INSTRUCTION_CHARS = 20_000
export const MAX_SOURCE_CRON_CHARS = 120

export type FeedSourceSchedule =
  | { kind: 'interval', minutes: number, timeZone?: string }
  | { kind: 'daily', time: string, timeZone?: string }
  | { kind: 'weekly', weekdays: readonly number[], time: string, timeZone?: string }
  | { kind: 'cron', expression: string, timeZone?: string }

export type FeedSourceStatus = 'active' | 'paused'
export type FeedSourceLastStatus = 'idle' | 'published' | 'skipped' | 'failed' | 'plugin_unavailable'

export interface FeedSourceView {
  id: string
  pluginName: string
  name: string
  instruction: string
  schedule: FeedSourceSchedule
  status: FeedSourceStatus
  nextAt: string
  lastRunAt: number | null
  lastStatus: FeedSourceLastStatus
  lastMessage: string | null
  lastPublishedCount: number
  createdAt: number
  updatedAt: number
}

export interface FeedSourceCreateInput {
  pluginName: string
  name?: string
  instruction: string
  schedule: FeedSourceSchedule
}

export interface FeedSourceUpdateInput {
  name?: string
  instruction?: string
  schedule?: FeedSourceSchedule
  paused?: boolean
}

export interface FeedSourceRunResult {
  status: Exclude<FeedSourceLastStatus, 'idle'>
  publishedCount: number
  message: string | null
  source: FeedSourceView
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/
const ALLOWED_INTERVALS = new Set<number>(FEED_SOURCE_INTERVALS)

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function zoneOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 100 ? value.trim() : fallback
}

function parseTime(value: unknown): string {
  if (typeof value !== 'string' || !HM.test(value.trim())) throw new Error('invalid schedule time')
  return value.trim()
}

function parseWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) throw new Error('invalid schedule weekdays')
  const days = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 7) throw new Error('invalid schedule weekdays')
    days.add(item)
  }
  return [...days].sort((a, b) => a - b)
}

/** Validates and normalizes an incoming explicit schedule configuration. */
export function parseFeedSourceSchedule(value: unknown, fallbackTimeZone = localTimeZone()): FeedSourceSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid schedule')
  const raw = value as Record<string, unknown>
  const timeZone = zoneOf(raw.timeZone, fallbackTimeZone)
  if (raw.kind === 'interval') {
    const minutes = Number(raw.minutes)
    if (!Number.isInteger(minutes) || !ALLOWED_INTERVALS.has(minutes)) throw new Error('invalid interval')
    return { kind: 'interval', minutes, timeZone }
  }
  if (raw.kind === 'daily') {
    return { kind: 'daily', time: parseTime(raw.time), timeZone }
  }
  if (raw.kind === 'weekly') {
    return { kind: 'weekly', weekdays: parseWeekdays(raw.weekdays), time: parseTime(raw.time), timeZone }
  }
  if (raw.kind === 'cron') {
    if (typeof raw.expression !== 'string') throw new Error('invalid cron expression')
    const expression = raw.expression.trim()
    if (!expression || expression.length > MAX_SOURCE_CRON_CHARS) throw new Error('invalid cron expression')
    return { kind: 'cron', expression, timeZone }
  }
  throw new Error('invalid schedule kind')
}

function intervalCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`
  const hours = minutes / 60
  return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`
}

/** Converts an explicit FeedSourceSchedule into a dsh-schedule ScheduleRule input. */
export function toDshScheduleRule(schedule: FeedSourceSchedule, fallbackTimeZone = localTimeZone()) {
  const time_zone = zoneOf(schedule.timeZone, fallbackTimeZone)
  if (schedule.kind === 'interval') {
    return { kind: 'cron' as const, cron: { expression: intervalCron(schedule.minutes), time_zone } }
  }
  if (schedule.kind === 'daily') {
    return { kind: 'daily' as const, daily: { time: `${schedule.time}:00`, time_zone } }
  }
  if (schedule.kind === 'weekly') {
    return { kind: 'weekly' as const, weekly: { time: `${schedule.time}:00`, time_zone, weekdays: [...schedule.weekdays] } }
  }
  return { kind: 'cron' as const, cron: { expression: schedule.expression, time_zone } }
}
