import { createHmac } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryScope } from '../shared/memory-contract.ts'
import { transaction } from './app-db.ts'
import type { MemoryInterval } from './memory-intervals.ts'
import { memoryContextCandidate, memoryEligibleEvidence, memoryScopeKeys } from './memory-store.ts'

// Change this when lexical tokens, the indexed projection, or the table layout change.
const VERSION = '3'
const REFRESH_BATCH = 256
const MAX_TERMS = 48
const MAX_HITS = 200
const USER: MemoryScope = { kind: 'user' }
const RETAINED = "retention='retained' AND state IN ('active','superseded')"
const DIRTY_PREFIX = 'lexical-dirty:'
const DIRTY_KEYS = `key >= '${DIRTY_PREFIX}' AND key < 'lexical-dirty;'`

const DETACH_TRACKING = `
  DROP TRIGGER IF EXISTS memory_lexical_insert;
  DROP TRIGGER IF EXISTS memory_lexical_update;
  DROP TRIGGER IF EXISTS memory_lexical_delete;
`

const TRACKING = `
  CREATE TRIGGER IF NOT EXISTS memory_lexical_insert AFTER INSERT ON memories BEGIN
    INSERT OR IGNORE INTO memory_meta (key,value) VALUES ('${DIRTY_PREFIX}' || new.id,new.id);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_lexical_update AFTER UPDATE OF text,keywords,scope,revision,retention,state ON memories
  WHEN NEW.text IS NOT OLD.text OR NEW.keywords IS NOT OLD.keywords OR NEW.scope IS NOT OLD.scope
    OR NEW.revision IS NOT OLD.revision OR NEW.retention IS NOT OLD.retention OR NEW.state IS NOT OLD.state
  BEGIN
    INSERT OR IGNORE INTO memory_meta (key,value) VALUES ('${DIRTY_PREFIX}' || new.id,new.id);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_lexical_delete AFTER DELETE ON memories BEGIN
    INSERT OR IGNORE INTO memory_meta (key,value) VALUES ('${DIRTY_PREFIX}' || old.id,old.id);
  END;
`

// Includes the legacy dirty table, which is discarded when upgrading this rebuildable index.
const tableNames = ['memory_lexical_dirty', 'memory_lexical_meta', 'memory_lexical_rows', 'memory_lexical_fts'] as const
const triggerNames = ['memory_lexical_insert', 'memory_lexical_update', 'memory_lexical_delete'] as const

// FTS stores searchable HMAC tokens only. Revisions live in its derived receipt table.
const INDEX = `
  CREATE TABLE memory_lexical_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE VIRTUAL TABLE memory_lexical_fts USING fts5(
    terms, scope, content='', contentless_delete=1
  );
  INSERT INTO memory_lexical_fts(memory_lexical_fts,rank) VALUES ('secure-delete',1);
  CREATE TABLE memory_lexical_rows (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
`

