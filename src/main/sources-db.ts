import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SourceMessage } from './source-contract.ts'

/**
 * sources.db: the messages the sources handed in, and each source's place (its cursor) and health. A poll's
 * messages and its new cursor are written in one transaction, so a crash between the two can only mean the
 * same messages are read again, and those are kept once (by source and id). Only the latest messages of each
 * source are kept; this is an inbox for what comes next, not an archive.
 */
export const KEEP_PER_SOURCE = 500
const MAX_DROPPED_KEPT = 5
const LATEST_LIMIT = 50

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    cursor TEXT,
    last_ok_at INTEGER,
    last_received_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    dropped TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    rowid INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    sender TEXT,
    title TEXT,
    text TEXT,
    link TEXT,
    level TEXT,
    thread TEXT,
    received_at INTEGER NOT NULL,
    UNIQUE (source, id)
  );
  CREATE INDEX IF NOT EXISTS messages_latest ON messages (source, at DESC);
`

/** A message as kept, with which source it came from and when it arrived. */
export interface StoredMessage extends SourceMessage { source: string, receivedAt: number }

/** How a source has been doing, for settings and for backing off after failures. */
export interface SourceHealth {
  id: string
  cursor: string | null
  lastOkAt: number | null
  lastReceivedAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  failures: number
  /** Why the last poll's unfitting messages were dropped, a few at most. */
  dropped: string[]
  count: number
}

type Row = Record<string, unknown>
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const numberOrNull = (value: unknown): number | null => (value == null ? null : Number(value))

function messageOf(row: Row): StoredMessage {
  const optional = { from: text(row.sender), title: text(row.title), text: text(row.text), link: text(row.link), level: text(row.level), thread: text(row.thread) }
  const present = Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined))
  return { ...present, source: String(row.source), id: String(row.id), at: Number(row.at), receivedAt: Number(row.received_at) }
}

function parseDropped(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const list = JSON.parse(value)
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function openSourcesDb({ file, keep = KEEP_PER_SOURCE, now = Date.now }: { file: string, keep?: number, now?: () => number }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 2000;')
  db.exec(SCHEMA)

  const ensure = db.prepare('INSERT OR IGNORE INTO sources (id) VALUES (?)')
  const insert = db.prepare(`INSERT OR IGNORE INTO messages (source, id, at, sender, title, text, link, level, thread, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const markOk = db.prepare(`UPDATE sources SET cursor = ?, last_ok_at = ?, failures = 0, last_error = NULL, last_error_at = NULL, dropped = ?,
    last_received_at = CASE WHEN ? > 0 THEN ? ELSE last_received_at END WHERE id = ?`)
  const prune = db.prepare(`DELETE FROM messages WHERE source = ? AND rowid NOT IN
    (SELECT rowid FROM messages WHERE source = ? ORDER BY at DESC, rowid DESC LIMIT ?)`)

  function transaction<T>(work: () => T): T {
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

  /** Keeps a poll's messages and the source's new place together; returns how many were new. */
  function save(source: string, messages: readonly SourceMessage[], cursor: string | null, dropped: readonly string[] = []): number {
    return transaction(() => {
      ensure.run(source)
      const at = now()
      let added = 0
      for (const m of messages) {
        const result = insert.run(source, m.id, m.at, m.from ?? null, m.title ?? null, m.text ?? null, m.link ?? null, m.level ?? null, m.thread ?? null, at)
        added += Number(result.changes)
      }
      markOk.run(cursor, at, dropped.length ? JSON.stringify(dropped.slice(0, MAX_DROPPED_KEPT)) : null, added, at, source)
      prune.run(source, source, keep)
      return added
    })
  }

  /** Notes a failed run; returns how many have failed in a row, for backing off. */
  function fail(source: string, problem: string): number {
    return transaction(() => {
      ensure.run(source)
      db.prepare('UPDATE sources SET last_error = ?, last_error_at = ?, failures = failures + 1 WHERE id = ?').run(problem, now(), source)
      return Number((db.prepare('SELECT failures FROM sources WHERE id = ?').get(source) as Row).failures)
    })
  }

  function cursorOf(source: string): string | null {
    const row = db.prepare('SELECT cursor FROM sources WHERE id = ?').get(source) as Row | undefined
    return text(row?.cursor) ?? null
  }

  function health(source: string): SourceHealth {
    const row = (db.prepare('SELECT * FROM sources WHERE id = ?').get(source) ?? {}) as Row
    const count = Number((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE source = ?').get(source) as Row).n)
    return {
      id: source,
      cursor: text(row.cursor) ?? null,
      lastOkAt: numberOrNull(row.last_ok_at),
      lastReceivedAt: numberOrNull(row.last_received_at),
      lastError: text(row.last_error) ?? null,
      lastErrorAt: numberOrNull(row.last_error_at),
      failures: Number(row.failures ?? 0),
      dropped: parseDropped(row.dropped),
      count,
    }
  }

  /** The newest messages of `source`, newest first. */
  function latest(source: string, limit = LATEST_LIMIT): StoredMessage[] {
    const rows = db.prepare('SELECT * FROM messages WHERE source = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(source, limit) as Row[]
    return rows.map(messageOf)
  }

  /** Everything about `source`, when it is removed. */
  function forget(source: string): void {
    transaction(() => {
      db.prepare('DELETE FROM messages WHERE source = ?').run(source)
      db.prepare('DELETE FROM sources WHERE id = ?').run(source)
    })
  }

  return { save, fail, cursorOf, health, latest, forget, close: () => db.close() }
}

export type SourcesDb = ReturnType<typeof openSourcesDb>
