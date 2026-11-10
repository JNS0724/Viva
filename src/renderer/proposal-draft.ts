/**
 * A schedule's proposal in the words of its card's form, and back (view/proposal-card.ts): how often (once, every
 * day, some weekdays, a day of the month), at what time, on what date or days. The model often writes a cron; the
 * common ones read as these words, so the user never edits an expression; only one the form cannot say stays as it is.
 */
import type { ProposalDraft, RepeatKind, ScheduleEdits, ScheduleProposal, ScheduleRuleView } from './proposal-types.ts'

/** dsh-schedule's limit on a schedule's name. */
export const MAX_TITLE_CHARS = 120
const DAYS_IN_WEEK = 7
const MAX_MONTH_DAY = 31
const MAX_HOUR = 23
const MAX_MINUTE = 59
const HM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const NUMBER = /^\d{1,2}$/

/** What a draft lacks, said on the card. */
export type DraftProblem = 'schedule.edit.title.missing' | 'schedule.edit.title.long' | 'schedule.edit.prompt.missing' | 'schedule.edit.time.invalid'
  | 'schedule.edit.date.invalid' | 'schedule.edit.weekdays.missing' | 'schedule.edit.day.invalid' | 'schedule.edit.cron.missing'

/** A cron the form can say: every day, on some weekdays (ISO, Monday 1), or on a day of the month; at a time. */
export type CronShape = { repeat: 'daily', time: string } | { repeat: 'weekly', time: string, weekdays: readonly number[] } | { repeat: 'monthly', time: string, day: number }

const within = (text: string, max: number, min = 0): number | null => {
  if (!NUMBER.test(text)) return null
  const value = Number(text)
  return value >= min && value <= max ? value : null
}

/** A cron's day-of-week field as ISO weekdays (0 and 7 both Sunday), or null for steps, names and the like. */
function weekdaysOf(field: string): number[] | null {
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const bounds = part.split('-')
    const start = within(bounds[0], DAYS_IN_WEEK), end = within(bounds.at(-1)!, DAYS_IN_WEEK)
    if (bounds.length > 2 || start === null || end === null || start > end) return null
    for (let day = start; day <= end; day += 1) days.add(day === 0 ? DAYS_IN_WEEK : day)
  }
  return [...days].sort((a, b) => a - b)
}

/** What a cron says in the form's words, or null when it says more (steps, months, several times a day). */
export function cronShape(expression: string): CronShape | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minuteField, hourField, dayField, monthField, weekField] = fields
  const minute = within(minuteField, MAX_MINUTE), hour = within(hourField, MAX_HOUR)
  if (minute === null || hour === null || monthField !== '*') return null
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (dayField === '*' && weekField === '*') return { repeat: 'daily', time }
  if (dayField === '*') {
    const weekdays = weekdaysOf(weekField)
    if (!weekdays) return null
    return weekdays.length === DAYS_IN_WEEK ? { repeat: 'daily', time } : { repeat: 'weekly', time, weekdays }
  }
  const day = within(dayField, MAX_MONTH_DAY, 1)
  return day !== null && weekField === '*' ? { repeat: 'monthly', time, day } : null
}

/** The window's own time zone, for a rule that names none. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The zone a rule's times are in: its own, else the window's. */
export function zoneOf(rule: ScheduleRuleView): string {
  const input = rule.kind === 'at' ? (typeof rule.at === 'object' ? rule.at : undefined) : rule.kind === 'daily' ? rule.daily : rule.kind === 'weekly' ? rule.weekly : rule.cron
  return input?.time_zone || localZone()
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** An instant on the wall clock of a zone: its date, time and ISO weekday. */
export function wallClock(ts: number, zone: string): { date: string, time: string, weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(ts)).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: WEEKDAY_NAMES.indexOf(parts.weekday) + 1 }
}

