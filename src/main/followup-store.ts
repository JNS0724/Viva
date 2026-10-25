import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * followups.db: the things the user agreed Viva follows up on, and what Viva told them when. A follow-up is
 * made only on the user's yes (a suggestion card), never by the model alone; it has a time to remind at and/or a
 * time to be prepared by, and goes scheduled → preparing → ready → seen, or is dismissed or done. The notices
 * kept here count the day's interruptions, and the events are what the week of self-use is judged by.
 */
export const FOLLOWUP_STATUSES = Object.freeze(['scheduled', 'preparing', 'ready', 'seen', 'done', 'dismissed'] as const)
export type FollowupStatus = typeof FOLLOWUP_STATUSES[number]
/** Where a follow-up came from: a conversation, a message from a source, a file the user named, or by hand. */
export type OriginKind = 'chat' | 'message' | 'file' | 'manual'
export interface Origin { kind: OriginKind, conversationId?: string, sourceId?: string, messageId?: string, path?: string }
/** A file a draft was made from, and when it was last changed then: to say when it changed since. */
export interface ReadFile { path: string, mtimeMs: number }

export interface Followup {
  id: string
  title: string
  /** What to prepare, in the user's words ("周五下班前起草周报"). */
  ask: string
  origin: Origin
  createdAt: number
  remindAt: number | null
  prepareBy: number | null
  /** Files the user named, read when preparing (absolute paths). */
  files: string[]
  /** A file whose change starts a preparation (step 6), or null. */
  watchPath: string | null
  status: FollowupStatus
  draft: string | null
  draftAt: number | null
  readFiles: ReadFile[]
  remindedAt: number | null
  /** Set when a reminder went out late (the computer slept): the time it was due, to say 原定于…. */
  lateFrom: number | null
  /** Reserved for conditional follow-ups ("…回信了就提醒我"); unused in the first version. */
  cue: string | null
}

export type NewFollowup = Pick<Followup, 'title' | 'ask' | 'origin'> & Partial<Pick<Followup, 'remindAt' | 'prepareBy' | 'files' | 'watchPath' | 'cue'>>

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS followups (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    ask TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    remind_at INTEGER,
    prepare_by INTEGER,
    files TEXT,
    watch_path TEXT,
    status TEXT NOT NULL,
    draft TEXT,
    draft_at INTEGER,
    read_files TEXT,
    reminded_at INTEGER,
    late_from INTEGER,
    cue TEXT
  );
  CREATE INDEX IF NOT EXISTS followups_status ON followups (status);
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    interrupts INTEGER NOT NULL,
    followups TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notices_day ON notices (day);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    data TEXT
  );
