import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * trace.db: the steps of every turn, written by the trace plugin inside dsh and read by the app for the
 * 过程 tab of reopened conversations. This file is the trace contract: replace the plugin with anything that
 * writes the same tables at the same CONTRACT_VERSION and the app keeps working.
 */
export const CONTRACT_VERSION = 1
/** The oldest steps go once there are more than this; the newest conversations matter most. */
const MAX_STEPS = 100_000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS steps (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    call_id TEXT,
    name TEXT,
    args TEXT,
    text TEXT,
    status TEXT,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const toStep = (row) => (row.kind === 'thought'
  ? { seq: row.seq, at: row.at, kind: 'thought', text: row.text ?? '' }
  : { seq: row.seq, at: row.at, kind: 'tool', callId: row.call_id, name: row.name, args: JSON.parse(row.args ?? '{}'), status: row.status })

/** @param {{ file: string }} options */
export function openTraceDb({ file }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
  db.exec(SCHEMA)
  const sql = {
    upsert: db.prepare(`INSERT INTO steps (session_id, seq, at, kind, call_id, name, args, text, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, seq) DO UPDATE SET status = excluded.status`),
    ofSession: db.prepare('SELECT * FROM steps WHERE session_id = ? AND at <= ? ORDER BY seq'),
    hasSession: db.prepare('SELECT 1 AS found FROM steps WHERE session_id = ? LIMIT 1'),
    newest: db.prepare('SELECT MAX(rowid) AS id FROM steps'),
    prune: db.prepare('DELETE FROM steps WHERE rowid <= ? - ?'),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  }

  const found = Number(sql.meta.get('contract_version')?.value ?? 0)
  if (found > CONTRACT_VERSION) {
    db.close()
    throw new Error(`trace.db 由更新的版本（约定 ${found}）写入，当前只支持到 ${CONTRACT_VERSION}`)
  }
  if (found < CONTRACT_VERSION) sql.setMeta.run('contract_version', String(CONTRACT_VERSION))

  /** Records a turn's steps; a step seen again (a tool that finished) only updates its status. */
  function recordSteps(sessionId, steps) {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const step of steps) {
        const tool = step.kind === 'tool'
        sql.upsert.run(String(sessionId), step.seq, step.at, step.kind, tool ? step.callId : null, tool ? step.name : null,
          tool ? JSON.stringify(step.args ?? {}) : null, tool ? null : step.text, tool ? step.status : null)
      }
      sql.prune.run(Number(sql.newest.get()?.id ?? 0), MAX_STEPS)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  return {
    recordSteps,
    /** The session's steps up to `until` (ms), in order. */
    stepsOf: (sessionId, until = Number.MAX_SAFE_INTEGER) => sql.ofSession.all(String(sessionId), until).map(toStep),
    /** Whether the plugin recorded this session; older sessions are only in dsh's own log. */
    hasSession: (sessionId) => Boolean(sql.hasSession.get(String(sessionId))),
    close: () => db.close(),
  }
}
