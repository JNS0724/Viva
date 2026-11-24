import type { DatabaseSync } from 'node:sqlite'
import { emitDiagnostic, withDetachedOperation } from '../diagnostics/node/context.ts'
import { t } from '../shared/i18n/translate.ts'
import { transaction } from './app-db.ts'
import { RETRY_MS as HOLD_MS } from './effects.ts'
import type { Apply } from './journal.ts'
import type { FeedItem, FeedStore } from './feed-store.ts'
import type { Occurrence, ScheduleStore } from './schedule-store.ts'
import type { RunResult } from './unattended-runs.ts'

/**
 * Schedules run when due (system-design §12.2). One timer, set for the soonest thing to do; when it fires, what is
 * due is taken from the schedules and kept as runs in the same transaction, so quitting between loses nothing and a
 * run not finished is run again on the next launch. Runs go one at a time, each prompt with read-only tools in the
 * folder its schedule was made in (unattended-runs.ts); its answer becomes one item in 动态 (keyed by the occurrence,
 * so never two), its notice queued with it. A run whose schedule was paused or deleted since it was taken is let go.
 * One that keeps failing becomes an item saying so. Each step is a change with its event (event-core.ts apply):
 * `schedule.taken`, `schedule.ran`, `schedule.retry`, `schedule.dropped`.
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
    cwd TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER NOT NULL,
    schedule_revision INTEGER NOT NULL DEFAULT 0
  );
`

/** What a run came to, to be kept: an item in 动态 (its answer, or that it kept failing), or another try later. */
type Delivery = { kind: 'deliver', body: string }
type Outcome = Delivery | { kind: 'retry', attempts: number }

interface Run { key: string, scheduleId: string, at: string, title: string, prompt: string, cwd: string, attempts: number, dueAt: number, scheduleRevision: number }
type Row = Record<string, unknown>
const runOf = (row: Row): Run => ({
  key: String(row.key), scheduleId: String(row.schedule_id), at: String(row.at), title: String(row.title),
  prompt: String(row.prompt), cwd: String(row.cwd), attempts: Number(row.attempts), dueAt: Number(row.due_at),
  scheduleRevision: Number(row.schedule_revision),
})

export interface ScheduleRunsDeps {
  db: DatabaseSync
  /** The event core's apply; without it (tests), a plain transaction. */
  apply?: Apply
  store: ScheduleStore
  feed: FeedStore
  /** Runs one prompt where nobody watches, in `cwd`. */
  run: (prompt: string, cwd: string) => Promise<RunResult>
  /** A new item in 动态, inside the change that made it: its notice queued there, so it is not lost. */
  keep: (item: FeedItem) => void
  /** That change kept: the window, and the notice, may go now. */
  delivered: () => void
  /** Schedules changed by being run (one that runs once has ended). */
  changed?: () => void
  now?: () => number
  later?: (run: () => void, ms: number) => unknown
  cancel?: (timer: never) => void
  onError?: (err: unknown) => void
}

