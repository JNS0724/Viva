import { dayOf, type Followup, type FollowupStore } from './followup-store.ts'
import { nextReminderAt, planNotices, type Notice } from './notice-plan.ts'

/**
 * Sends what notice-plan.ts decides, when it is worth deciding: at a reminder's time (a timer for the next one),
 * in the user's gaps, and on waking (launch, the computer back from sleep), which is also when missed reminders
 * are caught up, merged into one. The tray shows how many are ready.
 *
 * Gaps: the window coming back to the front and a turn of the user's ending (main.ts reports those), and the
 * user back at the computer after 15 minutes away (createGapWatch). Nothing else counts as one.
 */
const MINUTE_MS = 60_000
/** setTimeout holds at most about 24.8 days; a reminder further off is looked at again in a day. */
const MAX_TIMER_MS = 24 * 60 * MINUTE_MS
/** Away this long, the user's return is a gap. */
export const AWAY_SECONDS = 15 * 60
const IDLE_POLL_MS = MINUTE_MS

type Timer = ReturnType<typeof setTimeout>

export interface NotifierDeps {
  store: Pick<FollowupStore, 'list' | 'markReminded' | 'logNotice' | 'interruptionsOn' | 'lastToldAt' | 'logEvent'>
  /** Shows a system notification. */
  notify: (notice: Notice) => void
  windowInFront: () => boolean
  /** How many follow-ups wait for the user (ready, not looked at), for the tray and the island. */
  onPending?: (count: number) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (timer: Timer) => void
}

const ENDED = new Set(['done', 'dismissed'])

/** The ready follow-ups the user was told of since their drafts were made. */
function toldSet(followups: readonly Followup[], lastToldAt: (id: string) => number | null): Set<string> {
  return new Set(followups.filter((f) => {
    if (f.status !== 'ready') return false
    const told = lastToldAt(f.id)
    return told !== null && told >= (f.draftAt ?? 0)
  }).map((f) => f.id))
}

export function createFollowupNotifier(deps: NotifierDeps) {
  const { store, notify, windowInFront, onPending = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = deps
  let timer: Timer | null = null
  let stopped = false

  const open = () => store.list().filter((f) => !ENDED.has(f.status))

  function send(notice: Notice, followups: readonly Followup[]) {
    const at = now()
    if (notice.system) notify(notice)
    if (notice.kind === 'reminder') notice.followupIds.forEach((id) => store.markReminded(id))
    if (notice.kind === 'missed') {
      const due = new Map(followups.map((f) => [f.id, f.remindAt]))
      notice.followupIds.forEach((id) => store.markReminded(id, due.get(id) ?? at))
    }
    store.logNotice(notice.kind, notice.followupIds, notice.interrupts)
    store.logEvent('notice', { kind: notice.kind, count: notice.followupIds.length, system: notice.system, day: dayOf(at) })
  }

  /** Decides and sends; then waits for the next reminder. */
  function check({ atGap }: { atGap: boolean }): Notice[] {
    if (stopped) return []
    const followups = open()
    const notices = planNotices({
      now: now(),
      followups,
      interruptionsToday: store.interruptionsOn(),
      atGap,
      windowInFront: windowInFront(),
      toldReady: toldSet(followups, store.lastToldAt),
    })
    notices.forEach((notice) => send(notice, followups))
    refresh()
    return notices
  }

  /** Brings the timer and the count in line with the follow-ups as they are now (after any change to them). */
  function refresh() {
    if (stopped) return
    const followups = open()
    onPending(followups.filter((f) => f.status === 'ready').length)
    if (timer) clearTimer(timer)
    timer = null
    const next = nextReminderAt(followups, now())
    if (next === null) return
    timer = setTimer(() => {
      timer = null
      check({ atGap: false })
    }, Math.min(Math.max(0, next - now()), MAX_TIMER_MS))
  }

  return {
    /** The user is in a gap: what is ready may be told. */
    gap: () => check({ atGap: true }),
    /** Launched, or the computer is back from sleep: reminders missed meanwhile go out, merged. */
    wake: () => check({ atGap: false }),
    refresh,
    stop() {
      stopped = true
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}

export type FollowupNotifier = ReturnType<typeof createFollowupNotifier>

/** Back at the computer after being away 15 minutes, asked of the system's idle time once a minute. */
export function createGapWatch({ idleSeconds, onGap, setRepeat = setInterval, clearRepeat = clearInterval }: {
  idleSeconds: () => number
  onGap: () => void
  setRepeat?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearRepeat?: (handle: ReturnType<typeof setInterval>) => void
}) {
  let away = false
  const handle = setRepeat(() => {
    const idle = idleSeconds()
    if (away && idle < IDLE_POLL_MS / 1000) onGap()
    away = idle >= AWAY_SECONDS
  }, IDLE_POLL_MS)
  return { stop: () => clearRepeat(handle) }
}
