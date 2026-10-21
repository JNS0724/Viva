import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertId, autoTitle, normalizeMessages, normalizeTitle } from './history-schema.js'

const PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const SEARCH_LIMIT = 30
const SEARCH_SCAN_LIMIT = 300
const MAX_QUERY_CHARS = 100
/** The trigram index needs three characters; shorter queries fall back to LIKE. */
const TRIGRAM_MIN_CHARS = 3
const SNIPPET_BEFORE = 20
const SNIPPET_AFTER = 40
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
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS conversations_order ON conversations (deleted_at, pinned, updated_at);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    receipt TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL,
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
`

/**
 * Columns added since the first schema, each with its declaration; a file from before gets them on opening.
 * cwd: the working directory the conversation's dsh session ran in; parent_id: the conversation it went on from
 * (a fork: another directory, or back to an earlier point), so the timeline reads as one; folded_into: the
 * segment that went back to an earlier point of this one and on from there, which this one now hangs off,
 * folded, after its first folded_at messages (the ones both have).
 */
const ADDED_COLUMNS = Object.freeze([
  ['conversations', 'cwd', 'TEXT'], ['conversations', 'parent_id', 'TEXT'],
  ['conversations', 'folded_into', 'TEXT'], ['conversations', 'folded_at', 'INTEGER'],
])

function addMissingColumns(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column)
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

const toConversation = (row) => ({
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
})

const toSummary = (row) => ({
  id: row.id, title: row.title, updatedAt: row.updated_at, model: row.model, mode: row.mode, pinned: Boolean(row.pinned),
})

const toMessage = (row) => ({ role: row.role, text: row.text, receipt: row.receipt ? JSON.parse(row.receipt) : null })
/** A message of an earlier segment of the timeline: where it is, and when it was written (ms). */
const toTimelineMessage = (row) => ({ seq: row.seq, ...toMessage(row), at: row.created_at })

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`)
const ftsPhrase = (text) => `"${text.replaceAll('"', '""')}"`

