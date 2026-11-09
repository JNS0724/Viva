import { t } from '../shared/i18n/translate.ts'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readerQueries } from './history-reader.ts'
import { reviewQueries } from './history-review.ts'
import { APP_DB_PRAGMAS, transaction as inTransaction } from './app-db.ts'
import { assertId, autoTitle, normalizeMessages, normalizeTitle } from './history-schema.ts'
import { retainedMessagePositions, retainedMessageBoundary } from '../shared/message-order.ts'

const PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const SEARCH_LIMIT = 30
const SEARCH_SCAN_LIMIT = 300
const MAX_QUERY_CHARS = 100
/** Words apart in a search (「报销 模板」): each must be in the message; past this many the rest are left out. */
const MAX_QUERY_TERMS = 5
/** The trigram index needs three characters; shorter queries fall back to LIKE. */
const TRIGRAM_MIN_CHARS = 3
const SNIPPET_BEFORE = 20
const SNIPPET_AFTER = 40
/** How much of the message before and after a search hit is shown with it. */
const CONTEXT_CHARS = 60
/** Why a segment hangs off another instead of being in the timeline: a turn moved to the background, or a task started on its own (start_background_task); none, a path left behind by going back. */
const FOLD_KINDS = new Set(['task', 'side'])
const QUESTION_TIMES_LIMIT = 1000
/** Earlier segments of the timeline read back at a time, and the most at once. */
const SEGMENT_PAGE = 5
const MAX_SEGMENT_PAGE = 50

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    title_custom INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    session_id TEXT,
    mode TEXT,
    model TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    -- The working directory the segment's dsh session ran in.
    cwd TEXT,
    -- The segment it went on from (another directory, or back to an earlier point), so the timeline reads as one.
    parent_id TEXT,
    -- The segment that took its place, which it hangs off folded after its first folded_at messages; fold_kind
    -- 'task' for a turn moved to the background, 'side' for a task started on its own (start_background_task), null for a path
    -- left behind by going back.
    folded_into TEXT,
    folded_at INTEGER,
    fold_kind TEXT,
    -- The topic the segment is part of: its parent's, or its own id; set when it is first written, never again.
    topic_id TEXT
  );
  CREATE INDEX IF NOT EXISTS conversations_order ON conversations (deleted_at, pinned, updated_at);
  CREATE INDEX IF NOT EXISTS conversations_topic ON conversations (topic_id);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    receipt TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    -- The pictures pasted with a question, as JSON [{ id }] (shared/images.ts); the files are in the pictures folder.
    images TEXT,
    source_key TEXT,
    UNIQUE (conversation_id, seq)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
    text, content = 'messages', content_rowid = 'id', tokenize = 'trigram'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TABLE IF NOT EXISTS id_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  -- A background task's result the model read, as the record its conversation shows (system-design §11.5).
  -- Only the backend writes these, with the report done (report-records.ts); the window's saves never touch them.
  -- after_seq: how many of the conversation's messages were stored when it came, the place it is drawn at.
  CREATE TABLE IF NOT EXISTS report_records (
    report_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    after_seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS report_records_conversation ON report_records (conversation_id, after_seq);
  -- A conversation not stored yet (a blank topic) may already have a record, so no foreign key: they go with it.
  CREATE TRIGGER IF NOT EXISTS report_records_gone AFTER DELETE ON conversations BEGIN
    DELETE FROM report_records WHERE conversation_id = old.id;
  END;
`
/**
 * A message's id is what a link, a search hit or a star names it by. SQLite gives a new row the largest id plus one,
 * so after the last messages are cut off the next one would take an id a link still names; the ids are counted here
 * instead, never given twice.
 */
const COUNT_MESSAGE_IDS = "INSERT OR IGNORE INTO id_counters (name, value) VALUES ('messages', 0);"

/** A message as a link, a search hit or a star names it: its segment and place, and its id when known. */
export type MessageRef = { segmentId: string, seq: number, messageId?: number }
/** Where such a message is now (history-db.ts locate). */
export type Located =
  | { status: 'found', segmentId: string, seq: number, messageId: number }
  | { status: 'missing', segmentId: string, seq: number | null }
  | { status: 'deleted', segmentId: string }

/** A row as a query selects it: its columns by name. */
type Row = Record<string, any>
type Statement = { get: (...params: any[]) => any, all: (...params: any[]) => any[], run: (...params: any[]) => { changes: number | bigint } }


/** A segment of the one timeline, as the app holds it: saved once it has messages. */
export interface Conversation {
  id: string
  title: string
  titleCustom: boolean
  createdAt: number
  updatedAt: number
  sessionId: string | null
  mode: string | null
  model: string | null
  cwd: string | null
  parentId: string | null
  /** The topic it is part of; null until written, when it takes its parent's (or, with none, its own id). */
  topicId: string | null
}

const toConversation = (row: Row): Conversation => ({
  id: row.id,
  title: row.title,
  titleCustom: Boolean(row.title_custom),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  sessionId: row.session_id,
  mode: row.mode,
  model: row.model,
  cwd: row.cwd ?? null,
  parentId: row.parent_id ?? null,
  topicId: row.topic_id ?? null,
})

const toSummary = (row: Row) => ({
  id: row.id, title: row.title, updatedAt: row.updated_at, model: row.model, mode: row.mode, pinned: Boolean(row.pinned),
})

/**
 * A background task's result the model read, as its conversation shows it: which report, when it came (ms), the note
 * as given (no token), and how many of the conversation's messages come before it.
 */
export interface ReportRecord { reportId: string, at: number, text: string, after: number }
const toRecord = (row: Row): ReportRecord => ({ reportId: row.report_id, at: Number(row.at), text: row.text, after: Number(row.after_seq) })

const toMessage = (row: Row) => ({
  role: row.role, text: row.text, receipt: row.receipt ? JSON.parse(row.receipt) : null, ...(row.images ? { images: JSON.parse(row.images) } : {}), ...(row.source_key ? { key: row.source_key } : {}),
})
/** A message of an earlier segment of the timeline: its id, where it is, and when it was written (ms). */
const toTimelineMessage = (row: Row) => ({ id: row.id, seq: row.seq, ...toMessage(row), at: row.created_at })

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)
const ftsPhrase = (text: string) => `"${text.replaceAll('"', '""')}"`

/** The text around the first match, split so the view can highlight it without HTML. */
function snippetOf(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return { before: '', hit: '', after: text.slice(0, SNIPPET_AFTER) }
  const end = index + query.length
  const from = Math.max(0, index - SNIPPET_BEFORE)
  const to = Math.min(text.length, end + SNIPPET_AFTER)
  return {
    before: `${from > 0 ? '…' : ''}${text.slice(from, index)}`,
    hit: text.slice(index, end),
    after: `${text.slice(end, to)}${to < text.length ? '…' : ''}`,
  }
}

/** The word of a search the snippet is cut around: the first of them the text has. */
const firstTermIn = (text: string, terms: readonly string[]) => terms.find((term) => text.toLowerCase().includes(term.toLowerCase())) ?? terms[0]

/** A message next to a search hit, cut short; null when there is none. */
function contextOf(row: Row | undefined) {
  if (!row) return null
  const text = row.text.replace(/\s+/g, ' ').trim()
  return { role: row.role, text: text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS)}…` : text }
}

/**
 * Permanent conversation history, on the app database (src/backend/app-db.ts), or in a file of its own for a test.
 * Stores what the conversation column shows, plus which dsh session each message came from,
 * so the trace can be read back from dsh's own logs later.
 */
export function openHistoryDb({ file, db: given, now = Date.now, newId = randomUUID }: { file?: string, db?: DatabaseSync, now?: () => number, newId?: () => string }) {
  if (!given && !file) throw new Error('openHistoryDb needs a file or a database')
  if (!given) fs.mkdirSync(path.dirname(file!), { recursive: true })
  const db = given ?? new DatabaseSync(file!)
  if (!given) db.exec(APP_DB_PRAGMAS)
  db.exec(SCHEMA)
  inTransaction(db, () => {
    if (!db.prepare('PRAGMA table_info(messages)').all().some(row => row.name === 'source_key')) db.exec('ALTER TABLE messages ADD COLUMN source_key TEXT')
  })
  db.exec(COUNT_MESSAGE_IDS)
  const reviewing = reviewQueries(db, now)
  const reading = readerQueries(db, reviewing.reviewTopic)

  /** A row is a record of what its query selects; each function below says what it returns. */
  const sql: Record<string, Statement> = {
    conversation: db.prepare('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL'),
    anyConversation: db.prepare('SELECT title, title_custom FROM conversations WHERE id = ?'),
    upsert: db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at, session_id, mode, model, cwd, parent_id, topic_id)
      VALUES (:id, :title, :createdAt, :updatedAt, :sessionId, :mode, :model, :cwd, :parentId, :topicId)
      ON CONFLICT (id) DO UPDATE SET title = :title, updated_at = :updatedAt,
        session_id = :sessionId, mode = :mode, model = :model, cwd = :cwd`),
    topicOf: db.prepare('SELECT topic_id FROM conversations WHERE id = ?'),
    storedMessage: db.prepare('SELECT role, text, source_key FROM messages WHERE conversation_id = ? AND seq = ?'),
    dropMessage: db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq = ?'),
    dropStar: db.prepare('DELETE FROM stars WHERE conversation_id = ? AND seq = ?'),
    messageById: db.prepare(`SELECT m.id, m.conversation_id, m.seq, c.deleted_at FROM messages m
      JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`),
    messageAt: db.prepare(`SELECT m.id, m.conversation_id, m.seq, c.deleted_at FROM messages m
      JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.seq = ?`),
    nearest: db.prepare('SELECT seq FROM messages WHERE conversation_id = ? ORDER BY abs(seq - ?), seq LIMIT 1'),
    segmentRow: db.prepare('SELECT id, deleted_at FROM conversations WHERE id = ?'),
    position: db.prepare('SELECT created_at, rowid FROM conversations WHERE id = ?'),
    segmentsBefore: db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL AND folded_into IS NULL
      AND (created_at < :createdAt OR (created_at = :createdAt AND rowid < :rowid))
      ORDER BY created_at DESC, rowid DESC LIMIT :limit`),
    timelineMessages: db.prepare('SELECT id, seq, role, text, receipt, images, source_key, created_at FROM messages WHERE conversation_id = ? ORDER BY seq'),
    messages: db.prepare('SELECT role, text, receipt, images, source_key FROM messages WHERE conversation_id = ? ORDER BY seq'),
    records: db.prepare('SELECT report_id, after_seq, at, text FROM report_records WHERE conversation_id = ? ORDER BY after_seq, at, report_id'),
    addRecord: db.prepare(`INSERT OR IGNORE INTO report_records (report_id, conversation_id, after_seq, at, text)
      VALUES (?, ?, (SELECT COUNT(*) FROM messages WHERE conversation_id = ?), ?, ?)`),
    hasRecord: db.prepare('SELECT 1 AS held FROM report_records WHERE report_id = ?'),
    moveRecords: db.prepare('UPDATE report_records SET conversation_id = ? WHERE conversation_id = ? AND after_seq <= ?'),
    bySession: db.prepare('SELECT * FROM conversations WHERE session_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1'),
    neighbour: db.prepare('SELECT role, text FROM messages WHERE conversation_id = ? AND seq = ?'),
    trim: db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?'),
    // A message cut off (going back, a turn redone) takes its star along: the next one there is another message.
    trimStars: db.prepare('DELETE FROM stars WHERE conversation_id = ? AND seq >= ?'),
    stageMessagePositions: db.prepare('UPDATE messages SET seq = -seq - 1 WHERE conversation_id = ? AND seq >= ?'),
    stageStarPositions: db.prepare('UPDATE stars SET seq = -seq - 1 WHERE conversation_id = ? AND seq >= ?'),
    moveMessagePosition: db.prepare('UPDATE messages SET seq = ? WHERE conversation_id = ? AND seq = ?'),
    moveStarPosition: db.prepare('UPDATE stars SET seq = ? WHERE conversation_id = ? AND seq = ?'),
    moveRecordPosition: db.prepare('UPDATE report_records SET after_seq = ? WHERE report_id = ?'),
    sidePositions: db.prepare("SELECT id, folded_at FROM conversations WHERE folded_into = ? AND fold_kind = 'side'"),
    moveSidePosition: db.prepare('UPDATE conversations SET folded_at = ? WHERE id = ?'),
    update: db.prepare('UPDATE messages SET role = ?, text = ?, receipt = ?, images = ?, source_key = COALESCE(?, source_key) WHERE conversation_id = ? AND seq = ?'),
    nextMessageId: db.prepare(`UPDATE id_counters SET value = value + 1 WHERE name = 'messages' RETURNING value`),
    insert: db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, text, receipt, images, session_id, created_at, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    latest: db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL AND folded_into IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1'),
    fold: db.prepare('UPDATE conversations SET folded_into = ?, folded_at = ?, fold_kind = ? WHERE id = ? AND deleted_at IS NULL'),
    foldsOf: db.prepare(`SELECT c.id, c.folded_at, c.fold_kind, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS total
      FROM conversations c WHERE c.folded_into = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.rowid`),
    list: db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL
      ORDER BY pinned DESC, updated_at DESC, rowid DESC LIMIT ? OFFSET ?`),
    sessions: db.prepare(`SELECT session_id FROM messages WHERE conversation_id = ? AND session_id IS NOT NULL
      GROUP BY session_id ORDER BY MIN(seq)`),
    ftsHits: db.prepare(`SELECT m.conversation_id AS id, m.text FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ? AND c.deleted_at IS NULL ORDER BY c.updated_at DESC, m.seq LIMIT ${SEARCH_SCAN_LIMIT}`),
    likeHits: db.prepare(`SELECT m.conversation_id AS id, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.text LIKE ? ESCAPE '\\' AND c.deleted_at IS NULL ORDER BY c.updated_at DESC, m.seq LIMIT ${SEARCH_SCAN_LIMIT}`),
    titleHits: db.prepare(`SELECT id, title AS text FROM conversations
      WHERE title LIKE ? ESCAPE '\\' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${SEARCH_SCAN_LIMIT}`),
  }

  const transaction = <T>(work: () => T): T => inTransaction(db, work)

  /**
   * Skip the unchanged prefix, including when committed output repairs an earlier message. An insertion preserves
   * retained message identities, stars and report anchors. A message keeps its id while it is finishing: same speaker,
   * its text going on from what was kept. Said again differently (a turn redone), it is another message: a new id,
   * and a star on the old one goes with it.
   */
  function syncMessages(id: string, messages: ReturnType<typeof normalizeMessages>, sessionId: string | null | undefined, at: number) {
    const previous = sql.messages.all(id)
    let start = 0
    while (start < Math.min(previous.length, messages.length)) {
      const old = previous[start], next = messages[start]
      if (old.role !== next.role || old.text !== next.text || old.receipt !== (next.receipt ? JSON.stringify(next.receipt) : null)
        || old.images !== (next.images?.length ? JSON.stringify(next.images) : null) || (next.key && old.source_key !== next.key)) break
      start += 1
    }
    if (messages.length > previous.length && start < previous.length) {
      const positions = retainedMessagePositions(previous, messages, (old, next) => old.role === next.role
        && (old.source_key || next.key ? old.source_key === next.key : old.text === next.text)
        && old.images === (next.images?.length ? JSON.stringify(next.images) : null))
      if (positions) {
        sql.stageMessagePositions.run(id, start)
        sql.stageStarPositions.run(id, start)
        for (let index = start; index < positions.length; index += 1) {
          sql.moveMessagePosition.run(positions[index], id, -index - 1)
          sql.moveStarPosition.run(positions[index], id, -index - 1)
        }
        for (const record of sql.records.all(id)) sql.moveRecordPosition.run(retainedMessageBoundary(record.after_seq, positions), record.report_id)
        for (const side of sql.sidePositions.all(id)) sql.moveSidePosition.run(retainedMessageBoundary(side.folded_at, positions), side.id)
      }
    }
    sql.trim.run(id, messages.length)
    sql.trimStars.run(id, messages.length)
    for (let seq = start; seq < messages.length; seq += 1) {
      const { role, text, receipt, images, key } = messages[seq]
      const json = receipt ? JSON.stringify(receipt) : null
      const pictures = images?.length ? JSON.stringify(images) : null
      const kept = sql.storedMessage.get(id, seq)
      if (kept && kept.role === role && text.startsWith(kept.text) && (!key || !kept.source_key || kept.source_key === key)) {
        sql.update.run(role, text, json, pictures, key ?? null, id, seq)
        continue
      }
      if (kept) {
        sql.dropStar.run(id, seq)
        sql.dropMessage.run(id, seq)
      }
      sql.insert.run(sql.nextMessageId.get().value, id, seq, role, text, json, pictures, sessionId ?? null, at, key ?? null)
    }
  }

  /** A segment's topic as it is first saved: the one given, its parent's, or (with neither) its own. */
  function topicFor(id: string, conversation: Partial<Conversation>): string {
    if (conversation.topicId) return conversation.topicId
    const parent = conversation.parentId ? sql.topicOf.get(conversation.parentId) : undefined
    return parent?.topic_id ?? id
  }

  function get(id: unknown) {
    const row = sql.conversation.get(assertId(id))
    return row ? { conversation: toConversation(row), messages: sql.messages.all(id).map(toMessage), records: recordsOf(row.id) } : null
  }

  /** The task records a conversation shows, in their places (report_records). */
  const recordsOf = (id: string): ReportRecord[] => sql.records.all(id).map(toRecord)

  /**
   * A task's record, kept once (a report is recorded once, whatever conversation): after the messages stored there
   * now. False when it is kept already.
   */
  function addRecord({ conversationId, reportId, at, text }: { conversationId: string, reportId: string, at: number, text: string }): boolean {
    const id = assertId(conversationId)
    return Number(sql.addRecord.run(reportId, id, id, Math.max(0, Math.trunc(at)), text).changes) > 0
  }

  const withRecords = (id: string): { records?: ReportRecord[] } => {
    const records = recordsOf(id)
    return records.length ? { records } : {}
  }

  /**
   * The records of the part two paths share (going back, or back onto a folded path): with the path that goes on.
   * Those after it stay with the path folded.
   */
  const moveRecords = ({ from, to, upTo }: { from: string, to: string, upTo: number }): number =>
    Number(sql.moveRecords.run(assertId(to), assertId(from), Math.max(0, Math.trunc(upTo))).changes)

  /** Whether a report's record is kept. */
  const hasRecord = (reportId: string): boolean => Boolean(sql.hasRecord.get(reportId))

  /** The conversation (segment) a dsh session belongs to, the latest one; null when none is kept. */
  function bySession(sessionId: string): Conversation | null {
    const row = sql.bySession.get(sessionId)
    return row ? toConversation(row) : null
  }

  /** An unsaved conversation; it reaches the database with its first message. */
  function create({ sessionId = null, mode = null, model = null, cwd = null, parentId = null, topicId = null }: Partial<Pick<Conversation, 'sessionId' | 'mode' | 'model' | 'cwd' | 'parentId' | 'topicId'>> = {}): Conversation {
    const at = now()
    return { id: newId(), title: '', titleCustom: false, createdAt: at, updatedAt: at, sessionId, mode, model, cwd, parentId, topicId }
  }

  /** The topic a stored segment is part of, or null when there is no such segment. */
  const topicOf = (id: unknown): string | null => sql.topicOf.get(assertId(id))?.topic_id ?? null

  /** keepEmpty retains the identity of a conversation hosting standalone background tasks. */
  function save<C extends Partial<Conversation> & { id: string }>(conversation: C, input: unknown, { keepEmpty = false }: { keepEmpty?: boolean } = {}): C | Conversation {
    const id = assertId(conversation.id)
    const messages = normalizeMessages(input)
    if (messages.length === 0 && !keepEmpty) return conversation
    const at = now()
    return transaction(() => {
      const existing = sql.anyConversation.get(id)
      sql.upsert.run({
        id,
        title: existing?.title_custom ? existing.title : autoTitle(messages),
        createdAt: conversation.createdAt ?? at,
        updatedAt: at,
        sessionId: conversation.sessionId ?? null,
        mode: conversation.mode ?? null,
        model: conversation.model ?? null,
        cwd: conversation.cwd ?? null,
        parentId: conversation.parentId ?? null,
        // Only taken when the segment is first written: an update keeps the topic it has.
        topicId: existing ? null : topicFor(id, conversation),
      })
      syncMessages(id, messages, conversation.sessionId, at)
      return toConversation(sql.conversation.get(id) ?? { ...existing, ...conversation })
    })
  }

  function latest() {
    const row = sql.latest.get()
    return row ? get(row.id) : null
  }

  function list({ offset = 0, limit = PAGE_SIZE } = {}) {
    const size = Math.min(Math.max(1, Math.trunc(limit) || PAGE_SIZE), MAX_PAGE_SIZE)
    const rows = sql.list.all(size + 1, Math.max(0, Math.trunc(offset) || 0))
    return { items: rows.slice(0, size).map(toSummary), hasMore: rows.length > size }
  }

  /** One result per conversation, newest first, with a snippet around the first hit. */
  function search(input: unknown) {
    const query = typeof input === 'string' ? input.trim().slice(0, MAX_QUERY_CHARS) : ''
    if (!query) return []
    const like = `%${escapeLike(query)}%`
    const messageHits = [...query].length >= TRIGRAM_MIN_CHARS ? sql.ftsHits.all(ftsPhrase(query)) : sql.likeHits.all(like)
    const firstHit = new Map<string, string>()
    for (const hit of [...messageHits, ...sql.titleHits.all(like)]) {
      if (!firstHit.has(hit.id)) firstHit.set(hit.id, hit.text)
    }
    return [...firstHit.entries()]
      .map(([id, text]) => {
        const row = sql.conversation.get(id)
        return row && { ...toSummary(row), snippet: snippetOf(text, query) }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SEARCH_LIMIT)
  }

  /**
   * The segments of the timeline right before `id`, oldest first, each with its messages and when they were
   * written; `hasMore` when there are earlier ones still. Deleted segments are left out.
   */
  function segmentsBefore(id: unknown, { limit = SEGMENT_PAGE }: { limit?: number } = {}) {
    // A segment not yet written (it reaches the database with its first message) comes after all that are.
    const position = sql.position.get(assertId(id)) ?? { created_at: Number.MAX_SAFE_INTEGER, rowid: Number.MAX_SAFE_INTEGER }
    const size = Math.min(Math.max(1, Math.trunc(limit) || SEGMENT_PAGE), MAX_SEGMENT_PAGE)
    const rows = sql.segmentsBefore.all({ createdAt: position.created_at, rowid: position.rowid, limit: size + 1 })
    const segments = rows.slice(0, size).reverse().map((row) => ({
      id: row.id,
      cwd: row.cwd ?? null,
      parentId: row.parent_id ?? null,
      createdAt: row.created_at,
      messages: sql.timelineMessages.all(row.id).map(toTimelineMessage),
      // Its task records (report_records), when it has any.
      ...withRecords(row.id),
    }))
    return { segments, hasMore: rows.length > size }
  }

  /**
   * Messages that have every one of several words (「报销 模板」): the words of three characters or more through the
   * trigram index, the shorter ones by LIKE, in one query.
   */
  function allTermsHits(terms: readonly string[], { since, until }: { since: number, until: number }) {
    const long = terms.filter((term) => [...term].length >= TRIGRAM_MIN_CHARS)
    const short = terms.filter((term) => [...term].length < TRIGRAM_MIN_CHARS)
    const likes = short.map(() => `m.text LIKE ? ESCAPE '\\'`)
    const from = long.length
      ? `messages_fts JOIN messages m ON m.id = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id WHERE messages_fts MATCH ?`
      : `messages m JOIN conversations c ON c.id = m.conversation_id WHERE 1`
    const params = [...(long.length ? [long.map(ftsPhrase).join(' AND ')] : []), ...short.map((term) => `%${escapeLike(term)}%`), since, until]
    return db.prepare(`SELECT m.id AS message_id, m.conversation_id AS segment_id, m.seq, m.role, m.text, m.created_at, c.cwd FROM ${from}
      ${likes.map((like) => `AND ${like}`).join(' ')} AND c.deleted_at IS NULL AND c.folded_into IS NULL
      AND m.created_at >= ? AND m.created_at < ?
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${SEARCH_LIMIT}`).all(...params) as Row[]
  }

  /**
   * Messages of the whole timeline that contain `input` (or, its words apart, every one of them), newest first,
   * with where each is, its directory, and the messages right before and after it in its segment; `since` and
   * `until` (ms), only those written from the one and before the other.
   */
  function searchMessages(input: unknown, { since = 0, until = Number.MAX_SAFE_INTEGER }: { since?: number, until?: number } = {}) {
    const query = typeof input === 'string' ? input.trim().slice(0, MAX_QUERY_CHARS) : ''
    if (!query) return []
    const terms = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TERMS)
    // One word goes the same way: through the trigram index when it is long enough, else by LIKE.
    const rows = allTermsHits(terms.length === 1 ? [query] : terms, { since, until })
    return rows.map((row) => ({
      messageId: row.message_id, segmentId: row.segment_id, seq: row.seq, role: row.role, at: row.created_at, cwd: row.cwd ?? null, snippet: snippetOf(row.text, firstTermIn(row.text, terms)),
      before: contextOf(sql.neighbour.get(row.segment_id, row.seq - 1)),
      after: contextOf(sql.neighbour.get(row.segment_id, row.seq + 1)),
    }))
  }

  /**
   * Where a message named by a link, a search hit or a star is now, read straight from the history (no paging):
   * - 'found': it is there (by its id when the reference has one, else by its place);
   * - 'missing': its segment is there but it is not (cut off, or said again differently): `seq` is the nearest
   *   message left, or null when the segment has none;
   * - 'deleted': its segment was deleted.
   */
  function locate(ref: MessageRef): Located {
    const segmentId = assertId(ref.segmentId)
    const byId = ref.messageId === undefined ? undefined : sql.messageById.get(ref.messageId)
    const row = byId && byId.conversation_id === segmentId ? byId
      : ref.messageId === undefined ? sql.messageAt.get(segmentId, ref.seq) : undefined
    if (row) return row.deleted_at ? { status: 'deleted', segmentId } : { status: 'found', segmentId, seq: row.seq, messageId: row.id }
    const segment = sql.segmentRow.get(segmentId)
    if (!segment || segment.deleted_at) return { status: 'deleted', segmentId }
    return { status: 'missing', segmentId, seq: sql.nearest.get(segmentId, ref.seq)?.seq ?? null }
  }

  function changeOne(statement: Pick<Statement, 'run'>, ...params: unknown[]) {
    if (statement.run(...params).changes === 0) throw new Error(t("main.history-db.conversation.not.found"))
  }

  /**
   * The user went back to an earlier point of `id` and on from there in `into`: `id` leaves the timeline and
   * hangs, folded, off `into` after its first `at` messages (the ones both have).
   */
  const fold = (id: unknown, { into, at, kind = null as string | null }: { into: unknown, at: number, kind?: string | null }) => changeOne(sql.fold, assertId(into), Math.max(0, Math.trunc(at) || 0), kind !== null && FOLD_KINDS.has(kind) ? kind : null, assertId(id))
  /** A segment's messages with where each is and when it was written (ms). */
  const timelineOf = (id: unknown) => sql.timelineMessages.all(assertId(id)).map(toTimelineMessage)

  /** `id` is back in the timeline (the user switched back to it). */
  const unfold = (id: unknown) => changeOne(sql.fold, null, null, null, assertId(id))

  /**
   * The paths folded off `id`: where each hangs (after that many of `id`'s messages), how many it folds, and
   * whether it is a path left behind ('path') or a turn moved to the background ('task').
   */
  const foldsOf = (id: unknown) => sql.foldsOf.all(assertId(id))
    // A task started on its own (start_background_task) has its card in the conversation, not a line where it folds.
    .filter((row) => row.fold_kind !== 'side')
    .map((row) => ({ id: row.id, at: row.folded_at, count: Math.max(0, row.total - row.folded_at), kind: row.fold_kind ?? 'path' }))

  /** A retained task's (start_background_task) original card position; deleted parents/segments must not resurrect a card. */
  function sideTaskHost(id: unknown): { conversationId: string, at: number, order: number } | null {
    const row = db.prepare(`SELECT c.folded_into, c.folded_at, c.rowid AS position FROM conversations c
      JOIN conversations p ON p.id = c.folded_into WHERE c.id = ? AND c.fold_kind = 'side'
      AND c.deleted_at IS NULL AND p.deleted_at IS NULL`).get(assertId(id))
    if (!row || typeof row.folded_into !== 'string' || typeof row.folded_at !== 'number'
      || !Number.isSafeInteger(row.folded_at) || row.folded_at < 0 || typeof row.position !== 'number') return null
    return { conversationId: row.folded_into, at: row.folded_at, order: row.position }
  }

  const rename = (id: unknown, title: unknown) => changeOne(
    db.prepare('UPDATE conversations SET title = ?, title_custom = 1 WHERE id = ? AND deleted_at IS NULL'), normalizeTitle(title), assertId(id))
  const setPinned = (id: unknown, pinned: boolean) => changeOne(
    db.prepare('UPDATE conversations SET pinned = ? WHERE id = ? AND deleted_at IS NULL'), pinned ? 1 : 0, assertId(id))
  const softDelete = (id: unknown) => changeOne(
    db.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'), now(), assertId(id))
  const restore = (id: unknown) => changeOne(
    db.prepare('UPDATE conversations SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'), assertId(id))

  /** Removes conversations deleted at least `olderThanMs` ago, messages and index entries included. */
  function purgeDeleted({ olderThanMs }: { olderThanMs: number }) {
    return db.prepare('DELETE FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at <= ?').run(now() - olderThanMs).changes
  }

  const sessionIds = (id: unknown): string[] => sql.sessions.all(assertId(id)).map((row) => row.session_id)

  /** When the user asked their latest questions (ms), newest first; feeds the habit analysis. @returns {number[]} */
  const questionTimes = (limit = QUESTION_TIMES_LIMIT) => db.prepare(`SELECT m.created_at FROM messages m
    JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.deleted_at IS NULL
    ORDER BY m.id DESC LIMIT ?`).all(Math.min(Math.max(1, Math.trunc(limit) || 1), QUESTION_TIMES_LIMIT)).map((row) => Number(row.created_at))

  return {
    addRecord, hasRecord, moveRecords, recordsOf, bySession,
    create, save, get, latest, list, search, rename, setPinned, softDelete, restore, purgeDeleted, sessionIds, topicOf, locate,
    questionTimes, segmentsBefore, searchMessages, timelineOf, fold, unfold, foldsOf, sideTaskHost, ...reviewing, ...reading,
    // The app database is the backend's to close.
    close: () => { if (!given) db.close() },
  }
}
