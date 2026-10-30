import { t } from '../shared/i18n/translate.ts'
import type { DatabaseSync } from 'node:sqlite'
import { FILES_HEADER } from '../shared/attachments.ts'
import { assertId, autoTitle } from './history-schema.ts'

/**
 * 回顾 (view/review.ts): the one timeline read back a topic at a time, the topic last talked in first, each with
 * what all of it holds (history-topics.ts says which segments are one topic); a topic's messages to read; and the
 * messages the user starred. A segment folded off another is part of its topic only when it is a background task
 * (后台做, 放到后台), listed under the topic on its own line; a path left behind by going back is not listed.
 */
const REVIEW_PAGE = 30
const MAX_REVIEW_PAGE = 100
const STARRED_LIMIT = 200
const MAX_STARS_IN = 500
/** How much of a starred message the 收藏 list shows. */
const STARRED_CHARS = 140
export const REVIEW_FILTERS = Object.freeze(['all', 'tasks', 'files'] as const)
export type ReviewFilter = typeof REVIEW_FILTERS[number]

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS stars (
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  );
`

/** A background task of a topic, as 回顾 lists it under the topic. */
export interface ReviewTask {
  id: string
  createdAt: number
  title: string
  turns: number
  hasFiles: boolean
  stars: number
}

/**
 * A topic as 回顾 lists it, the same however much of the history has been read: named and dated by its first
 * segment, placed by when it was last talked in; turns over the conversation itself (its tasks count their own).
 * `segments`: the conversation's segments, oldest first; `head`, the newest, what 继续这个话题 goes on from.
 */
export interface ReviewTopic {
  id: string
  title: string
  startedAt: number
  lastAt: number
  turns: number
  hasFiles: boolean
  stars: number
  cwds: string[]
  segments: string[]
  head: string | null
  tasks: ReviewTask[]
}

/** Where 回顾 reads a segment: in its topic (the conversation), or on its own (a background task, a path left behind). */
export type ReaderPlace = { key: string, topicId: string | null }

type Row = Record<string, any>
type Cursor = { lastAt: number, topicId: string }

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
/** The segments 回顾 lists: not deleted; the conversation, or a background task folded off it. */
const LISTED = `c.deleted_at IS NULL AND (c.folded_into IS NULL OR c.fold_kind IN ('task', 'side'))`
const HAS_FILES = `m.role = 'user' AND (m.images IS NOT NULL OR instr(m.text, :header) > 0)`
/** No cursor: from the topic last talked in. */
const NEWEST: Cursor = { lastAt: Number.MAX_SAFE_INTEGER, topicId: '￿' }

/** A moved turn is named by its own first question; anything else keeps its title (it may be one the user gave). */
const titleOf = (row: Row) => (row.fold_kind === 'task' ? autoTitle([{ role: 'user', text: row.first_question ?? '' }]) : row.title)

/** The directories a topic went through, in order, each once where it changed. */
const directoriesOf = (rows: readonly Row[]) => rows.reduce<string[]>((cwds, row) => (row.cwd && cwds.at(-1) !== row.cwd ? [...cwds, row.cwd] : cwds), [])

/** A topic from all its listed segments (oldest first). */
function topicOf(id: string, rows: readonly Row[]): ReviewTopic {
  const talk = rows.filter((row) => !row.folded_into)
  const tasks = rows.filter((row) => row.folded_into)
  const named = talk[0] ?? rows[0]
  return {
    id,
    title: titleOf(named),
    startedAt: Math.min(...rows.map((row) => row.created_at)),
    lastAt: Math.max(...rows.map((row) => row.updated_at)),
    turns: talk.reduce((sum, row) => sum + row.turns, 0),
    hasFiles: rows.some((row) => row.files > 0),
    stars: rows.reduce((sum, row) => sum + row.stars, 0),
    cwds: directoriesOf(talk),
    segments: talk.map((row) => row.id),
    head: talk.at(-1)?.id ?? null,
    tasks: tasks.map((row) => ({ id: row.id, createdAt: row.created_at, title: titleOf(row), turns: row.turns, hasFiles: row.files > 0, stars: row.stars })),
  }
}

export function reviewQueries(db: DatabaseSync, now: () => number) {
  db.exec(SCHEMA)
  const sql = {
    topics: db.prepare(`WITH t AS (
        SELECT c.topic_id, MAX(c.updated_at) AS last_at FROM conversations c WHERE ${LISTED} GROUP BY c.topic_id)
      SELECT t.topic_id, t.last_at FROM t
      WHERE (t.last_at < :lastAt OR (t.last_at = :lastAt AND t.topic_id < :topicId))
        AND (:filter = 'all'
          OR (:filter = 'tasks' AND EXISTS (SELECT 1 FROM conversations c WHERE c.topic_id = t.topic_id AND ${LISTED} AND c.folded_into IS NOT NULL))
          OR (:filter = 'files' AND EXISTS (SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id = c.id
            WHERE c.topic_id = t.topic_id AND ${LISTED} AND m.seq >= ${OWN_FROM} AND ${HAS_FILES})))
      ORDER BY t.last_at DESC, t.topic_id DESC LIMIT :limit`),
    place: db.prepare('SELECT topic_id, folded_into, deleted_at FROM conversations WHERE id = ?'),
    own: db.prepare(`SELECT m.id, m.seq, m.role, m.text, m.receipt, m.images, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = :id AND (:whole = 1 OR m.seq >= ${OWN_FROM}) ORDER BY m.seq`),
    message: db.prepare('SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.seq = ? AND c.deleted_at IS NULL'),
    star: db.prepare('INSERT OR IGNORE INTO stars (conversation_id, seq, created_at) VALUES (?, ?, ?)'),
    unstar: db.prepare('DELETE FROM stars WHERE conversation_id = ? AND seq = ?'),
    starred: db.prepare(`SELECT s.conversation_id, s.seq, m.id, m.role, m.text, m.created_at, c.title, c.fold_kind, c.deleted_at, ${FIRST_QUESTION} AS first_question FROM stars s
      JOIN messages m ON m.conversation_id = s.conversation_id AND m.seq = s.seq
      JOIN conversations c ON c.id = s.conversation_id
      ORDER BY s.created_at DESC LIMIT ${STARRED_LIMIT}`),
  }

  /** The listed segments of these topics, oldest first, each with its own turns, files and stars counted. */
  function segmentsOf(topicIds: readonly string[]): Row[] {
    if (!topicIds.length) return []
    const named = Object.fromEntries(topicIds.map((id, i) => [`t${i}`, id]))
    return db.prepare(`SELECT c.id, c.topic_id, c.created_at, c.updated_at, c.title, c.cwd, c.folded_into, c.fold_kind,
        ${FIRST_QUESTION} AS first_question,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' AND m.seq >= ${OWN_FROM}) AS turns,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.seq >= ${OWN_FROM} AND ${HAS_FILES}) AS files,
        (SELECT COUNT(*) FROM stars s JOIN messages m ON m.conversation_id = s.conversation_id AND m.seq = s.seq
          WHERE s.conversation_id = c.id AND s.seq >= ${OWN_FROM}) AS stars
      FROM conversations c WHERE c.topic_id IN (${Object.keys(named).map((key) => `:${key}`).join(', ')}) AND ${LISTED}
      ORDER BY c.created_at, c.rowid`).all({ header: FILES_HEADER, ...named }) as Row[]
  }

  function topicsById(topicIds: readonly string[]): ReviewTopic[] {
    const rows = segmentsOf(topicIds)
    return topicIds.flatMap((id) => {
      const own = rows.filter((row) => row.topic_id === id)
      return own.length ? [topicOf(id, own)] : []
    })
  }

  /**
   * A page of topics, the one last talked in first, after the topic named by `after` (its last time and id, so
   * topics last talked in at the same moment are not skipped); `filter` keeps topics with background tasks or with
   * files, over all of each topic. `hasMore` when there are more.
   */
  function review({ after, filter = 'all', limit = REVIEW_PAGE }: { after?: Cursor | null, filter?: string, limit?: number } = {}) {
    const size = Math.min(Math.max(1, Math.trunc(limit) || REVIEW_PAGE), MAX_REVIEW_PAGE)
    const from = after ? { lastAt: after.lastAt, topicId: assertId(after.topicId) } : NEWEST
    const kept = (REVIEW_FILTERS as readonly string[]).includes(filter) ? filter : 'all'
    const page = sql.topics.all({ lastAt: from.lastAt, topicId: from.topicId, filter: kept, limit: size + 1, header: FILES_HEADER }) as Row[]
    return { topics: topicsById(page.slice(0, size).map((row) => row.topic_id)), hasMore: page.length > size }
  }

  /** One topic as 回顾 lists it, or null when nothing of it is listed (all deleted). */
  const reviewTopic = (topicId: unknown): ReviewTopic | null => topicsById([assertId(topicId)])[0] ?? null

  const toReaderMessage = (row: Row) => ({
    id: row.id, seq: row.seq, role: row.role, text: row.text, receipt: row.receipt ? JSON.parse(row.receipt) : null,
    ...(row.images ? { images: JSON.parse(row.images) } : {}), at: row.created_at,
  })

  /**
   * A segment's own messages, to read in 回顾, each with its id and its place (seq) as kept, so a star finds it;
   * `whole`, a moved turn's with the talk before it too (a star or a link may be on that part).
   */
  const segmentMessages = (id: unknown, whole = false) => (sql.own.all({ id: assertId(id), whole: whole ? 1 : 0 }) as Row[]).map(toReaderMessage)

  /** A topic to read: as listed, and the messages of its conversation, segment after segment. Null when it is gone. */
  function topicMessages(topicId: unknown) {
    const topic = reviewTopic(topicId)
    if (!topic) return null
    const messages = topic.segments.flatMap((segmentId) => segmentMessages(segmentId).map((message) => ({ ...message, segmentId })))
    return { topic, messages }
  }

  /** Where 回顾 reads a stored segment: its topic for the conversation, else the segment alone. Null when it is gone. */
  function readerOf(segmentId: unknown): ReaderPlace | null {
    const id = assertId(segmentId)
    const row = sql.place.get(id) as Row | undefined
    if (!row || row.deleted_at) return null
    return row.folded_into ? { key: `s:${id}`, topicId: row.topic_id ?? null } : { key: `t:${row.topic_id}`, topicId: row.topic_id ?? null }
  }

  /** @returns whether it changed anything: false when the message was starred (or not) already */
  function setStar(id: unknown, seq: unknown, starred: boolean): boolean {
    const segment = assertId(id)
    const at = Number(seq)
    if (!Number.isInteger(at) || at < 0 || !sql.message.get(segment, at)) throw new Error(t("history.message.not.found"))
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

  /**
   * The 收藏 list: newest star first, each with the message on one line and the topic it is in. A star whose
   * segment was just deleted stays listed as deleted (it comes back with 撤销, and goes for good with the segment).
   */
  const starredMessages = () => (sql.starred.all() as Row[]).map((row) => ({
    segmentId: row.conversation_id, seq: row.seq, messageId: row.id, role: row.role, text: oneLine(row.text), at: row.created_at,
    title: titleOf(row), deleted: Boolean(row.deleted_at),
  }))

  return { review, reviewTopic, topicMessages, segmentMessages, readerOf, setStar, starsIn, starredMessages }
}