`
/** Ended follow-ups are kept this long (the 后台 page's 记录), then let go. */
const KEEP_ENDED_MS = 30 * 24 * 60 * 60 * 1000
const MAX_TITLE_CHARS = 60
const MAX_ASK_CHARS = 2000
const MAX_DRAFT_CHARS = 40_000
const ENDED: ReadonlySet<FollowupStatus> = new Set(['done', 'dismissed'])

type Row = Record<string, unknown>
const numberOrNull = (value: unknown): number | null => (value == null ? null : Number(value))
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function followupOf(row: Row): Followup {
  return {
    id: String(row.id),
    title: String(row.title),
    ask: String(row.ask),
    origin: parseJson<Origin>(row.origin, { kind: 'manual' }),
    createdAt: Number(row.created_at),
    remindAt: numberOrNull(row.remind_at),
    prepareBy: numberOrNull(row.prepare_by),
    files: parseJson<string[]>(row.files, []),
    watchPath: textOrNull(row.watch_path),
    status: (FOLLOWUP_STATUSES as readonly string[]).includes(String(row.status)) ? row.status as FollowupStatus : 'scheduled',
    draft: textOrNull(row.draft),
    draftAt: numberOrNull(row.draft_at),
    readFiles: parseJson<ReadFile[]>(row.read_files, []),
    remindedAt: numberOrNull(row.reminded_at),
    lateFrom: numberOrNull(row.late_from),
    cue: textOrNull(row.cue),
  }
}

/** The local calendar day of `ts`, as the day's notices are counted. */
export function dayOf(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function checkNew(input: NewFollowup) {
  const title = input.title.trim()
  const ask = input.ask.trim()
  if (!title || title.length > MAX_TITLE_CHARS) throw new Error(`标题要在 1–${MAX_TITLE_CHARS} 个字之间`)
  if (!ask || ask.length > MAX_ASK_CHARS) throw new Error(`要做的事要在 1–${MAX_ASK_CHARS} 个字之间`)
  if (input.remindAt == null && input.prepareBy == null && !input.watchPath) throw new Error('跟进要有提醒时间、准备时间或要看的文件')
  return { title, ask }
}

export function openFollowupStore({ file, now = Date.now }: { file: string, now?: () => number }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 2000;')
  db.exec(SCHEMA)

  const get = (id: string): Followup | null => {
    const row = db.prepare('SELECT * FROM followups WHERE id = ?').get(id) as Row | undefined
    return row ? followupOf(row) : null
  }

  function add(input: NewFollowup): Followup {
    const { title, ask } = checkNew(input)
    const id = randomUUID()
    db.prepare(`INSERT INTO followups (id, title, ask, origin, created_at, remind_at, prepare_by, files, watch_path, status, cue)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`)
      .run(id, title, ask, JSON.stringify(input.origin), now(), input.remindAt ?? null, input.prepareBy ?? null,
        JSON.stringify(input.files ?? []), input.watchPath ?? null, input.cue ?? null)
    return get(id) as Followup
  }

  /** Every follow-up not ended, soonest first; ended ones of the last month after them, latest first. */
  function list(): Followup[] {
    db.prepare(`DELETE FROM followups WHERE status IN ('done', 'dismissed') AND created_at < ?`).run(now() - KEEP_ENDED_MS)
    const rows = db.prepare('SELECT * FROM followups').all() as Row[]
    const all = rows.map(followupOf)
    const when = (f: Followup) => Math.min(f.remindAt ?? Infinity, f.prepareBy ?? Infinity)
    const open = all.filter((f) => !ENDED.has(f.status)).sort((a, b) => when(a) - when(b) || a.createdAt - b.createdAt)
    const ended = all.filter((f) => ENDED.has(f.status)).sort((a, b) => b.createdAt - a.createdAt)
    return [...open, ...ended]
  }

  function setStatus(id: string, status: FollowupStatus): Followup | null {
    db.prepare('UPDATE followups SET status = ? WHERE id = ?').run(status, id)
    return get(id)
  }

  /** A preparation's outcome: the draft, when, and from which files. */
  function saveDraft(id: string, draft: string, readFiles: readonly ReadFile[]): Followup | null {
    db.prepare(`UPDATE followups SET draft = ?, draft_at = ?, read_files = ?, status = 'ready' WHERE id = ?`)
      .run(draft.slice(0, MAX_DRAFT_CHARS), now(), JSON.stringify(readFiles), id)
    return get(id)
  }

  /** Reminded: once only; `lateFrom` when it went out after its time. */
  function markReminded(id: string, lateFrom: number | null = null): void {
    db.prepare('UPDATE followups SET reminded_at = ?, late_from = ? WHERE id = ?').run(now(), lateFrom, id)
  }

  function reschedule(id: string, changes: { remindAt?: number | null, prepareBy?: number | null }): Followup | null {
    const current = get(id)
    if (!current) return null
    db.prepare('UPDATE followups SET remind_at = ?, prepare_by = ?, reminded_at = NULL, late_from = NULL WHERE id = ?')
      .run(changes.remindAt === undefined ? current.remindAt : changes.remindAt, changes.prepareBy === undefined ? current.prepareBy : changes.prepareBy, id)
    return get(id)
  }

  function remove(id: string): void {
    db.prepare('DELETE FROM followups WHERE id = ?').run(id)
  }

  /** A notice that went out: what kind, about which follow-ups, and whether it counted as an interruption. */
  function logNotice(kind: string, followupIds: readonly string[], interrupts: boolean): void {
    const at = now()
    db.prepare('INSERT INTO notices (kind, at, day, interrupts, followups) VALUES (?, ?, ?, ?, ?)')
      .run(kind, at, dayOf(at), interrupts ? 1 : 0, JSON.stringify(followupIds))
  }

  /** How many times the user was interrupted on `day` (today by default). */
  function interruptionsOn(day = dayOf(now())): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM notices WHERE day = ? AND interrupts = 1').get(day) as Row).n)
  }

  /** Whether a notice of `kind` already went out on `day`. */
  function noticedOn(kind: string, day = dayOf(now())): boolean {
    return Boolean(db.prepare('SELECT 1 FROM notices WHERE day = ? AND kind = ? LIMIT 1').get(day, kind))
  }

  /** When the user was last told of follow-up `id`, by any notice; null when never. */
  function lastToldAt(id: string): number | null {
    const row = db.prepare('SELECT MAX(at) AS at FROM notices WHERE followups LIKE ?').get(`%${JSON.stringify(id)}%`) as Row
    return numberOrNull(row.at)
  }

  /** Something worth counting in the week of self-use (a suggestion taken, a notice opened, a call made). */
  function logEvent(kind: string, data: Record<string, unknown> = {}): void {
    db.prepare('INSERT INTO events (kind, at, data) VALUES (?, ?, ?)').run(kind, now(), JSON.stringify(data))
  }

  /** The titles of suggestions the user turned down since `since` (not proposed again meanwhile). */
  function declinedSince(since: number): string[] {
    const rows = db.prepare(`SELECT data FROM events WHERE kind = 'suggest_declined' AND at >= ?`).all(since) as Row[]
    return rows.flatMap((row) => {
      const title = parseJson<{ title?: unknown }>(row.data, {}).title
      return typeof title === 'string' ? [title] : []
    })
  }

  /** How many events of `kind` since `since`. */
  function countEvents(kind: string, since: number): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ?').get(kind, since) as Row).n)
  }

  return { add, get, list, setStatus, saveDraft, markReminded, reschedule, remove, logNotice, interruptionsOn, noticedOn, lastToldAt, logEvent, declinedSince, countEvents, close: () => db.close() }
}

export type FollowupStore = ReturnType<typeof openFollowupStore>
