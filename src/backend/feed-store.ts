import type { DatabaseSync } from 'node:sqlite'

/**
 * 动态's items (system-design §12.2): what the app brings on its own, whichever source brought it, in one shape.
 * This store is their one writer. An item is named by its source and the key the source gave it, so one thing makes
 * one item at most however often it is offered (`add` says whether it made one). The source keeps how it came about;
 * the item is only what the user is shown.
 */
export interface FeedItem {
  id: string
  /** `schedule`, later `mail:<account>`, `web:<site>`. */
  source: string
  /** The source's own name for the one thing (a follow-up and its due time, a mail's Message-ID). */
  key: string
  title: string
  /** A summary or a draft, as text (Markdown). */
  body: string
  /** Where it came from, in words, and a link or reference when there is one. */
  origin: { label: string, ref?: string }
  createdAt: number
  seenAt: number | null
}

export type NewFeedItem = Omit<FeedItem, 'id' | 'createdAt' | 'seenAt'>

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feed_items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at INTEGER,
    UNIQUE (source, key)
  );
  CREATE INDEX IF NOT EXISTS feed_items_created ON feed_items (created_at DESC);
`
/** How many items are kept; older ones go as new ones come. */
export const MAX_FEED_ITEMS = 500

type Row = Record<string, unknown>
const itemOf = (row: Row): FeedItem => ({
  id: String(row.id),
  source: String(row.source),
  key: String(row.key),
  title: String(row.title),
  body: String(row.body),
  origin: JSON.parse(String(row.origin)) as FeedItem['origin'],
  createdAt: Number(row.created_at),
  seenAt: row.seen_at === null ? null : Number(row.seen_at),
})

export function openFeedStore({ db, now = Date.now, newId = () => crypto.randomUUID() }: { db: DatabaseSync, now?: () => number, newId?: () => string }) {
  db.exec(SCHEMA)

  /** The item for `source` and `key`: made now, or the one made before (`made` false). */
  function add(input: NewFeedItem): { item: FeedItem, made: boolean } {
    const found = db.prepare('SELECT * FROM feed_items WHERE source = ? AND key = ?').get(input.source, input.key) as Row | undefined
    if (found) return { item: itemOf(found), made: false }
    const id = newId()
    db.prepare('INSERT INTO feed_items (id, source, key, title, body, origin, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(id, input.source, input.key, input.title, input.body, JSON.stringify(input.origin), now())
    db.prepare(`DELETE FROM feed_items WHERE id IN (SELECT id FROM feed_items ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${MAX_FEED_ITEMS})`).run()
    return { item: itemOf(db.prepare('SELECT * FROM feed_items WHERE id = ?').get(id) as Row), made: true }
  }

  /** The latest first. */
  const list = (limit = MAX_FEED_ITEMS): FeedItem[] =>
    (db.prepare('SELECT * FROM feed_items ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(itemOf)

  /** Looked at: no longer new. False when it was not new (or is gone). */
  const markSeen = (id: string): boolean => Number(db.prepare('UPDATE feed_items SET seen_at = ? WHERE id = ? AND seen_at IS NULL').run(now(), id).changes) > 0

  const remove = (id: string): boolean => Number(db.prepare('DELETE FROM feed_items WHERE id = ?').run(id).changes) > 0

  return { add, list, markSeen, remove }
}

/** Its writes, each an event when it changed something (journal.ts). */
export const FEED_WRITES = Object.freeze(['add', 'markSeen', 'remove'] as const)

export type FeedStore = ReturnType<typeof openFeedStore>
