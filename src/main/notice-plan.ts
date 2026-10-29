import { t } from '../shared/i18n/translate.ts'
import type { Followup } from './followup-store.ts'

/**
 * When Viva tells the user what, decided from the follow-ups as they are (followup-notifier.ts sends it):
 * - a reminder goes out at the time the user agreed to, once; reminders are what the user asked for, so the
 *   day's cap does not hold them back. Reminders missed while the computer slept or Viva was closed go out
 *   together as one, marked with the time they were due.
 * - what is ready, and messages suggested for a follow-up, are told only in a gap (the window comes back, a turn
 *   ends, the user is back at the computer), once each, all together in one notice, and only while the day's
 *   interruptions are under the cap; past it, they wait for the next day's first gap. With the window in front,
 *   the window shows them instead of a notification.
 * - 今天: the day's first gap with something to say gathers it all in one notice (ready, suggested, to be reminded
 *   of today), once a day, under the cap; a day with nothing says nothing.
 * Nothing else is ever a reason to speak: no time passing, no launch by itself, no model deciding.
 */
export const DAILY_CAP = 3
/** A reminder more than this late (the computer was asleep) is a missed one: told as such, with the others. */
export const LATE_MS = 10 * 60 * 1000

export type NoticeKind = 'reminder' | 'missed' | 'ready' | 'today'
export interface Notice {
  kind: NoticeKind
  followupIds: string[]
  title: string
  body: string
  /** Counted against the day's cap. */
  interrupts: boolean
  /** Shown as a system notification; false when the window in front shows it already. */
  system: boolean
}

export interface PlanInput {
  now: number
  /** The follow-ups not ended. */
  followups: readonly Followup[]
  interruptionsToday: number
  cap?: number
  /** The user is in a gap right now. */
  atGap: boolean
  windowInFront: boolean
  /** Ready follow-ups the user was already told of. */
  toldReady: ReadonlySet<string>
  /** Messages suggested for a follow-up, open and not told of yet. */
  suggestions?: ReadonlyArray<{ id: string, title: string }>
  /** 今天 went out already today. */
  todayTold?: boolean
}

const pad = (n: number) => String(n).padStart(2, '0')
export const clock = (ts: number) => {
  const date = new Date(ts)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const OPEN = new Set(['scheduled', 'preparing', 'ready', 'seen'])
const MAX_TITLES = 3

/** Up to three titles, then how many more. */
function titles(followups: ReadonlyArray<{ title: string }>): string {
  const shown = followups.slice(0, MAX_TITLES).map((f) => f.title).join('、')
  return followups.length > MAX_TITLES ? t("main.notice-plan.and.others.total", { shown: shown, length: followups.length }) : shown
}

/** What a reminder says beside its title: the draft is waiting, or it could not be made ready in time. */
function reminderBody(followup: Followup): string {
  if (followup.status === 'ready' || followup.status === 'seen') return t("main.notice-plan.ready.open.to.review")
  if (followup.prepareBy !== null) return t("main.notice-plan.not.ready.yet.you.have.been.busy")
  return followup.ask
}

/** The notices to send now. */
const endOfDay = (ts: number) => new Date(ts).setHours(23, 59, 59, 999)

/** 今天: what waits for the user and what will be reminded of before the day ends, in one line. */
function todayNotice(ready: readonly Followup[], suggestions: ReadonlyArray<{ id: string, title: string }>, later: readonly Followup[], windowInFront: boolean): Notice {
  const parts = [
    ready.length ? t("main.notice-plan.ready", { length: ready.length }) : null,
    suggestions.length ? t("main.notice-plan.messages.to.review", { length: suggestions.length }) : null,
    later.length ? t("main.notice-plan.reminders.today", { length: later.length }) : null,
  ].filter(Boolean)
  return {
    kind: 'today',
    followupIds: [...ready.map((f) => f.id), ...suggestions.map((s) => s.id)],
    title: t("main.notice-plan.today"),
    body: `${parts.join(' · ')}：${titles([...ready, ...suggestions, ...later])}`,
    interrupts: !windowInFront,
    system: !windowInFront,
  }
}

export function planNotices({ now, followups, interruptionsToday, cap = DAILY_CAP, atGap, windowInFront, toldReady, suggestions = [], todayTold = true }: PlanInput): Notice[] {
  const open = followups.filter((f) => OPEN.has(f.status))
  const due = open.filter((f) => f.remindAt !== null && f.remindAt <= now && f.remindedAt === null)
  const onTime = due.filter((f) => now - (f.remindAt as number) <= LATE_MS)
  const missed = due.filter((f) => now - (f.remindAt as number) > LATE_MS)
  const notices: Notice[] = onTime.map((f) => ({ kind: 'reminder', followupIds: [f.id], title: f.title, body: reminderBody(f), interrupts: false, system: true }))
  if (missed.length) {
    const first = Math.min(...missed.map((f) => f.remindAt as number))
    notices.push({
      kind: 'missed',
      followupIds: missed.map((f) => f.id),
      title: missed.length === 1 ? missed[0].title : t("main.notice-plan.missed.reminders", { length: missed.length }),
      body: t("main.notice-plan.originally.scheduled.for", { value1: clock(first), value2: titles(missed) }),
      interrupts: false,
      system: true,
    })
  }
  const reminding = new Set(due.map((f) => f.id))
  const ready = open.filter((f) => f.status === 'ready' && !toldReady.has(f.id) && !reminding.has(f.id))
  const mayTell = atGap && (windowInFront || interruptionsToday < cap)
  const readyIds = new Set(ready.map((f) => f.id))
  const later = open.filter((f) => !readyIds.has(f.id) && f.remindAt !== null && f.remindAt > now && f.remindAt <= endOfDay(now) && f.remindedAt === null)
  if (mayTell && !todayTold && (ready.length || suggestions.length || later.length)) {
    notices.push(todayNotice(ready, suggestions, later, windowInFront))
    return notices
  }
  if ((ready.length || suggestions.length) && mayTell) {
    const both = ready.length && suggestions.length
    notices.push({
      kind: 'ready',
      followupIds: [...ready.map((f) => f.id), ...suggestions.map((s) => s.id)],
      title: both ? t("main.notice-plan.ready.messages.to.review", { length: ready.length, length2: suggestions.length })
        : ready.length ? t("main.notice-plan.ready.for.your.review", { length: ready.length }) : t("main.notice-plan.messages.may.need.your.attention", { length: suggestions.length }),
      body: ready.length ? t("main.notice-plan.no.action.taken.waiting.for.your.approval", { value1: titles([...ready, ...suggestions]) }) : t("main.notice-plan.you.decide.whether.to.follow.up", { value1: titles(suggestions) }),
      interrupts: !windowInFront,
      system: !windowInFront,
    })
  }
  return notices
}

/** When the next reminder falls due, to wake up for it; null when none is waiting. */
export function nextReminderAt(followups: readonly Followup[], now: number): number | null {
  const times = followups
    .filter((f) => OPEN.has(f.status) && f.remindAt !== null && f.remindedAt === null && (f.remindAt as number) > now)
    .map((f) => f.remindAt as number)
  return times.length ? Math.min(...times) : null
}
