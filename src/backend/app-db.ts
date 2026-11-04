import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The backend's one database (docs/backend-split-design.md §6.2, decided: one app database): the event table the
 * event core writes (`app_events`, event-core.ts) and the business tables that moved in with it, so a state change
 * and its event are written in one transaction. The follow-ups' tables came first (followup-store.ts, opened on this
 * database).
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

export function openAppDb({ file }: { file: string }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 2000;')
  db.exec(SCHEMA)
  const meta = (key: string): string | null => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined)?.value as string ?? null
  const setMeta = (key: string, value: string) => { db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value) }
  return { db, meta, setMeta, close: () => db.close() }
}

export type AppDb = ReturnType<typeof openAppDb>