export function createScheduleRuns({ db, apply, store, feed, run, keep, delivered, changed = () => {}, now = Date.now, later = setTimeout, cancel = clearTimeout, onError = () => {} }: ScheduleRunsDeps) {
  db.exec(SCHEMA)
  const fields = db.prepare('PRAGMA table_info(schedule_runs)').all()
  if (!fields.some(row => row.name === 'schedule_revision')) db.exec('ALTER TABLE schedule_runs ADD COLUMN schedule_revision INTEGER NOT NULL DEFAULT 0')
  const change: Apply = apply ?? ((_kind, _data, write) => ({ value: transaction(db, write) }))
  let timer: unknown = null
  let pumping = false
  let again = false
  /** dsh is not there: runs wait for `wake`, not for the timer. */
  let blocked = false
  let closed = false
  /** How many times woken: a run that found no dsh while it was woken looks again. */
  let wakes = 0
  /** Changes that failed in a row, and nothing is tried before `holdUntil`: a database refusing is not hammered. */
  let failures = 0
  let holdUntil = 0
  /**
   * What a run came to and is not kept yet (the database refusing): kept on the next try, the model not asked again
   * for that try, whatever it said.
   */
  const outcomes = new Map<string, { revision: number, outcome: Outcome }>()

  const queue = (occurrence: Occurrence) => db.prepare(`INSERT INTO schedule_runs
    (key, schedule_id, at, title, prompt, cwd, attempts, due_at, schedule_revision) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(key) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,attempts=0,due_at=excluded.due_at,schedule_revision=excluded.schedule_revision
    WHERE schedule_runs.schedule_revision<>excluded.schedule_revision`).run(occurrence.key, occurrence.schedule.id, occurrence.at,
    occurrence.schedule.record.title, occurrence.schedule.record.prompt, occurrence.schedule.cwd, now(),
    occurrence.schedule.revision)
  const due = (): Run[] => (db.prepare('SELECT * FROM schedule_runs WHERE due_at <= ? ORDER BY due_at, rowid').all(now()) as Row[])
    .map(runOf)
  const nextRunAt = (): number | null => {
    const row = db.prepare('SELECT due_at FROM schedule_runs ORDER BY due_at LIMIT 1').get()
    return row ? Number(row.due_at) : null
  }
  const forget = (key: string) => { outcomes.delete(key) }
  const queued = db.prepare('SELECT schedule_revision FROM schedule_runs WHERE key=?')
  const drop = db.prepare('DELETE FROM schedule_runs WHERE key=? AND schedule_revision=?')

  /** A change failed: tried again after a growing wait. */
  function failed(err: unknown): void {
    onError(err)
    failures += 1
    holdUntil = now() + HOLD_MS[Math.min(failures, HOLD_MS.length) - 1]
  }

  /** What is due, taken and kept as runs together. */
  function take(): void {
    if ((store.nextDueAt() ?? Infinity) > now()) return
    const taken = change('schedule.taken', {}, () => store.takeDue().map(queue)).value
    emitDiagnostic({ event: 'state.changed', operation: 'schedule', stage: 'claim', metrics: { count: taken.length, mark: store.nextDueAt() ?? 0 } })
    changed()
  }

  function arm(): void {
    if (timer !== null) cancel(timer as never)
    timer = null
    if (closed) return
    const times = [store.nextDueAt(), blocked ? null : nextRunAt()].filter((at): at is number => at !== null)
    if (!times.length) return
    const at = Math.max(Math.min(...times), holdUntil)
    timer = later(tick, Math.min(Math.max(at - now(), 0), MAX_WAIT_MS))
  }

  function tick(): void {
    timer = null
    try {
      take()
    } catch (err) {
      failed(err)
      arm()
      return
    }
    void pump()
  }

  /** Done with a run: its item made (or the one made before) and its notice queued, the run gone, together. */
  function deliver(item: Run, { body }: Delivery): void {
    const made = change('schedule.ran', { key: item.key }, () => {
      const added = feed.add({ source: SCHEDULE_SOURCE, key: item.key, title: item.title, body, origin: { label: t('main.schedule-runs.origin'), ref: item.scheduleId } })
      db.prepare('DELETE FROM schedule_runs WHERE key = ?').run(item.key)
      if (added.made) keep(added.item)
      return added.made
    }).value
    emitDiagnostic({ event: 'state.changed', operation: 'schedule', stage: 'applied', reason: made ? 'normal' : 'idempotent',
      identities: { jobId: item.key, resourceId: item.scheduleId, generation: item.scheduleRevision }, metrics: { attempt: item.attempts } })
    if (made) delivered()
  }

  /** What a run came to: no dsh (nothing to keep), or what to keep: its item, or another try later. */
  function retry(item: Run, problem: string): Outcome {
    const attempts = item.attempts + 1
    return attempts < MAX_ATTEMPTS ? { kind: 'retry', attempts }
      : { kind: 'deliver', body: t('main.schedule-runs.failed', { value1: problem }) }
  }

  async function outcomeOf(item: Run): Promise<Outcome | 'unavailable' | 'superseded'> {
    if (closed || !runCurrent(item) || !scheduleCurrent(item)) return 'superseded'
    const pending = outcomes.get(item.key)
    if (pending?.revision === item.scheduleRevision) return pending.outcome
    const result = await run(item.prompt, item.cwd)
    if (closed || !runCurrent(item)) return 'superseded'
    if (!result.ok && result.unavailable) return 'unavailable'
    const outcome: Outcome = result.ok ? { kind: 'deliver', body: result.text } : retry(item, result.problem)
    outcomes.set(item.key, { revision: item.scheduleRevision, outcome })
    return outcome
  }

  /** Kept: its item made, or its next try set; then the outcome is let go. */
  function commit(item: Run, outcome: Outcome): void {
    if (closed || dropIfSuperseded(item)) return
    if (outcome.kind === 'deliver') deliver(item, outcome)
    else {
      change('schedule.retry', { key: item.key, attempts: outcome.attempts }, () => db.prepare('UPDATE schedule_runs SET attempts = ?, due_at = ? WHERE key = ?')
        .run(outcome.attempts, now() + RETRY_MS * outcome.attempts, item.key))
      emitDiagnostic({ event: 'retry.scheduled', operation: 'schedule', stage: 'queued', reason: 'retry',
        identities: { jobId: item.key, resourceId: item.scheduleId, generation: item.scheduleRevision },
        metrics: { attempt: outcome.attempts, retryDelayMs: RETRY_MS * outcome.attempts } })
    }
    forget(item.key)
  }

  function scheduleCurrent(item: Run) {
    const schedule = store.get(item.scheduleId)
    return Boolean(schedule && schedule.status !== 'paused' && schedule.revision === item.scheduleRevision)
  }

  const runCurrent = (item: Run) => queued.get(item.key)?.schedule_revision === item.scheduleRevision

  function dropIfSuperseded(item: Run) {
    if (runCurrent(item)) {
      if (scheduleCurrent(item)) return false
      change('schedule.dropped', { key: item.key }, () => drop.run(item.key, item.scheduleRevision))
      emitDiagnostic({ event: 'state.changed', operation: 'schedule', stage: 'closed', reason: 'stale',
        identities: { jobId: item.key, resourceId: item.scheduleId, generation: item.scheduleRevision } })
    }
    forget(item.key)
    return true
  }

  /** false: dsh is not there. */
  async function runOne(item: Run): Promise<boolean> {
    return withDetachedOperation('schedule', async () => {
      if (dropIfSuperseded(item)) return true
      const outcome = await outcomeOf(item)
      if (closed) return false
      if (dropIfSuperseded(item)) return true
      if (outcome === 'unavailable') {
        emitDiagnostic({ event: 'operation.progress', operation: 'schedule', stage: 'waiting', reason: 'not_ready' })
        return false
      }
      if (outcome === 'superseded') return true
      commit(item, outcome)
      return true
    }, { stage: item.attempts ? 'recovering' : 'dispatch',
      identities: { jobId: item.key, resourceId: item.scheduleId, generation: item.scheduleRevision,
        operationId: JSON.stringify([item.key, item.scheduleRevision]) }, metrics: { attempt: item.attempts } })
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
          const woken = wakes
          if (await runOne(item)) continue
          // No dsh. Woken meanwhile, it may be back: look again; else wait to be woken.
          if (wakes === woken) {
            blocked = true
            return
          }
          again = true
          break
        }
      } while (again && !closed)
      failures = 0
      holdUntil = 0
    } catch (err) {
      failed(err)
    } finally {
      pumping = false
      arm()
    }
  }

  /** Launched, dsh back, the computer awake: what is due is taken and run. */
  function wake(): void {
    if (closed) return
    if (timer !== null) cancel(timer as never)
    wakes += 1
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
