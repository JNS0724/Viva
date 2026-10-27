import type { DatabaseSync } from 'node:sqlite'
import { FILES_HEADER } from '../shared/attachments.ts'
import { assertId, autoTitle } from './history-schema.ts'

/**
 * 回顾 (view/review.ts): the one timeline read back by time, newest first, a page of segments at a time, each
 * with what the page shows of it; and the messages the user starred. A segment folded off another is listed
 * only when it is a background task (后台做, 放到后台); a path left behind by going back is not.
 */
const REVIEW_PAGE = 60
const MAX_REVIEW_PAGE = 200
const STARRED_LIMIT = 200
const MAX_STARS_IN = 500
/** How much of a starred message the 收藏 list shows. */
const STARRED_CHARS = 140

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS stars (
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  );
`

/** A segment as 回顾 lists it. kind: 'task' for a background task, 'talk' for the conversation itself. */
export interface ReviewSegment {
  id: string
  parentId: string | null
  createdAt: number
  title: string
  cwd: string | null
  kind: 'talk' | 'task'
  turns: number
  hasFiles: boolean
  stars: number
}

type Row = Record<string, any>

const toReviewSegment = (row: Row): ReviewSegment => ({
  id: row.id,
  parentId: row.parent_id ?? null,
  createdAt: row.created_at,
  title: row.title,
  cwd: row.cwd ?? null,
  kind: row.folded_into ? 'task' : 'talk',
  turns: row.turns,
  hasFiles: Boolean(row.files),
  stars: row.stars,
})

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > STARRED_CHARS ? `${line.slice(0, STARRED_CHARS)}…` : line
}

/**
 * Where a segment's own messages start. A turn moved to the background (fold_kind 'task', task-ipc.ts spinOff) keeps
 * the talk before it, shared with the conversation, in its first folded_at messages: the task is what comes after.
 */
const OWN_FROM = `(CASE WHEN c.fold_kind = 'task' THEN COALESCE(c.folded_at, 0) ELSE 0 END)`
/** The first question of a segment's own messages: a moved turn's name. */
const FIRST_QUESTION = `(SELECT q.text FROM messages q WHERE q.conversation_id = c.id AND q.role = 'user' AND q.seq >= ${OWN_FROM}
  ORDER BY q.seq LIMIT 1)`
/** No cursor: from the newest. */
const NEWEST = { created_at: Number.MAX_SAFE_INTEGER, rowid: Number.MAX_SAFE_INTEGER }

/** A moved turn is named by its own first question; anything else keeps its title (it may be one the user gave). */
const titleOf = (row: Row) => (row.fold_kind === 'task' ? autoTitle([{ role: 'user', text: row.first_question ?? '' }]) : row.title)

export function reviewQueries(db: DatabaseSync, now: () => number) {
  db.exec(SCHEMA)
  const sql = {
    review: db.prepare(`SELECT c.id, c.parent_id, c.created_at, c.title, c.cwd, c.folded_into, c.fold_kind, ${FIRST_QUESTION} AS first_question,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.seq >= ${OWN_FROM}) AS turns,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.seq >= ${OWN_FROM}
          AND (m.images IS NOT NULL OR instr(m.text, :header) > 0)) AS files,
        (SELECT COUNT(*) FROM stars s JOIN messages m ON m.conversation_id = s.conversation_id AND m.seq = s.seq
          WHERE s.conversation_id = c.id AND s.seq >= ${OWN_FROM}) AS stars
      FROM conversations c
      WHERE c.deleted_at IS NULL AND (c.created_at < :createdAt OR (c.created_at = :createdAt AND c.rowid < :rowid))
        AND (c.folded_into IS NULL OR c.fold_kind IN ('task', 'side'))
      ORDER BY c.created_at DESC, c.rowid DESC LIMIT :limit`),
    position: db.prepare('SELECT created_at, rowid FROM conversations WHERE id = ?'),
    own: db.prepare(`SELECT m.seq, m.role, m.text, m.receipt, m.images, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ? AND m.seq >= ${OWN_FROM} ORDER BY m.seq`),
    message: db.prepare('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.seq = ? AND c.deleted_at IS NULL'),
    star: db.prepare('INSERT OR IGNORE INTO stars (conversation_id, seq, created_at) VALUES (?, ?, ?)'),
    unstar: db.prepare('DELETE FROM stars WHERE conversation_id = ? AND seq = ?'),
    starred: db.prepare(`SELECT s.conversation_id, s.seq, m.role, m.text, m.created_at, c.title, c.fold_kind, ${FIRST_QUESTION} AS first_question FROM stars s
      JOIN messages m ON m.conversation_id = s.conversation_id AND m.seq = s.seq
      JOIN conversations c ON c.id = s.conversation_id
      WHERE c.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT ${STARRED_LIMIT}`),
  }

  /**
   * Segments before the one named `after` (by time, then by the order they were written, so a page ending among
   * segments of the same moment goes on with the rest), newest first; `hasMore` when older ones are still there.
   */
  function review({ after, limit = REVIEW_PAGE }: { after?: unknown, limit?: number } = {}) {
    const size = Math.min(Math.max(1, Math.trunc(limit) || REVIEW_PAGE), MAX_REVIEW_PAGE)
    const from = after === undefined || after === null ? NEWEST : sql.position.get(assertId(after)) ?? NEWEST
    const rows = sql.review.all({ header: FILES_HEADER, createdAt: from.created_at, rowid: from.rowid, limit: size + 1 })
    return { segments: rows.slice(0, size).map((row: Row) => toReviewSegment({ ...row, title: titleOf(row) })), hasMore: rows.length > size }
  }

  /** A segment's own messages, to read in 回顾, each with its place (seq) as kept, so a star finds it. */
  const segmentMessages = (id: unknown) => sql.own.all(assertId(id)).map((row: Row) => ({
    seq: row.seq, role: row.role, text: row.text, receipt: row.receipt ? JSON.parse(row.receipt) : null,
    ...(row.images ? { images: JSON.parse(row.images) } : {}), at: row.created_at,
  }))

  /** @returns whether it changed anything: false when the message was starred (or not) already */
  function setStar(id: unknown, seq: unknown, starred: boolean): boolean {
    const segment = assertId(id)
    const at = Number(seq)
    if (!Number.isInteger(at) || at < 0 || !sql.message.get(segment, at)) throw new Error('找不到这条消息，可能已经不在了')
    const result = starred ? sql.star.run(segment, at, now()) : sql.unstar.run(segment, at)
    return Number(result.changes) > 0
  }

  /** The starred messages among these segments, for the marks in the timeline. */
  function starsIn(ids: unknown): Array<{ segmentId: string, seq: number }> {
    const list = Array.isArray(ids) ? ids.slice(0, MAX_STARS_IN).filter((id) => typeof id === 'string') : []
    if (!list.length) return []
    const rows = db.prepare(`SELECT conversation_id, seq FROM stars WHERE conversation_id IN (${list.map(() => '?').join(', ')})
      ORDER BY conversation_id, seq`).all(...list)
    return rows.map((row: Row) => ({ segmentId: row.conversation_id, seq: row.seq }))
  }

  /** The 收藏 list: newest star first, each with the message on one line and the topic it is in. */
  const starredMessages = () => sql.starred.all().map((row: Row) => ({
    segmentId: row.conversation_id, seq: row.seq, role: row.role, text: oneLine(row.text), at: row.created_at, title: titleOf(row),
  }))

  return { review, segmentMessages, setStar, starsIn, starredMessages }
}
