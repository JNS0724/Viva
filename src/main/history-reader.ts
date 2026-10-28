import type { DatabaseSync } from 'node:sqlite'
import { assertId } from './history-schema.ts'
import type { ReviewTopic } from './history-review.ts'

/**
 * 回顾 reads a topic or a segment a part at a time, however long it is: what it holds is listed by place only
 * (segment, seq, id: small), and the messages themselves are read for the part asked for. The window keeps at most
 * a couple of hundred messages; it reads on before or after what it has as the user scrolls.
 */
export const READ_COUNT = 100
const MAX_READ_COUNT = 200

type Row = Record<string, any>
/** Where a message is in what is read: its segment and place, its id. */
type Place = { segmentId: string, seq: number, id: number }
/** What to read: from a place in the order (`from`), or around a message (`around`), `count` of them. */
export type ReadRequest = { from?: number, around?: { segmentId: string, seq: number }, count?: number, whole?: boolean }

/**
 * Where a segment's own messages start (history-review.ts OWN_FROM): a moved turn's after the talk it shares,
 * unless it is read `whole`.
 */
const OWN = `(:whole = 1 OR m.seq >= (CASE WHEN c.fold_kind = 'task' THEN COALESCE(c.folded_at, 0) ELSE 0 END))`

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

export function readerQueries(db: DatabaseSync, reviewTopic: (topicId: unknown) => ReviewTopic | null) {
  const sql = {
    places: db.prepare(`SELECT m.conversation_id AS segment_id, m.seq, m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = :id AND ${OWN} ORDER BY m.seq`),
    present: db.prepare('SELECT 1 FROM conversations WHERE id = ? AND deleted_at IS NULL'),
  }

  const placesOf = (segmentId: string, whole: boolean): Place[] =>
    (sql.places.all({ id: segmentId, whole: whole ? 1 : 0 }) as Row[]).map((row) => ({ segmentId: row.segment_id, seq: row.seq, id: row.id }))

  function messagesByIds(places: readonly Place[]) {
    if (!places.length) return []
    const named = Object.fromEntries(places.map((place, i) => [`m${i}`, place.id]))
    const rows = db.prepare(`SELECT id, conversation_id, seq, role, text, receipt, images, created_at FROM messages
      WHERE id IN (${Object.keys(named).map((key) => `:${key}`).join(', ')})`).all(named) as Row[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    return places.flatMap((place) => {
      const row = byId.get(place.id)
      return row ? [{
        id: row.id, seq: row.seq, segmentId: row.conversation_id, role: row.role, text: row.text,
        receipt: row.receipt ? JSON.parse(row.receipt) : null, ...(row.images ? { images: JSON.parse(row.images) } : {}), at: row.created_at,
      }] : []
    })
  }

  /** Where `around` is in the order: that message, else the nearest in its segment, else the start. */
  function indexOf(places: readonly Place[], around: { segmentId: string, seq: number }) {
    const exact = places.findIndex((place) => place.segmentId === around.segmentId && place.seq === around.seq)
    if (exact >= 0) return exact
    const inSegment = places.map((place, i) => ({ place, i })).filter(({ place }) => place.segmentId === around.segmentId)
    if (!inSegment.length) return 0
    return inSegment.reduce((best, next) => (Math.abs(next.place.seq - around.seq) < Math.abs(best.place.seq - around.seq) ? next : best)).i
  }

  /**
   * A part of what `key` holds (a topic's conversation, `t:<topic id>`; or a segment, `s:<segment id>`), in order:
   * `count` messages from `from`, or with `around` in the middle. `total`: how many it holds in all. Null when it is
   * gone (deleted).
   */
  function read(key: unknown, request: ReadRequest = {}) {
    const text = typeof key === 'string' ? key : ''
    const id = assertId(text.slice(2))
    let topic: ReviewTopic | null = null
    let places: Place[]
    if (text.startsWith('t:')) {
      topic = reviewTopic(id)
      if (!topic) return null
      places = topic.segments.flatMap((segmentId) => placesOf(segmentId, false))
    } else if (text.startsWith('s:')) {
      if (!sql.present.get(id)) return null
      places = placesOf(id, request.whole === true)
    } else {
      throw new Error('invalid reader key')
    }
    const count = clamp(Math.trunc(request.count ?? READ_COUNT) || READ_COUNT, 1, MAX_READ_COUNT)
    const wanted = request.around ? indexOf(places, request.around) - Math.floor(count / 2) : Math.trunc(request.from ?? 0)
    const from = clamp(wanted, 0, Math.max(0, places.length - count))
    return { topic, total: places.length, from, messages: messagesByIds(places.slice(from, from + count)) }
  }

  return { read }
}