const han = /^\p{Script=Han}+$/u
// Break at Han/Latin boundaries, including when a project code is adjacent to Han text.
const words = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+(?:[-_./@](?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+)*/gu

function lexicalTerms(text: string, indexing: boolean) {
  const result = new Set<string>()
  for (const part of text.normalize('NFKC').toLowerCase().match(words) ?? []) {
    if (han.test(part)) {
      const chars = [...part]
      if (indexing || chars.length === 1) for (const char of chars) result.add(char)
      for (let index = 1; index < chars.length; index++) result.add(chars[index - 1] + chars[index])
    } else {
      result.add(part)
      if (indexing) for (const component of part.split(/[-_./@]/u)) result.add(component)
    }
  }
  return result
}

/** Verify an index hit against language visible in the canonical projection. */
export function memoryIndexMatches(text: string, query: string, keywords: readonly string[] = []) {
  const indexed = lexicalTerms([text, ...keywords].join(' '), true)
  const terms = lexicalTerms(query, false)
  return terms.size > 0 && [...terms].every(term => indexed.has(term))
}

// Explicit identifiers retain their exact token even when the rest of a query is semantic.
export function memoryIdentifierTokens(text: string) {
  return (text.normalize('NFKC').toLowerCase().match(words) ?? [])
    .filter(part => /^\p{L}[\p{L}\p{M}\p{N}]*([-_./][\p{L}\p{M}\p{N}]+)+$/u.test(part) && /\p{N}/u.test(part))
}

export type MemoryIndexHit = { id: number, revision: number }
export type MemoryIndexResult = { hits: MemoryIndexHit[], truncated: boolean }

export function openMemoryIndex(db: DatabaseSync) {
  let secret: string | undefined
  const token = (domain: string, value: string) => 'v' + createHmac('sha256', secret!).update(domain).update('\0').update(value).digest('hex')
  const scopeToken = (scope: MemoryScope) => token('scope', JSON.stringify(scope.kind === 'user' ? ['user'] : [scope.kind, scope.id]))
  let usable = false

  function schemaMatches() {
    const columns = (name: typeof tableNames[number]) => (db.prepare(`PRAGMA table_info(${name})`).all()).map(row => row.name).join(',')
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='memories' AND name=?")
    const fts = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_lexical_fts'").get()?.sql
    return columns('memory_lexical_meta') === 'key,value' && columns('memory_lexical_rows') === 'id,revision'
      && typeof fts === 'string' && fts.includes('USING fts5(') && fts.includes("content='', contentless_delete=1")
      && db.prepare("SELECT v FROM memory_lexical_fts_config WHERE k='secure-delete'").get()?.v === 1
      && triggerNames.every(name => {
        const sql = trigger.get(name)?.sql
        return typeof sql === 'string' && sql.includes(`INTO memory_meta (key,value) VALUES ('${DIRTY_PREFIX}'`)
      })
      && db.prepare("SELECT value FROM memory_lexical_meta WHERE key='version'").get()?.value === VERSION
  }

  function detachTracking() {
    try { db.exec(DETACH_TRACKING) } catch { /* A non-writable database is reported by its canonical writes. */ }
  }

  function initialize(reset = false) {
    try {
      const key = db.prepare("SELECT value FROM memory_meta WHERE key='secret'").get()?.value
      if (typeof key !== 'string' || !key) { detachTracking(); return false }
      if (!reset && schemaMatches()) { secret = key; return true }
      transaction(db, () => {
        db.exec(DETACH_TRACKING)
        const kind = db.prepare("SELECT type FROM sqlite_master WHERE type IN ('table','view','trigger','index') AND name=?")
        for (const name of tableNames) {
          const type = kind.get(name)?.type
          if (type) db.exec(`DROP ${type} ${name}`)
        }
        db.exec(TRACKING)
        db.exec(INDEX)
        db.exec(`DELETE FROM memory_meta WHERE ${DIRTY_KEYS};
          INSERT INTO memory_meta (key,value) SELECT '${DIRTY_PREFIX}' || id,id FROM memories WHERE ${RETAINED};`)
        db.prepare("INSERT INTO memory_lexical_meta VALUES ('version',?)").run(VERSION)
      })
      secret = key
      return true
    } catch { detachTracking(); return false }
  }

  usable = initialize()

  // Pending keys live with canonical metadata so loss of an auxiliary table cannot block saving or forgetting a fact.
  function pending() {
    try { return usable && Boolean(db.prepare(`SELECT 1 FROM memory_meta WHERE ${DIRTY_KEYS} LIMIT 1`).get()) }
    catch { return false }
  }

  function rewriteRows(dirty: readonly { key: string, id: number }[]) {
    const read = db.prepare(`SELECT text,keywords,scope,revision FROM memories WHERE id=? AND ${RETAINED}`)
    const removeTerms = db.prepare('DELETE FROM memory_lexical_fts WHERE rowid=?')
    const removeReceipt = db.prepare('DELETE FROM memory_lexical_rows WHERE id=?')
    const writeTerms = db.prepare('INSERT INTO memory_lexical_fts(rowid,terms,scope) VALUES (?,?,?)')
    const writeReceipt = db.prepare('INSERT INTO memory_lexical_rows VALUES (?,?)')
    const clean = db.prepare('DELETE FROM memory_meta WHERE key=?')
    for (const { id, key } of dirty) {
      removeTerms.run(id)
      removeReceipt.run(id)
      const row = read.get(id) as { text: string, keywords: string, scope: string, revision: number } | undefined
      if (row) {
        const terms = [...lexicalTerms([row.text, ...JSON.parse(row.keywords) as string[]].join(' '), true)]
        if (terms.length) {
          writeTerms.run(id, terms.map(term => token('term', term)).join(' '), scopeToken(JSON.parse(row.scope) as MemoryScope))
          writeReceipt.run(id, row.revision)
        }
      }
      clean.run(key)
    }
  }

  function refreshBatch() {
    if (!usable) return false
    try {
      if (!pending()) return true
      transaction(db, () => {
        const dirty = db.prepare(`SELECT key, CAST(value AS INTEGER) AS id FROM memory_meta WHERE ${DIRTY_KEYS} ORDER BY key LIMIT ?`)
          .all(REFRESH_BATCH) as { key: string, id: number }[]
        rewriteRows(dirty)
      })
      return true
    } catch { return false }
  }

  const refresh = () => refreshBatch() && !pending()

  function purge(ids: readonly number[], revision: number) {
    try {
      // A damaged rebuildable index may still hold a copy. Replace its storage before recording completion.
      if (!usable || !schemaMatches()) usable = initialize(true)
      if (!usable) return !db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE name='memory_lexical_rows'
        OR name GLOB 'memory_lexical_fts*' LIMIT 1`).get()
      const keys = JSON.stringify(ids)
      const outdated = db.prepare(`SELECT 1 FROM memories WHERE id IN (SELECT value FROM json_each(?))
        AND revision<? AND ${RETAINED} LIMIT 1`)
      if (outdated.get(keys, revision)) return false
      transaction(db, () => rewriteRows(ids.map(id => ({ id, key: DIRTY_PREFIX + id }))))
      const residue = db.prepare(`WITH affected AS (SELECT value AS id FROM json_each(:keys))
        SELECT 1 FROM affected a JOIN memory_lexical_fts f ON f.rowid=a.id
          LEFT JOIN memory_lexical_rows r ON r.id=a.id WHERE r.id IS NULL
        UNION ALL
        SELECT 1 FROM affected a JOIN memory_lexical_rows r ON r.id=a.id
          LEFT JOIN memory_lexical_fts f ON f.rowid=a.id
          LEFT JOIN memories m ON m.id=r.id AND m.revision=r.revision AND m.retention='retained' AND m.state IN ('active','superseded')
          WHERE f.rowid IS NULL OR m.id IS NULL OR r.revision<:revision
        LIMIT 1`).get({ keys, revision })
      if (!residue) return true
    } catch { /* Attempt to replace derived storage if the scoped purge could not verify it. */ }
    usable = initialize(true)
    return usable
  }

  function search(query: string, scope: MemoryScope | undefined, limit: number, interval?: MemoryInterval,
    reader?: 'recall' | 'context'): MemoryIndexResult | null {
    const terms = [...lexicalTerms(query, false)]
    if (!terms.length || !Number.isSafeInteger(limit) || limit < 1) return { hits: [], truncated: false }
    if (!refresh()) return null
    try {
      const scopes = [scopeToken(USER), ...(scope && scope.kind !== 'user' ? [scopeToken(scope)] : [])]
      const [userScope, localScope, alternateScope] = memoryScopeKeys(scope)
      const encoded = terms.slice(0, MAX_TERMS).map(term => token('term', term))
      const take = Math.min(limit, MAX_HITS)
      const candidates = db.prepare(`SELECT r.id,r.revision FROM memory_lexical_fts JOIN memory_lexical_rows r ON r.id=memory_lexical_fts.rowid
        JOIN memories m ON m.id=r.id AND m.revision=r.revision
        WHERE memory_lexical_fts MATCH :match AND ${RETAINED} AND m.scope IN (:userScope,:localScope,:alternateScope)
        ${reader ? `AND ${memoryEligibleEvidence}` : ''}
        ${reader === 'context' ? `AND ${memoryContextCandidate}` : ''}
        ${interval ? `AND EXISTS (SELECT 1 FROM json_each(m.windows) w
          WHERE (:start IS NULL OR json_extract(w.value,'$.to') IS NULL OR json_extract(w.value,'$.to')>:start)
            AND (:end IS NULL OR json_extract(w.value,'$.from') IS NULL OR json_extract(w.value,'$.from')<:end))` : ''}
        ORDER BY bm25(memory_lexical_fts,1,0),r.id DESC LIMIT :take`)
      const find = (operator: ' AND ' | ' OR ') => candidates.all({
        match: `terms: (${encoded.join(operator)}) AND scope: (${scopes.join(' OR ')})`, take: take + 1,
        userScope, localScope, alternateScope,
        ...interval && { start: interval.from, end: interval.to },
      }) as MemoryIndexHit[]
      const exact = find(' AND ')
      // Retain exact matches before filling the candidate budget with individual query terms.
      const broad = encoded.length > 1 && exact.length < take + 1 ? find(' OR ') : []
      const hits = [...new Map([...exact, ...broad].map(hit => [hit.id, hit])).values()]
      if (pending()) return null
      return { hits: hits.slice(0, take).map(({ id, revision }) => ({ id, revision })), truncated: hits.length > take || terms.length > MAX_TERMS }
    } catch { return null }
  }

  return { search, refresh, refreshBatch, pending, purge, rebuild() { usable = initialize(true); return usable } }
}
