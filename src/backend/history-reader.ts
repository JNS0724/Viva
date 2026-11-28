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
export type ReaderRecord = { segmentId: string, reportId: string, at: number, text: string, after: number }
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
    recordsInRange: db.prepare(`SELECT report_id, after_seq, at, text FROM report_records
      WHERE conversation_id = ? AND after_seq >= ? AND after_seq <= ? ORDER BY after_seq, at, report_id`),
  }

  const placesOf = (segmentId: string, whole: boolean): Place[] =>
    (sql.places.all({ id: segmentId, whole: whole ? 1 : 0 }) as Row[]).map((row) => ({ segmentId: row.segment_id, seq: row.seq, id: row.id }))

  function recordsForSlice(
    segmentIds: readonly string[],
    allPlaces: readonly Place[],
    windowPlaces: readonly Place[],
    from: number,
  ): ReaderRecord[] {
    const allOf = (segmentId: string): ReaderRecord[] =>
      (sql.recordsInRange.all(segmentId, 0, Number.MAX_SAFE_INTEGER) as Row[]).map((row) => ({
        segmentId, reportId: String(row.report_id), at: Number(row.at), text: String(row.text), after: Number(row.after_seq),
      }))
    if (!allPlaces.length) {
      return segmentIds.flatMap(allOf)
    }
    if (!windowPlaces.length) return []
    const allBounds = new Map<string, { first: number, last: number }>()
    for (const place of allPlaces) {
      const existing = allBounds.get(place.segmentId)
      if (!existing) allBounds.set(place.segmentId, { first: place.seq, last: place.seq })
      else existing.last = place.seq
    }
    const winBounds = new Map<string, { first: number, last: number }>()
    for (const place of windowPlaces) {
      const existing = winBounds.get(place.segmentId)
      if (!existing) winBounds.set(place.segmentId, { first: place.seq, last: place.seq })
      else existing.last = place.seq
    }
    const firstWinIdx = segmentIds.indexOf(windowPlaces[0]!.segmentId)
    const lastWinIdx = segmentIds.lastIndexOf(windowPlaces.at(-1)!.segmentId)
    const atStart = from === 0
    const atEnd = from + windowPlaces.length >= allPlaces.length
    return segmentIds.flatMap((segmentId, index) => {
      const win = winBounds.get(segmentId)
      if (win) {
        const full = allBounds.get(segmentId)!
        const minAfter = win.first === full.first ? full.first : win.first + 1
        const maxAfter = win.last === full.last ? Number.MAX_SAFE_INTEGER : win.last + 1
        return (sql.recordsInRange.all(segmentId, minAfter, maxAfter) as Row[]).map((row) => ({
          segmentId, reportId: String(row.report_id), at: Number(row.at), text: String(row.text), after: Number(row.after_seq),
        }))
      }
      if (!allBounds.has(segmentId)) {
        const includeEmpty = (atStart && index < firstWinIdx)
          || (index > firstWinIdx && index < lastWinIdx)
          || (atEnd && index > lastWinIdx)
        if (includeEmpty) return allOf(segmentId)
      }
      return []
    })
  }

  function messagesByIds(places: readonly Place[]) {
    if (!places.length) return []
    const named = Object.fromEntries(places.map((place, i) => [`m${i}`, place.id]))
    const rows = db.prepare(`SELECT id, conversation_id, seq, role, text, receipt, images, source_key, source_id, session_id, created_at, foreground_only,
      (SELECT state FROM prompt_deliveries p WHERE p.source=messages.source_id) delivery FROM messages
      WHERE id IN (${Object.keys(named).map((key) => `:${key}`).join(', ')})`).all(named) as Row[]
    const byId = new Map(rows.map((row) => [row.id, row]))
    return places.flatMap((place) => {
      const row = byId.get(place.id)
      const delivery: { delivery?: 'pending' | 'not-sent' } = row?.delivery === 'pending' || row?.delivery === 'not-sent' ? { delivery: row.delivery } : {}
      return row ? [{
        id: row.id, seq: row.seq, segmentId: row.conversation_id, role: row.role, text: row.text, ...(typeof row.source_id === 'string' ? { sourceId: row.source_id } : {}),
        ...(typeof row.source_key === 'string' ? { key: row.source_key } : {}),
        ...(row.foreground_only ? { foregroundOnly: true as const } : {}),
        ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
        ...delivery,
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
    let segmentIds: readonly string[]
    if (text.startsWith('t:')) {
      topic = reviewTopic(id)
      if (!topic) return null
      segmentIds = topic.segments
      places = topic.segments.flatMap((segmentId) => placesOf(segmentId, false))
    } else if (text.startsWith('s:')) {
      if (!sql.present.get(id)) return null
      segmentIds = [id]
      places = placesOf(id, request.whole === true)
    } else {
      throw new Error('invalid reader key')
    }
    const count = clamp(Math.trunc(request.count ?? READ_COUNT) || READ_COUNT, 1, MAX_READ_COUNT)
    const wanted = request.around ? indexOf(places, request.around) - Math.floor(count / 2) : Math.trunc(request.from ?? 0)
    const from = clamp(wanted, 0, Math.max(0, places.length - count))
    const windowPlaces = places.slice(from, from + count)
    const records = recordsForSlice(segmentIds, places, windowPlaces, from)
    return {
      topic,
      total: places.length,
      from,
      messages: messagesByIds(windowPlaces),
      ...(records.length ? { records } : {}),
    }
  }

  return { read }
}
