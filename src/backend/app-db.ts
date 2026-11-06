import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The backend's one database (docs/system-design.md §5): the event table the
 * event core writes (`app_events`, event-core.ts) and the business tables that moved in with it, so a state change
 * and its event are written in one transaction: the schedules and 动态's items (schedule-store.ts, schedule-runs.ts, feed-store.ts), the history (history-db.ts,
 * history-review.ts) and the background tasks kept for the next launch (task-store.ts), each opened on this database.
 * Memory and the trace stay in their plugins' own files: dsh's process writes them (app-plugins.ts).
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

type Row = Record<string, unknown>

/** The connection settings every store on the app database relies on (history's cascades need foreign keys). */
export const APP_DB_PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 2000;'

export function openAppDb({ file }: { file: string }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(APP_DB_PRAGMAS)
  db.exec(SCHEMA)
  const meta = (key: string): string | null => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined)?.value as string ?? null
  const setMeta = (key: string, value: string) => { db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value) }
  return { db, meta, setMeta, close: () => db.close() }
}

export type AppDb = ReturnType<typeof openAppDb>

let savepoints = 0

/**
 * `work` in one transaction. Inside another (a store's write inside the event core's apply), it is a savepoint of
 * that one: a write that throws is undone on its own, and the outer one commits or rolls back the whole.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (!db.isTransaction) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  savepoints += 1
  const name = `nested_${savepoints}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = work()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw err
  }
}
