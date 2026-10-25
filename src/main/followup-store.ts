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
  /** A file whose change starts a preparation, or null. */
  watchPath: string | null
  /** When the watched file was last changed as far as Viva knows: its next change starts a preparation. */
  watchMtime: number | null
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

/** A message a source handed in that may need the user: suggested on the 后台 page, a follow-up only on 跟进. */
export type SuggestionStatus = 'open' | 'accepted' | 'declined' | 'never'
export interface Suggestion {
  id: string
  source: string
  messageId: string
  sender: string
  title: string
  ask: string
  /** Why it is suggested, in a few words (依据：有截止时间 · 你上月回过这个发件人). */
  why: string
  remindAt: number | null
  createdAt: number
  status: SuggestionStatus
  followupId: string | null
}
export type NewSuggestion = Pick<Suggestion, 'source' | 'messageId' | 'sender' | 'title' | 'ask' | 'why' | 'remindAt'>

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
  CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    message_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    title TEXT NOT NULL,
    ask TEXT NOT NULL,
    why TEXT NOT NULL,
    remind_at INTEGER,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    followup_id TEXT,
    UNIQUE (source, message_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    data TEXT
  );
`
/** Columns added since the first schema; a file from before gets them on opening. */
const ADDED_COLUMNS = Object.freeze([['followups', 'watch_mtime', 'INTEGER']])
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
    watchMtime: numberOrNull(row.watch_mtime),
    status: (FOLLOWUP_STATUSES as readonly string[]).includes(String(row.status)) ? row.status as FollowupStatus : 'scheduled',
    draft: textOrNull(row.draft),
    draftAt: numberOrNull(row.draft_at),
    readFiles: parseJson<ReadFile[]>(row.read_files, []),
    remindedAt: numberOrNull(row.reminded_at),
    lateFrom: numberOrNull(row.late_from),
    cue: textOrNull(row.cue),
  }
}

const SUGGESTION_STATUSES: readonly string[] = ['open', 'accepted', 'declined', 'never']
/** A sender the user said 不重要 to this many times is not suggested again (以后别问这类: at once). */
export const DECLINES_TO_MUTE = 2
const MAX_WHY_CHARS = 200
const RECENT_DECISIONS = 20

function suggestionOf(row: Row): Suggestion {
  return {
    id: String(row.id),
    source: String(row.source),
    messageId: String(row.message_id),
    sender: String(row.sender),
    title: String(row.title),
    ask: String(row.ask),
    why: String(row.why),
    remindAt: numberOrNull(row.remind_at),
    createdAt: Number(row.created_at),
    status: (SUGGESTION_STATUSES.includes(String(row.status)) ? row.status : 'open') as SuggestionStatus,
    followupId: textOrNull(row.followup_id),
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
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((info) => info.name === column)
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

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

  /**
   * A preparation's outcome, kept only while the follow-up is still being prepared: dismissed, done or rescheduled
   * meanwhile, what came back is let go. Returns whether it was kept.
   */
  function finishPreparing(id: string, draft: string, readFiles: readonly ReadFile[]): boolean {
    const result = db.prepare(`UPDATE followups SET draft = ?, draft_at = ?, read_files = ?, status = 'ready' WHERE id = ? AND status = 'preparing'`)
      .run(draft.slice(0, MAX_DRAFT_CHARS), now(), JSON.stringify(readFiles), id)
    return Number(result.changes) > 0
  }

  /** Moves a follow-up from `from` to `to` only if it is still at `from`. Returns whether it moved. */
  function moveStatus(id: string, from: FollowupStatus, to: FollowupStatus): boolean {
    return Number(db.prepare('UPDATE followups SET status = ? WHERE id = ? AND status = ?').run(to, id, from).changes) > 0
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

  /** What the watched file's change time is now known to be. */
  function setWatchMtime(id: string, mtimeMs: number): void {
    db.prepare('UPDATE followups SET watch_mtime = ? WHERE id = ?').run(mtimeMs, id)
  }

  /** A watched file changed: the follow-up is to be prepared again by `prepareBy`, whatever it was at. */
  function rearm(id: string, prepareBy: number, from = now()): Followup | null {
    // Counted from now (created_at is what windows are reckoned from), so a long-watched file is not prepared in a window long past.
    db.prepare(`UPDATE followups SET status = 'scheduled', prepare_by = ?, created_at = ?, reminded_at = NULL, late_from = NULL WHERE id = ?`).run(prepareBy, from, id)
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

  function getSuggestion(id: string): Suggestion | null {
    const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Row | undefined
    return row ? suggestionOf(row) : null
  }

  /** A suggestion for a message; the same message is suggested once. Returns null when it already was. */
  function addSuggestion(input: NewSuggestion): Suggestion | null {
    const id = randomUUID()
    const result = db.prepare(`INSERT OR IGNORE INTO suggestions (id, source, message_id, sender, title, ask, why, remind_at, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
      .run(id, input.source, input.messageId, input.sender, input.title.slice(0, MAX_TITLE_CHARS), input.ask.slice(0, MAX_ASK_CHARS),
        input.why.slice(0, MAX_WHY_CHARS), input.remindAt, now())
    return Number(result.changes) ? getSuggestion(id) : null
  }

  /** Open suggestions, newest first, then those of the last month; older settled ones are let go. */
  function listSuggestions(): Suggestion[] {
    db.prepare(`DELETE FROM suggestions WHERE status != 'open' AND created_at < ?`).run(now() - KEEP_ENDED_MS)
    const rows = db.prepare(`SELECT * FROM suggestions ORDER BY status = 'open' DESC, created_at DESC`).all() as Row[]
    return rows.map(suggestionOf)
  }

  function settleSuggestion(id: string, status: SuggestionStatus, followupId: string | null = null): Suggestion | null {
    db.prepare('UPDATE suggestions SET status = ?, followup_id = ? WHERE id = ?').run(status, followupId, id)
    return getSuggestion(id)
  }

  /** Senders of `source` the user does not want suggestions about: 以后别问这类 once, or 不重要 twice. */
  function mutedSenders(source: string): Set<string> {
    const rows = db.prepare(`SELECT sender, SUM(status = 'declined') AS declined, SUM(status = 'never') AS never FROM suggestions
      WHERE source = ? AND sender != '' GROUP BY sender`).all(source) as Row[]
    return new Set(rows.filter((row) => Number(row.never) > 0 || Number(row.declined) >= DECLINES_TO_MUTE).map((row) => String(row.sender)))
  }

  /** What the user decided on lately, for the judge to go by (问之前先查你以前的回答). */
  function recentDecisions(limit = RECENT_DECISIONS): Array<{ sender: string, title: string, status: SuggestionStatus }> {
    const rows = db.prepare(`SELECT sender, title, status FROM suggestions WHERE status != 'open' ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]
    return rows.map((row) => ({ sender: String(row.sender), title: String(row.title), status: String(row.status) as SuggestionStatus }))
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
  /** Every event since `since`, oldest first, for the week's figures (followup-stats.ts). */
  function eventsSince(since: number): Array<{ kind: string, at: number, data: Record<string, unknown> }> {
    const rows = db.prepare('SELECT kind, at, data FROM events WHERE at >= ? ORDER BY at, id').all(since) as Row[]
    return rows.map((row) => ({ kind: String(row.kind), at: Number(row.at), data: parseJson<Record<string, unknown>>(row.data, {}) }))
  }

  function countEvents(kind: string, since: number): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ?').get(kind, since) as Row).n)
  }

  return { add, get, list, setStatus, saveDraft, finishPreparing, moveStatus, markReminded, reschedule, setWatchMtime, rearm, remove, logNotice, interruptionsOn, noticedOn, lastToldAt, addSuggestion, getSuggestion, listSuggestions, settleSuggestion, mutedSenders, recentDecisions, logEvent, declinedSince, eventsSince, countEvents, close: () => db.close() }
}

export type FollowupStore = ReturnType<typeof openFollowupStore>
