import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The backend's one database (docs/system-design.md §5): the event table the
 * event core writes (`app_events`, event-core.ts) and the business tables that moved in with it, so a state change
 * and its event are written in one transaction: the schedules and 动态's items (schedule-store.ts, schedule-runs.ts, feed-store.ts), the history (history-db.ts,
 * history-review.ts) and the background tasks kept for the next launch (task-store.ts), each opened on this database.
 * The backend writes memory.db. The DSH trace plugin writes trace.db.
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
import { APP_DB_PRAGMAS } from '../memory/node/sqlite.ts'
export { APP_DB_PRAGMAS, transaction } from '../memory/node/sqlite.ts'

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