/** The text around the first match, split so the view can highlight it without HTML. */
function snippetOf(text, query) {
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

/**
 * Permanent conversation history in one SQLite file (`node:sqlite`, no native module).
 * Stores what the conversation column shows, plus which dsh session each message came from,
 * so the trace can be read back from dsh's own logs later.
 * @param {{ file: string, now?: () => number, newId?: () => string }} options
 */
export function openHistoryDb({ file, now = Date.now, newId = randomUUID }) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 2000;')
  db.exec(SCHEMA)
  addMissingColumns(db)

  const sql = {
    conversation: db.prepare('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL'),
    anyConversation: db.prepare('SELECT title, title_custom FROM conversations WHERE id = ?'),
    upsert: db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at, session_id, mode, model, cwd, parent_id)
      VALUES (:id, :title, :createdAt, :updatedAt, :sessionId, :mode, :model, :cwd, :parentId)
      ON CONFLICT (id) DO UPDATE SET title = :title, updated_at = :updatedAt,
        session_id = :sessionId, mode = :mode, model = :model, cwd = :cwd`),
    position: db.prepare('SELECT created_at, rowid FROM conversations WHERE id = ?'),
    segmentsBefore: db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL AND folded_into IS NULL
      AND (created_at < :createdAt OR (created_at = :createdAt AND rowid < :rowid))
      ORDER BY created_at DESC, rowid DESC LIMIT :limit`),
    timelineMessages: db.prepare('SELECT seq, role, text, receipt, created_at FROM messages WHERE conversation_id = ? ORDER BY seq'),
    ftsMessageHits: db.prepare(`SELECT m.conversation_id AS segment_id, m.seq, m.role, m.text, m.created_at, c.cwd FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id
      WHERE messages_fts MATCH ? AND c.deleted_at IS NULL AND c.folded_into IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT ${SEARCH_LIMIT}`),
    likeMessageHits: db.prepare(`SELECT m.conversation_id AS segment_id, m.seq, m.role, m.text, m.created_at, c.cwd FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.text LIKE ? ESCAPE '\\' AND c.deleted_at IS NULL AND c.folded_into IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT ${SEARCH_LIMIT}`),
    messages: db.prepare('SELECT role, text, receipt FROM messages WHERE conversation_id = ? ORDER BY seq'),
    count: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?'),
    trim: db.prepare('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?'),
    update: db.prepare('UPDATE messages SET role = ?, text = ?, receipt = ? WHERE conversation_id = ? AND seq = ?'),
    insert: db.prepare(`INSERT INTO messages (conversation_id, seq, role, text, receipt, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    latest: db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL AND folded_into IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1'),
    fold: db.prepare('UPDATE conversations SET folded_into = ?, folded_at = ? WHERE id = ? AND deleted_at IS NULL'),
    foldsOf: db.prepare(`SELECT c.id, c.folded_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS total
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

  function transaction(work) {
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

  /** Earlier messages never change; only the last stored one (receipt, final text) and new ones are written. */
  function syncMessages(id, messages, sessionId, at) {
    const stored = sql.count.get(id).n
    const start = Math.max(0, Math.min(stored, messages.length) - 1)
    sql.trim.run(id, messages.length)
    for (let seq = start; seq < messages.length; seq += 1) {
      const { role, text, receipt } = messages[seq]
      const json = receipt ? JSON.stringify(receipt) : null
      if (seq < stored) sql.update.run(role, text, json, id, seq)
      else sql.insert.run(id, seq, role, text, json, sessionId ?? null, at)
    }
  }

  function get(id) {
    const row = sql.conversation.get(assertId(id))
    return row ? { conversation: toConversation(row), messages: sql.messages.all(id).map(toMessage) } : null
  }

  /** An unsaved conversation; it reaches the database with its first message. */
  function create({ sessionId = null, mode = null, model = null, cwd = null, parentId = null } = {}) {
    const at = now()
    return { id: newId(), title: '', titleCustom: false, createdAt: at, updatedAt: at, sessionId, mode, model, cwd, parentId }
  }

  /** @returns the conversation as stored (or as given, while it is still empty) */
  function save(conversation, input) {
    const id = assertId(conversation.id)
    const messages = normalizeMessages(input)
    if (messages.length === 0) return conversation
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
      })
      syncMessages(id, messages, conversation.sessionId, at)
      return toConversation(sql.conversation.get(id) ?? { ...existing, ...conversation })
    })
  }

  /** Brings in a conversation from the old JSON files, keeping its timestamps; skips ids already present. */
  function importConversation({ id, createdAt, updatedAt, sessionId, messages }) {
    if (sql.anyConversation.get(assertId(id))) return false
    const list = normalizeMessages(messages)
    if (list.length === 0) return false
    transaction(() => {
      sql.upsert.run({ id, title: autoTitle(list), createdAt, updatedAt, sessionId, mode: null, model: null, cwd: null, parentId: null })
      syncMessages(id, list, sessionId, updatedAt)
    })
    return true
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
  function search(input) {
    const query = typeof input === 'string' ? input.trim().slice(0, MAX_QUERY_CHARS) : ''
    if (!query) return []
    const like = `%${escapeLike(query)}%`
    const messageHits = [...query].length >= TRIGRAM_MIN_CHARS ? sql.ftsHits.all(ftsPhrase(query)) : sql.likeHits.all(like)
    const firstHit = new Map()
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
   * @param {string} id @param {{ limit?: number }} [options]
   */
  function segmentsBefore(id, { limit = SEGMENT_PAGE } = {}) {
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
    }))
    return { segments, hasMore: rows.length > size }
  }

  /** Messages of the whole timeline that contain `input`, newest first, with where each is and its directory. */
  function searchMessages(input) {
    const query = typeof input === 'string' ? input.trim().slice(0, MAX_QUERY_CHARS) : ''
    if (!query) return []
    const rows = [...query].length >= TRIGRAM_MIN_CHARS
      ? sql.ftsMessageHits.all(ftsPhrase(query))
      : sql.likeMessageHits.all(`%${escapeLike(query)}%`)
    return rows.map((row) => ({
      segmentId: row.segment_id, seq: row.seq, role: row.role, at: row.created_at, cwd: row.cwd ?? null, snippet: snippetOf(row.text, query),
    }))
  }

  function changeOne(statement, ...params) {
    if (statement.run(...params).changes === 0) throw new Error('找不到这段对话')
  }

  /**
   * The user went back to an earlier point of `id` and on from there in `into`: `id` leaves the timeline and
   * hangs, folded, off `into` after its first `at` messages (the ones both have).
   */
  const fold = (id, { into, at }) => changeOne(sql.fold, assertId(into), Math.max(0, Math.trunc(at) || 0), assertId(id))

  /** The paths folded off `id`: where each hangs (after that many of `id`'s messages) and how many it folds. */
  const foldsOf = (id) => sql.foldsOf.all(assertId(id)).map((row) => ({ id: row.id, at: row.folded_at, count: Math.max(0, row.total - row.folded_at) }))

  const rename = (id, title) => changeOne(
    db.prepare('UPDATE conversations SET title = ?, title_custom = 1 WHERE id = ? AND deleted_at IS NULL'), normalizeTitle(title), assertId(id))
  const setPinned = (id, pinned) => changeOne(
    db.prepare('UPDATE conversations SET pinned = ? WHERE id = ? AND deleted_at IS NULL'), pinned ? 1 : 0, assertId(id))
  const softDelete = (id) => changeOne(
    db.prepare('UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'), now(), assertId(id))
  const restore = (id) => changeOne(
    db.prepare('UPDATE conversations SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'), assertId(id))

  /** Removes conversations deleted at least `olderThanMs` ago, messages and index entries included. */
  function purgeDeleted({ olderThanMs }) {
    return db.prepare('DELETE FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at <= ?').run(now() - olderThanMs).changes
  }

  const sessionIds = (id) => sql.sessions.all(assertId(id)).map((row) => row.session_id)

  /** When the user asked their latest questions (ms), newest first; feeds the habit analysis. */
  const questionTimes = (limit = QUESTION_TIMES_LIMIT) => db.prepare(`SELECT m.created_at FROM messages m
    JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.deleted_at IS NULL
    ORDER BY m.id DESC LIMIT ?`).all(Math.min(Math.max(1, Math.trunc(limit) || 1), QUESTION_TIMES_LIMIT)).map((row) => row.created_at)

  return {
    create, save, get, latest, list, search, rename, setPinned, softDelete, restore, purgeDeleted, sessionIds,
    questionTimes, importConversation, segmentsBefore, searchMessages, fold, foldsOf, close: () => db.close(),
  }
}
