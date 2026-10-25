/**
 * The week of self-use, in figures (步 7): whether suggestions were wanted (taken, turned down, muted), whether
 * notices came at the right time (opened, and how soon), what it cost (model calls, per day and per useful
 * suggestion), and how often a reminder came before its draft. Counted from followups.db's events; nothing leaves
 * the computer. Settings shows them under 后台准备.
 */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60_000
const DAYS = 7

export interface WeekStats {
  suggestions: { shown: number, accepted: number, declined: number, never: number, acceptRate: number | null }
  notices: { sent: number, opened: number, medianOpenMinutes: number | null }
  calls: { total: number, perDay: number[], perAccepted: number | null }
  late: number
  continued: number
  dismissed: number
}

type Event = { kind: string, at: number, data: Record<string, unknown> }

function median(values: readonly number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) / 100 : null)

/** The figures of the week before `now`, from its events. */
export function weekStats(events: readonly Event[], now: number): WeekStats {
  const count = (kind: string, test: (event: Event) => boolean = () => true) => events.filter((event) => event.kind === kind && test(event)).length
  const accepted = count('suggest_accepted')
  const declined = count('suggest_declined', (event) => event.data.never !== true)
  const never = count('suggest_declined', (event) => event.data.never === true)
  const openedAfter = events
    .filter((event) => event.kind === 'notice_opened' && typeof event.data.afterMs === 'number')
    .map((event) => event.data.afterMs as number)
  const calls = events.filter((event) => event.kind === 'prepare_call')
  const perDay = Array.from({ length: DAYS }, (_, i) => {
    const end = now - (DAYS - 1 - i) * DAY_MS
    return calls.filter((event) => event.at > end - DAY_MS && event.at <= end).length
  })
  const medianOpen = median(openedAfter)
  return {
    suggestions: { shown: count('suggest_shown'), accepted, declined, never, acceptRate: rate(accepted, accepted + declined + never) },
    notices: {
      sent: count('notice', (event) => event.data.system === true),
      opened: count('notice_opened'),
      medianOpenMinutes: medianOpen === null ? null : Math.round(medianOpen / MINUTE_MS),
    },
    calls: { total: calls.length, perDay, perAccepted: accepted ? Math.round((calls.length / accepted) * 10) / 10 : null },
    late: count('prepare_late'),
    continued: count('followup_continued'),
    dismissed: count('followup_dismissed'),
  }
}
