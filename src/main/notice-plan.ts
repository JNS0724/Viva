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
 * Nothing else is ever a reason to speak: no time passing, no launch by itself, no model deciding.
 */
export const DAILY_CAP = 3
/** A reminder more than this late (the computer was asleep) is a missed one: told as such, with the others. */
export const LATE_MS = 10 * 60 * 1000

export type NoticeKind = 'reminder' | 'missed' | 'ready'
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
  return followups.length > MAX_TITLES ? `${shown} 等 ${followups.length} 件` : shown
}

/** What a reminder says beside its title: the draft is waiting, or it could not be made ready in time. */
function reminderBody(followup: Followup): string {
  if (followup.status === 'ready' || followup.status === 'seen') return '准备好了，点开看'
  if (followup.prepareBy !== null) return '还没准备好（你一直在忙），要现在准备吗？'
  return followup.ask
}

/** The notices to send now. */
export function planNotices({ now, followups, interruptionsToday, cap = DAILY_CAP, atGap, windowInFront, toldReady, suggestions = [] }: PlanInput): Notice[] {
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
      title: missed.length === 1 ? missed[0].title : `错过的提醒 · ${missed.length} 件`,
      body: `原定于 ${clock(first)}：${titles(missed)}`,
      interrupts: false,
      system: true,
    })
  }
  const reminding = new Set(due.map((f) => f.id))
  const ready = open.filter((f) => f.status === 'ready' && !toldReady.has(f.id) && !reminding.has(f.id))
  if ((ready.length || suggestions.length) && atGap && (windowInFront || interruptionsToday < cap)) {
    const both = ready.length && suggestions.length
    notices.push({
      kind: 'ready',
      followupIds: [...ready.map((f) => f.id), ...suggestions.map((s) => s.id)],
      title: both ? `准备好 ${ready.length} 件 · ${suggestions.length} 条消息要你看看`
        : ready.length ? `准备好 ${ready.length} 件，等你看` : `${suggestions.length} 条消息可能要你处理`,
      body: ready.length ? `${titles([...ready, ...suggestions])} · 都还没动，等你点头` : `${titles(suggestions)} · 要不要跟进，由你定`,
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
