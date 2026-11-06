import type { DatabaseSync } from 'node:sqlite'
import { t } from '../shared/i18n/translate.ts'
import { transaction } from './app-db.ts'
import type { Apply } from './journal.ts'
import type { FeedItem, FeedStore } from './feed-store.ts'
import type { Occurrence, ScheduleStore } from './schedule-store.ts'
import type { RunResult } from './unattended-runs.ts'

/**
 * Schedules run when due (system-design §12.2). One timer, set for the soonest thing to do; when it fires, what is
 * due is taken from the schedules and kept as runs in the same transaction, so quitting between loses nothing and a
 * run not finished is run again on the next launch. Runs go one at a time, each prompt with read-only tools
 * (unattended-runs.ts); its answer becomes one item in 动态 (keyed by the occurrence, so never two) and a notice.
 * One that keeps failing becomes an item saying so. Each step is a change with its event (event-core.ts apply):
 * `schedule.taken`, `schedule.ran`, `schedule.retry`.
 */
export const SCHEDULE_SOURCE = 'schedule'
export const MAX_ATTEMPTS = 3
/** After a failed try, this long times the tries so far. */
export const RETRY_MS = 60 * 1000
/** The timer never waits longer at once: a computer asleep meanwhile does not move a timer's clock. */
export const MAX_WAIT_MS = 60 * 60 * 1000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedule_runs (
    key TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    at TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL
  );
`

interface Run { key: string, scheduleId: string, at: string, title: string, prompt: string, attempts: number, dueAt: number }
type Row = Record<string, unknown>
const runOf = (row: Row): Run => ({
  key: String(row.key), scheduleId: String(row.schedule_id), at: String(row.at), title: String(row.title),
  prompt: String(row.prompt), attempts: Number(row.attempts), dueAt: Number(row.due_at),
})

export interface ScheduleRunsDeps {
  db: DatabaseSync
  /** The event core's apply; without it (tests), a plain transaction. */
  apply?: Apply
  store: ScheduleStore
  feed: FeedStore
  /** Runs one prompt where nobody watches. */
  run: (prompt: string) => Promise<RunResult>
  /** A new item in 动态: told to the user. */
  delivered: (item: FeedItem) => void
  /** Schedules changed by being run (one that runs once has ended). */
  changed?: () => void
  now?: () => number
  later?: (run: () => void, ms: number) => unknown
  cancel?: (timer: never) => void
  onError?: (err: unknown) => void
}

export function createScheduleRuns({ db, apply, store, feed, run, delivered, changed = () => {}, now = Date.now, later = setTimeout, cancel = clearTimeout, onError = () => {} }: ScheduleRunsDeps) {
  db.exec(SCHEMA)
  const change: Apply = apply ?? ((_kind, _data, write) => ({ value: transaction(db, write) }))
  let timer: unknown = null
  let pumping = false
  let again = false
  /** dsh is not there: runs wait for `wake`, not for the timer. */
  let blocked = false
  let closed = false

  const queue = (occurrence: Occurrence) => db.prepare(`INSERT OR IGNORE INTO schedule_runs (key, schedule_id, at, title, prompt, attempts, due_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)`).run(occurrence.key, occurrence.schedule.id, occurrence.at, occurrence.schedule.record.title, occurrence.schedule.record.prompt, now())
  const due = (): Run[] => (db.prepare('SELECT * FROM schedule_runs WHERE due_at <= ? ORDER BY due_at, rowid').all(now()) as Row[]).map(runOf)
  const nextRunAt = (): number | null => {
    const row = db.prepare('SELECT MIN(due_at) AS at FROM schedule_runs').get() as { at: number | null }
    return row.at === null ? null : Number(row.at)
  }

  /** What is due, taken and kept as runs together. */
  function take(): void {
    if ((store.nextDueAt() ?? Infinity) > now()) return
    change('schedule.taken', {}, () => store.takeDue().map(queue))
    changed()
  }

  function arm(): void {
    if (timer !== null) cancel(timer as never)
    timer = null
    if (closed) return
    const times = [store.nextDueAt(), blocked ? null : nextRunAt()].filter((at): at is number => at !== null)
    if (!times.length) return
    const wait = Math.min(Math.max(Math.min(...times) - now(), 0), MAX_WAIT_MS)
    timer = later(tick, wait)
  }

  function tick(): void {
    timer = null
    try {
      take()
    } catch (err) {
      onError(err)
    }
    void pump()
  }

  /** Done with a run: its item made (or the one made before), the run gone, together. */
  function deliver(item: Run, body: string): void {
    const made = change('schedule.ran', { key: item.key }, () => {
      const added = feed.add({ source: SCHEDULE_SOURCE, key: item.key, title: item.title, body, origin: { label: t('main.schedule-runs.origin'), ref: item.scheduleId } })
      db.prepare('DELETE FROM schedule_runs WHERE key = ?').run(item.key)
      return added.made ? added.item : null
    }).value
    if (made) delivered(made)
  }

  /** false: dsh is not there; the rest wait. */
  async function runOne(item: Run): Promise<boolean> {
    const result = await run(item.prompt)
    if (!result.ok && result.unavailable) return false
    if (result.ok) {
      deliver(item, result.text)
      return true
    }
    const attempts = item.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      deliver(item, t('main.schedule-runs.failed', { value1: result.problem }))
      return true
    }
    change('schedule.retry', { key: item.key, attempts }, () => db.prepare('UPDATE schedule_runs SET attempts = ?, due_at = ? WHERE key = ?').run(attempts, now() + RETRY_MS * attempts, item.key))
    return true
  }

  async function pump(): Promise<void> {
    if (pumping) {
      again = true
      return
    }
    pumping = true
    try {
      do {
        again = false
        for (const item of due()) {
          if (closed) return
          if (!(await runOne(item))) {
            blocked = true
            return
          }
        }
      } while (again)
    } catch (err) {
      onError(err)
    } finally {
      pumping = false
      arm()
    }
  }

  /** Launched, dsh back, the computer awake: what is due is taken and run. */
  function wake(): void {
    blocked = false
    tick()
  }

  function close(): void {
    closed = true
    arm()
  }

  return { arm, wake, close }
}

export type ScheduleRuns = ReturnType<typeof createScheduleRuns>
