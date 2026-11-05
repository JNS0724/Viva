import type { DatabaseSync } from 'node:sqlite'
import type { Apply } from './journal.ts'

/**
 * The effects queue (docs/system-design.md §12.3): what the backend still has to do outside itself, kept in the app
 * database. An effect is queued in the same transaction as the change that calls for it, and run once that commits;
 * one not done yet is still there after a restart, and run then.
 *
 * - One row per kind and key. Queued, the row takes the payload and a new `generation`: a number never given before,
 *   even to a row of the same key cancelled since (one counter for the whole queue, `effect_counter`).
 * - Each try holds the generation it was given: done, tried again later or cancelled, it acts on that generation
 *   only, so a late answer never settles a newer payload.
 * - A try says how it went: `done` (the row goes), `wait` (not now: the conversation busy, dsh restarting; no
 *   failure, run again when woken), or `retry` (it failed: run again after a growing wait).
 * - A pass the queue itself could not finish (its database refusing a write) is run again after a growing wait.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS effects (
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    payload TEXT NOT NULL,
    generation INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
  );
  CREATE TABLE IF NOT EXISTS effect_counter (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
`

/** Waits after a failed try, the last repeated. */
export const RETRY_MS: readonly number[] = Object.freeze([5_000, 30_000, 120_000, 600_000])

export type Outcome = 'done' | 'wait' | 'retry'
export interface Effect<P = unknown> { kind: string, key: string, payload: P, generation: number, attempts: number }
/** How the effects of one kind are run: those due, all at once (a kind may join them, as reports do), each its outcome. */
export type Runner = (effects: readonly Effect[]) => Promise<ReadonlyMap<string, Outcome>>

type Row = { kind: string, key: string, payload: string, generation: number, due_at: number, attempts: number }

