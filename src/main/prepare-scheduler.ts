import type { Followup, FollowupStore, ReadFile } from './followup-store.ts'
import type { MessageJudge } from './message-judge.ts'
import { isActive, nextActive, nextWindow, slotFor, type PrepareSchedule } from './prepare-schedule.ts'

/**
 * Background preparation in batches: at the windows the user picked, everything due is prepared one after the
 * other, read-only (prepare-materials.ts, the followups plugin's tool-less call). It runs only when nothing of
 * the user's is: no turn running, no task of theirs going (waiting on the user does not count), inside the
 * active hours, under the day's calls; otherwise it waits and looks again. It yields: once the user starts
 * something, it stops after the item at hand, and what is left waits for the next quiet moment. 叫醒它 stops even
 * that. What was halfway when Viva quit is prepared again, never left 'preparing'. New messages from the sources
 * wait for the next window too, and are judged first in its batch (message-judge.ts).
 */
/** What the batch says it is doing while it judges new messages. */
const JUDGING = '看新消息'
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
/** Waiting on the user to be done, it looks again this often. */
export const BLOCKED_RETRY_MS = 2 * MINUTE_MS
/** An item whose preparation failed is tried again no sooner than this. */
export const FAILED_RETRY_MS = 15 * MINUTE_MS
/** Woken (叫醒它), it rests this long before preparing again. */
export const WOKEN_REST_MS = 30 * MINUTE_MS
/** setTimeout holds at most about 24.8 days. */
const MAX_TIMER_MS = DAY_MS

/** `called: false` on a failure: no model was asked, so it costs none of the day's calls. */
export type Prepared = { ok: true, draft: string, readFiles: ReadFile[] } | { ok: false, problem: string, called?: false } | { skip: string }

export interface PrepareState {
  running: boolean
  /** The title of what is being prepared now. */
  current: string | null
  /** How many are due and waiting, the current one aside. */
  queued: number
  /** When it looks next, or null when nothing waits. */
  nextAt: number | null
  /** Why it waits although something is due (the user is busy, outside the active hours…). */
  waiting: string | null
}

export interface SchedulerDeps {
  store: Pick<FollowupStore, 'list' | 'get' | 'setStatus' | 'finishPreparing' | 'moveStatus' | 'logEvent' | 'countEvents'>
  schedule: () => PrepareSchedule
  /** Why preparation must wait now (a turn or task of the user's going), or null when it may run. */
  busy: () => string | null
  prepare: (followup: Followup, signal: AbortSignal) => Promise<Prepared>
  onState?: (state: PrepareState) => void
  /** Something was made ready: the notifier may tell it in the user's next gap. */
  onReady?: () => void
  /** New messages to judge in the batches (message sources); none without sources. */
  judge?: Pick<MessageJudge, 'run' | 'pendingSince'>
  /** What went wrong in a batch, for the log; the batch is tried again later. */
  onError?: (err: unknown) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0)

