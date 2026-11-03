import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The backend's one database (docs/backend-split-design.md §6.2, decided: one app database): the event table the
 * event core writes (`app_events`, event-core.ts) and the business tables that moved in with it, so a state change
 * and its event are written in one transaction. The follow-ups' tables came first (followup-store.ts, opened on this
 * database); their old file is copied in once and kept beside it as `followups.db.migrated`.
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
/** The follow-ups' tables an earlier version kept in followups.db. */
const FOLLOWUP_TABLES = Object.freeze(['followups', 'notices', 'events'])
const MIGRATED_SUFFIX = '.migrated'
const SQLITE_SIDECARS = Object.freeze(['-wal', '-shm'])

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

const columnsOf = (db: DatabaseSync, schema: string, table: string) =>
  (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Row[]).map((info) => String(info.name))

/**
 * Copies the follow-ups an earlier version kept in `legacyFile` into the app database, once: the tables must exist
 * already (openFollowupStore on the app database makes them). Columns both sides have are copied; the old file is
 * then moved aside, kept. Returns how many follow-ups came over.
 */
export function migrateFollowups(app: AppDb, legacyFile: string): number {
  if (app.meta('followups_migrated') || !fs.existsSync(legacyFile)) return 0
  const { db } = app
  db.prepare('ATTACH DATABASE ? AS legacy').run(legacyFile)
  let moved = 0
  try {
    const legacyTables = new Set((db.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all() as Row[]).map((row) => String(row.name)))
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of FOLLOWUP_TABLES.filter((name) => legacyTables.has(name))) {
        const legacyColumns = new Set(columnsOf(db, 'legacy', table))
        const columns = columnsOf(db, 'main', table).filter((column) => legacyColumns.has(column)).map((column) => `"${column}"`).join(', ')
        const result = db.prepare(`INSERT OR IGNORE INTO main.${table} (${columns}) SELECT ${columns} FROM legacy.${table}`).run()
        if (table === 'followups') moved = Number(result.changes)
      }
      app.setMeta('followups_migrated', String(Date.now()))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    db.exec('DETACH DATABASE legacy')
  }
  for (const suffix of ['', ...SQLITE_SIDECARS]) {
    const from = `${legacyFile}${suffix}`
    if (fs.existsSync(from)) fs.renameSync(from, `${legacyFile}${MIGRATED_SUFFIX}${suffix}`)
  }
  return moved
}