export function createEffects({ db, apply = (_kind, _data, write) => ({ value: write() }), now = Date.now,
  later = setTimeout, cancel: cancelTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  onError = () => {} }: {
  db: DatabaseSync
  /** A change and its event (event-core.ts apply): an effect done or put off is one. */
  apply?: Apply
  now?: () => number
  later?: (run: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
  onError?: (err: unknown) => void
}) {
  db.exec(SCHEMA)
  const upsert = db.prepare(`INSERT INTO effects (kind, key, payload, generation, due_at, attempts) VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload, generation = excluded.generation, due_at = excluded.due_at, attempts = 0`)
  const newGeneration = db.prepare(`INSERT INTO effect_counter (id, last) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET last = last + 1 RETURNING last`)
  const dropOne = db.prepare('DELETE FROM effects WHERE kind = ? AND key = ?')
  const dropStarting = db.prepare('DELETE FROM effects WHERE kind = ? AND substr(key, 1, length(?)) = ?')
  const dropDone = db.prepare('DELETE FROM effects WHERE kind = ? AND key = ? AND generation = ?')
  const putOff = db.prepare('UPDATE effects SET due_at = ?, attempts = attempts + 1 WHERE kind = ? AND key = ? AND generation = ?')
  const due = db.prepare('SELECT kind, key, payload, generation, due_at, attempts FROM effects WHERE due_at <= ? ORDER BY due_at, rowid')
  const next = db.prepare('SELECT MIN(due_at) AS at FROM effects WHERE due_at > ?')
  const all = db.prepare('SELECT kind, key, payload, generation, due_at, attempts FROM effects ORDER BY rowid')
  const runners = new Map<string, Runner>()
  let timer: unknown = null
  let running = false
  let again = false
  /** Passes in a row the queue could not finish: how long until the next try. */
  let failedPasses = 0

  /** Queued, in the transaction of the change that calls for it; run once woken (`wake`) after that commits. */
  function queue(kind: string, key: string, payload: unknown, dueAt = now()) {
    const generation = Number((newGeneration.get() as { last: number }).last)
    upsert.run(kind, key, JSON.stringify(payload), generation, dueAt)
  }

  /** Not to be done any more (its reason went): the row goes, whatever generation it is at. */
  function cancel(kind: string, key: string) {
    dropOne.run(kind, key)
  }

  /**
   * Done, said from outside a try (a report confirmed read, after the try that delivered it waited): the row goes,
   * whatever generation it is at, as one change with its event.
   */
  function finish(kind: string, key: string) {
    apply('effect.done', { kind, key }, () => dropOne.run(kind, key))
  }

  /** Every effect of `kind` whose key starts so (all the reports of one task, `taskId:`): none to be done any more. */
  function cancelStarting(kind: string, prefix: string) {
    dropStarting.run(kind, prefix, prefix)
  }

  const effectOf = (row: Row): Effect => ({ kind: row.kind, key: row.key, payload: JSON.parse(row.payload), generation: Number(row.generation), attempts: Number(row.attempts) })

  /** What is queued, oldest first (for the tests and diagnostics). */
  const list = (): Effect[] => (all.all() as Row[]).map(effectOf)

  /** One pass: every effect due, kind by kind; then the next wake for the soonest one put off. */
  async function pass() {
    const rows = due.all(now()) as Row[]
    const byKind = new Map<string, Effect[]>()
    for (const row of rows) {
      try {
        byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), effectOf(row)])
      } catch (err) {
        // A row that cannot be read is no effect: it goes, said once.
        onError(err)
        dropOne.run(row.kind, row.key)
      }
    }
    for (const [kind, effects] of byKind) {
      const run = runners.get(kind)
      if (!run) continue
      let outcomes: ReadonlyMap<string, Outcome>
      try {
        outcomes = await run(effects)
      } catch (err) {
        onError(err)
        outcomes = new Map(effects.map((effect) => [effect.key, 'retry' as const]))
      }
      for (const effect of effects) settle(effect, outcomes.get(effect.key) ?? 'wait')
    }
  }

  function settle(effect: Effect, outcome: Outcome) {
    const data = { kind: effect.kind, key: effect.key, generation: effect.generation }
    if (outcome === 'done') apply('effect.done', data, () => dropDone.run(effect.kind, effect.key, effect.generation))
    if (outcome === 'retry') {
      const wait = RETRY_MS[Math.min(effect.attempts, RETRY_MS.length - 1)]
      apply('effect.retry', { ...data, waitMs: wait }, () => putOff.run(now() + wait, effect.kind, effect.key, effect.generation))
    }
    // `wait`: left as it is, due; run again when woken.
  }

  function wakeIn(ms: number) {
    if (timer !== null) cancelTimer(timer)
    timer = later(() => { timer = null; void wake() }, ms)
  }

  /** The next wake: after a pass that failed, a growing wait; else when the soonest effect put off is due. */
  function schedule() {
    if (failedPasses > 0) return wakeIn(RETRY_MS[Math.min(failedPasses - 1, RETRY_MS.length - 1)])
    let at: number | null
    try {
      at = (next.get(now()) as { at: number | null }).at
    } catch (err) {
      onError(err)
      failedPasses = 1
      return wakeIn(RETRY_MS[0])
    }
    if (timer !== null) cancelTimer(timer)
    timer = null
    if (at !== null) wakeIn(Math.max(0, Number(at) - now()))
  }

  /**
   * Runs what is due: after a change that queued an effect commits, and whenever what an effect waits on may have
   * come (the conversation free again, dsh back). One pass at a time; woken meanwhile, another follows.
   */
  async function wake(): Promise<void> {
    if (running) { again = true; return }
    running = true
    try {
      do {
        again = false
        await pass()
      } while (again)
      failedPasses = 0
    } catch (err) {
      // The queue's own database refused it (busy, full): what was due is still due, run again after a wait.
      failedPasses += 1
      onError(err)
    } finally {
      running = false
      schedule()
    }
  }

  return {
    queue,
    cancel,
    finish,
    cancelStarting,
    list,
    wake,
    /** How the effects of `kind` are done. */
    runs: (kind: string, run: Runner) => { runners.set(kind, run) },
  }
}

export type Effects = ReturnType<typeof createEffects>