export function createPrepareScheduler(deps: SchedulerDeps) {
  const { store, schedule, busy, prepare, judge, onState = () => {}, onReady = () => {}, onError = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = deps
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: AbortController | null = null
  /** The follow-up being prepared now. */
  let current: string | null = null
  /** A batch went wrong (the store failing): nothing runs before then. */
  let brokenUntil = 0
  let yielding = false
  let stopped = false
  /** Until when it rests after being woken. */
  let restUntil = 0
  /** Asked for now (现在就准备): no window waited for. */
  const asap = new Set<string>()
  const retryAfter = new Map<string, number>()
  let judgeRetryAfter = 0
  let lastState: PrepareState = { running: false, current: null, queued: 0, nextAt: null, waiting: null }

  /** When `followup` is due to be prepared; null when it needs no preparation (any more). */
  function dueAt(followup: Followup, plan: PrepareSchedule): number | null {
    if (followup.status !== 'scheduled') return null
    const retry = retryAfter.get(followup.id) ?? 0
    // Asked for now, it is prepared even when it was only to be reminded of.
    if (asap.has(followup.id)) return Math.max(followup.createdAt, retry)
    if (followup.prepareBy === null) return null
    return Math.max(slotFor(followup.prepareBy, followup.createdAt, plan), retry)
  }

  /** When new messages are judged: the first window after the oldest arrived; null when none waits. */
  function judgeDueAt(plan: PrepareSchedule): number | null {
    const since = judge?.pendingSince() ?? null
    if (since === null) return null
    const window = nextWindow(since - 1, plan)
    return window === null ? null : Math.max(window, judgeRetryAfter)
  }

  function report(state: Partial<PrepareState>) {
    lastState = { ...lastState, ...state }
    onState(lastState)
  }

  function wake(at: number) {
    if (timer) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      tick()
    }, Math.min(Math.max(0, at - now()), MAX_TIMER_MS))
  }

  /** Why the due items must wait, and until when; null when they may run now. */
  function gate(plan: PrepareSchedule, due: readonly Followup[]): { why: string, until: number } | null {
    const at = now()
    const asked = due.some((f) => asap.has(f.id))
    if (plan.pausedUntil !== null && plan.pausedUntil > at) return { why: '暂停中', until: plan.pausedUntil }
    if (!asked && restUntil > at) return { why: '刚叫醒，过一会儿再准备', until: restUntil }
    if (brokenUntil > at) return { why: '上次准备出错了，过一会儿再试', until: brokenUntil }
    if (!asked && !isActive(at, plan)) return { why: '不在活跃时间段', until: nextActive(at, plan) }
    if (store.countEvents('prepare_call', startOfDay(at)) >= plan.dailyCalls) return { why: '今天的调用用完了', until: nextActive(startOfDay(at) + DAY_MS, plan) }
    const userBusy = busy()
    if (userBusy) return { why: userBusy, until: at + BLOCKED_RETRY_MS }
    return null
  }

  /** Looks at what is due: runs a batch, or waits for the next due time or for the user to be done. */
  function tick() {
    if (stopped || running) return
    const plan = schedule()
    const at = now()
    const pending = store.list().flatMap((f) => {
      const due = dueAt(f, plan)
      return due === null ? [] : [{ f, due }]
    })
    const due = pending.filter((item) => item.due <= at).map((item) => item.f).sort((a, b) => (a.prepareBy ?? 0) - (b.prepareBy ?? 0))
    const judgeDue = judgeDueAt(plan)
    const judgeNow = judgeDue !== null && judgeDue <= at
    if (!due.length && !judgeNow) {
      const times = [...pending.map((item) => item.due), ...(judgeDue === null ? [] : [judgeDue])]
      const next = times.length ? Math.min(...times) : null
      report({ running: false, current: null, queued: 0, nextAt: next, waiting: null })
      if (next !== null) wake(next)
      return
    }
    const wait = gate(plan, due)
    if (wait) {
      report({ running: false, current: null, queued: due.length, nextAt: wait.until, waiting: wait.why })
      wake(wait.until)
      return
    }
    void runBatch(due, judgeNow)
  }

  /** New messages first: suggestions for what needs the user; failed, tried again no sooner than a while. */
  async function judgeMessages(controller: AbortController) {
    if (!judge) return
    report({ running: true, current: JUDGING, waiting: null })
    try {
      const result = await judge.run(controller.signal)
      if (!result.ok && !controller.signal.aborted) judgeRetryAfter = now() + FAILED_RETRY_MS
      if (result.suggested) onReady()
    } catch {
      if (!controller.signal.aborted) judgeRetryAfter = now() + FAILED_RETRY_MS
    }
  }

  async function prepareOne(followup: Followup, controller: AbortController) {
    if (!store.moveStatus(followup.id, 'scheduled', 'preparing')) return
    current = followup.id
    let result: Prepared
    try {
      result = await prepare(followup, controller.signal)
    } catch (err) {
      result = { ok: false, problem: err instanceof Error ? err.message : String(err) }
    } finally {
      current = null
    }
    // Stopped meanwhile (quitting): the store may be closing; the item is prepared again at the next launch.
    if (stopped) return
    asap.delete(followup.id)
    if ('skip' in result) {
      if (store.finishPreparing(followup.id, result.skip, [])) onReady()
      store.logEvent('prepare_skipped', { id: followup.id })
      return
    }
    if (result.ok || result.called !== false) {
      store.logEvent('prepare_call', result.ok ? { id: followup.id, ok: true } : { id: followup.id, ok: false, problem: result.problem })
    }
    // Kept only if still being prepared: dismissed or done meanwhile, it does not come back.
    if (result.ok) {
      if (store.finishPreparing(followup.id, result.draft, result.readFiles)) onReady()
      return
    }
    store.moveStatus(followup.id, 'preparing', 'scheduled')
    if (!controller.signal.aborted) retryAfter.set(followup.id, now() + FAILED_RETRY_MS)
  }

  /**
   * One after the other, stopping after the item at hand once the user starts something, or once the gate shuts
   * (paused, the day's calls used, the user busy). Anything that breaks the batch is logged and it is tried later.
   */
  async function runBatch(due: readonly Followup[], judgeNow: boolean) {
    const controller = new AbortController()
    running = controller
    yielding = false
    try {
      if (judgeNow) await judgeMessages(controller)
      for (const [index, item] of due.entries()) {
        if (yielding || controller.signal.aborted || stopped) break
        if (index > 0 && gate(schedule(), due.slice(index))) break
        const followup = store.get(item.id)
        if (!followup || followup.status !== 'scheduled') continue
        report({ running: true, current: followup.title, queued: due.length - index - 1, waiting: null })
        await prepareOne(followup, controller)
      }
    } catch (err) {
      onError(err)
      brokenUntil = now() + FAILED_RETRY_MS
    } finally {
      running = null
      yielding = false
      if (!stopped) tick()
    }
  }

  return {
    /** Launch: what was halfway when Viva quit is due again; then the first look. */
    start() {
      store.list().filter((f) => f.status === 'preparing').forEach((f) => store.setStatus(f.id, 'scheduled'))
      tick()
    },
    /** After a follow-up or the schedule changed, or the user is done: looks again now. */
    refresh: tick,
    /** The user started something: stop after the item at hand. */
    yieldToUser() {
      if (running) yielding = true
    },
    /** 叫醒它: stop now, the item at hand included; it rests a while before preparing again. */
    wakeUp() {
      restUntil = now() + WOKEN_REST_MS
      running?.abort()
      yielding = true
    },
    /** Dismissed or done while being prepared: stop preparing it now. */
    abandon(id: string) {
      if (current === id) running?.abort()
    },
    /** 现在就准备: no window waited for, nor the active hours. */
    prepareNow(id: string) {
      asap.add(id)
      retryAfter.delete(id)
      tick()
    },
    state: () => lastState,
    stop() {
      stopped = true
      running?.abort()
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}

export type PrepareScheduler = ReturnType<typeof createPrepareScheduler>
