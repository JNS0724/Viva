import type { DatabaseSync } from 'node:sqlite'

/**
 * Which topic each segment of the one timeline is part of, kept in `conversations.topic_id`.
 *
 * A segment written from now on takes it when it is first saved (history-db.ts save): its parent's, or with none
 * its own id. A file from before has none; it is filled in once, here, from how the segments go on from each other.
 * Once a segment has one it is never worked out again, so deleting a segment never moves the rest to another topic.
 */

type SegmentLink = { id: string, parent_id: string | null, topic_id: string | null, folded_into: string | null, fold_kind: string | null }

/**
 * What a segment goes on from: its parent (a change of directory, 继续这个话题, a background task started from it);
 * or, with none there, the segment it took the place of (going back to an earlier point, a turn moved to the
 * background), which hangs off it folded. Null for the first segment of a topic.
 */
function linksOf(rows: readonly SegmentLink[]): Map<string, string | null> {
  const known = new Set(rows.map((row) => row.id))
  const replaced = new Map<string, string>()
  for (const row of rows) {
    if (row.folded_into && row.fold_kind !== 'side' && !replaced.has(row.folded_into)) replaced.set(row.folded_into, row.id)
  }
  return new Map(rows.map((row) => [row.id, row.parent_id && known.has(row.parent_id) ? row.parent_id : replaced.get(row.id) ?? null]))
}

/**
 * The topic of every segment that has none yet. `rows` are oldest first. Following the links back: a segment that
 * already has a topic gives it to those after it; the first one with nothing before it starts its topic; a loop
 * (links that come back round) is started by its oldest segment.
 */
export function topicsToFill(rows: readonly SegmentLink[]): Map<string, string> {
  const link = linksOf(rows)
  const order = new Map(rows.map((row, index) => [row.id, index]))
  const topic = new Map<string, string>(rows.filter((row) => row.topic_id).map((row) => [row.id, row.topic_id as string]))
  const filled = new Map<string, string>()
  for (const row of rows) {
    if (topic.has(row.id)) continue
    const path: string[] = []
    let at: string | null = row.id
    while (at !== null && !topic.has(at) && !path.includes(at)) {
      path.push(at)
      at = link.get(at) ?? null
    }
    const looped = at !== null && path.includes(at) ? path.slice(path.indexOf(at)) : null
    const root = at !== null && topic.has(at) ? topic.get(at) as string
      : looped ? looped.reduce((oldest, id) => ((order.get(id) ?? 0) < (order.get(oldest) ?? 0) ? id : oldest))
        : path[path.length - 1]
    for (const id of path) {
      topic.set(id, root)
      filled.set(id, root)
    }
  }
  return filled
}

/** Fills in the topics a file from before lacks (see above); a file where all have one is left as it is. */
export function fillTopics(db: DatabaseSync): number {
  const missing = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE topic_id IS NULL').get() as { n: number }
  if (!missing.n) return 0
  const rows = db.prepare(`SELECT id, parent_id, topic_id, folded_into, fold_kind FROM conversations
    ORDER BY created_at, rowid`).all() as unknown as SegmentLink[]
  const filled = topicsToFill(rows)
  const update = db.prepare('UPDATE conversations SET topic_id = ? WHERE id = ? AND topic_id IS NULL')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [id, topicId] of filled) update.run(topicId, id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return filled.size
}