/** The repeat and its values a rule has, in the form's words. */
function repeatOf(rule: ScheduleRuleView): { repeat: RepeatKind, time?: string, weekdays?: readonly number[], day?: number } {
  if (rule.kind === 'daily') return { repeat: 'daily', time: rule.daily.time.slice(0, 5) }
  if (rule.kind === 'weekly') return { repeat: 'weekly', time: rule.weekly.time.slice(0, 5), weekdays: rule.weekly.weekdays }
  if (rule.kind === 'cron') return cronShape(rule.cron.expression) ?? { repeat: 'cron' }
  return { repeat: 'at' }
}

/** A proposal as its form first shows it; values a repeat does not use are those of its first run, for a switch to it. */
export function draftOf(proposal: ScheduleProposal, now: number): ProposalDraft {
  const zone = zoneOf(proposal.rule)
  const firstAt = Date.parse(proposal.firstAt)
  const first = wallClock(Number.isNaN(firstAt) ? now : firstAt, zone)
  const shape = repeatOf(proposal.rule)
  return {
    title: proposal.title, prompt: proposal.prompt, repeat: shape.repeat, zone,
    date: first.date, time: shape.time ?? first.time, weekdays: shape.weekdays ?? [first.weekday],
    day: shape.day ?? Number(first.date.slice(8)), expression: proposal.rule.kind === 'cron' ? proposal.rule.cron.expression : '',
  }
}

/** Whether a YYYY-MM-DD is a day of the calendar (no 2月30日). */
function isDate(text: string): boolean {
  const match = DATE.exec(text)
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The rule a draft says, or what in it is missing. A time is in the past only by the clock: the save says so. */
function ruleOf(draft: ProposalDraft): ScheduleEdits['rule'] | DraftProblem {
  const { zone: time_zone } = draft
  if (draft.repeat === 'cron') return draft.expression.trim() ? { kind: 'cron', cron: { expression: draft.expression.trim(), time_zone } } : 'schedule.edit.cron.missing'
  if (!HM.test(draft.time)) return 'schedule.edit.time.invalid'
  const time = `${draft.time}:00`
  if (draft.repeat === 'at') return isDate(draft.date) ? { kind: 'at', at: { date: draft.date, time, time_zone } } : 'schedule.edit.date.invalid'
  if (draft.repeat === 'daily') return { kind: 'daily', daily: { time, time_zone } }
  if (draft.repeat === 'weekly') {
    const weekdays = [...new Set(draft.weekdays)].filter((day) => Number.isInteger(day) && day >= 1 && day <= DAYS_IN_WEEK).sort((a, b) => a - b)
    return weekdays.length ? { kind: 'weekly', weekly: { time, weekdays, time_zone } } : 'schedule.edit.weekdays.missing'
  }
  if (!Number.isInteger(draft.day) || draft.day < 1 || draft.day > MAX_MONTH_DAY) return 'schedule.edit.day.invalid'
  const [hour, minute] = draft.time.split(':').map(Number)
  return { kind: 'cron', cron: { expression: `${minute} ${hour} ${draft.day} * *`, time_zone } }
}

/** What 定时 sends for a draft, or the problem to show on the card. */
export function editsOf(draft: ProposalDraft): { edits: ScheduleEdits } | { problem: DraftProblem } {
  const title = draft.title.trim(), prompt = draft.prompt.trim()
  if (!title) return { problem: 'schedule.edit.title.missing' }
  if (title.length > MAX_TITLE_CHARS) return { problem: 'schedule.edit.title.long' }
  if (!prompt) return { problem: 'schedule.edit.prompt.missing' }
  const rule = ruleOf(draft)
  return typeof rule === 'string' ? { problem: rule } : { edits: { title, prompt, rule } }
}

/** The proposal as kept with its edits: what the decided card shows. */
export const withEdits = (proposal: ScheduleProposal, edits: ScheduleEdits): ScheduleProposal => ({ ...proposal, ...edits })
