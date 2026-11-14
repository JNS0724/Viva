import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'
import type { MemoryScope } from '../shared/memory-contract.ts'
import { transaction } from './app-db.ts'
import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_DIMENSIONS } from './memory-embedder.ts'
import type { MemoryInterval } from './memory-intervals.ts'
import { memoryScopeKeys, memoryWindowParameters, memoryWindowsOverlap } from './memory-store.ts'

const CODEC_VERSION = 2
const VECTOR_BYTES = MEMORY_EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT
const MAX_RESULTS = 50
const MIN_SIMILARITY = 0.80
const SCAN_BATCH = 256
const SCAN_BUDGET_MS = 200
const MAX_SCAN_CURSORS = 8

export type MemorySemanticReference = { id: number, revision: number }
export type MemorySemanticProjection = MemorySemanticReference & { vector: Float32Array | null }

function validVector(vector: Float32Array) {
  if (vector.length !== MEMORY_EMBEDDING_DIMENSIONS) return false
  const squared = vector.reduce((sum, value) => sum + value * value, 0)
  return Math.abs(squared - 1) <= 0.005
}

function packVector(vector: Float32Array | null) {
  if (!vector) return Buffer.alloc(0)
  const bytes = Buffer.alloc(VECTOR_BYTES)
  for (let index = 0; index < vector.length; index++) bytes.writeFloatLE(vector[index], index * Float32Array.BYTES_PER_ELEMENT)
  return bytes
}

function cosine(bytes: Uint8Array, query: Float32Array) {
  if (bytes.byteLength !== VECTOR_BYTES) return NaN
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let dot = 0, squared = 0
  for (let index = 0; index < query.length; index++) {
    const value = data.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
    dot += query[index] * value
    squared += value * value
  }
  return Math.abs(squared - 1) <= 0.005 ? dot : NaN
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_semantic_config (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    fingerprint TEXT,
    codec INTEGER NOT NULL,
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_semantic_vectors (
    memory INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL,
    vector BLOB NOT NULL
  );
`
const DROP_INVALIDATION = `
  DROP TRIGGER IF EXISTS main.memory_semantic_invalidate_update;
  DROP TRIGGER IF EXISTS main.memory_semantic_invalidate_delete;
  DROP TRIGGER IF EXISTS temp.memory_semantic_invalidate_update;
  DROP TRIGGER IF EXISTS temp.memory_semantic_invalidate_delete;
`
// These hooks are installed only after the optional index is usable on this connection.
const INVALIDATION = `
  CREATE TEMP TRIGGER memory_semantic_invalidate_update
  AFTER UPDATE OF revision,text,scope,retention,state,modality,conditional,keywords ON main.memories
  WHEN OLD.revision IS NOT NEW.revision OR OLD.text IS NOT NEW.text OR OLD.scope IS NOT NEW.scope
    OR OLD.retention IS NOT NEW.retention OR OLD.state IS NOT NEW.state OR OLD.modality IS NOT NEW.modality
    OR OLD.conditional IS NOT NEW.conditional OR OLD.keywords IS NOT NEW.keywords
  BEGIN
    SELECT viva_invalidate_memory_vector(OLD.id);
  END;
  CREATE TEMP TRIGGER memory_semantic_invalidate_delete
  AFTER DELETE ON main.memories
  BEGIN
    SELECT viva_invalidate_memory_vector(OLD.id);
  END;
`

// IDs are restricted by the caller's scope and effective evidence. Check the canonical row's
// revision and retention here as well, so a delayed result cannot restore an invalid vector.
const AUTHORIZED_ROWS = `
  FROM json_each(?) refs
  CROSS JOIN memories m ON m.id=json_extract(refs.value,'$[0]') AND m.revision=json_extract(refs.value,'$[1]')
`
const RETAINED = `m.retention='retained' AND m.state IN ('active','superseded')`
const IN_SCOPE_AT = `m.scope IN (?,?,?) AND ${RETAINED} AND ${memoryWindowsOverlap}`
const VECTOR_JOIN = 'v.memory=m.id AND v.revision=m.revision'
const MISSING_VECTOR = `(v.memory IS NULL OR typeof(v.vector)<>'blob' OR length(v.vector) NOT IN (0, ${VECTOR_BYTES}))`
const refPairs = (refs: readonly MemorySemanticReference[]) => JSON.stringify(refs.map(({ id, revision }) => [id, revision]))
const configHash = (value: string) => createHash('sha256').update(value).digest('hex')
const scopeBounds = (scope: MemoryScope | undefined, interval: MemoryInterval) =>
  [...memoryScopeKeys(scope), ...memoryWindowParameters(interval)]

type Scored = MemorySemanticReference & { similarity: number }
const byScore = (a: Scored, b: Scored) => b.similarity - a.similarity || a.id - b.id
const receipt = ({ id, revision }: MemorySemanticReference) => ({ id, revision })

function schemaMatches(db: DatabaseSync) {
  const layout = db.prepare(`
    SELECT name, type, "notnull" AS required, pk FROM pragma_table_info(?)
  `)
  function matches(name: string, signature: string) {
    const kind = db.prepare('SELECT type FROM main.sqlite_schema WHERE name=?').get(name)?.type
    return kind === 'table' && layout.all(name).map(column => [column.name, column.type, column.required, column.pk].join(':')).join(',')
      === signature
  }
  return matches('memory_semantic_config', 'singleton:INTEGER:0:1,fingerprint:TEXT:0:0,codec:INTEGER:1:0,version:INTEGER:1:0')
    && matches('memory_semantic_vectors', 'memory:INTEGER:0:1,revision:INTEGER:1:0,vector:BLOB:1:0')
    && !db.prepare("SELECT 1 FROM pragma_foreign_key_list('memory_semantic_vectors')").get()
    && !db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='memory_semantic_vectors'").get()
    && !db.prepare(`SELECT 1 FROM memory_semantic_config WHERE singleton<>1 OR typeof(codec)<>'integer'
        OR typeof(version)<>'integer' OR version<0 OR (fingerprint IS NOT NULL AND typeof(fingerprint)<>'text') LIMIT 1`).get()
}

function discardDerivedTables(db: DatabaseSync) {
  const kind = db.prepare('SELECT type FROM main.sqlite_schema WHERE name=?')
  for (const name of ['memory_semantic_vectors', 'memory_semantic_config']) {
    const type = kind.get(name)?.type
    if (type === 'view') db.exec(`DROP VIEW main.${name}`)
    else if (type === 'table') db.exec(`DROP TABLE main.${name}`)
    else if (type === 'index') db.exec(`DROP INDEX main.${name}`)
  }
}

const STALE_VECTORS = `memory IN (SELECT value FROM json_each(?))
  AND (revision<? OR NOT EXISTS (SELECT 1 FROM memories m
    WHERE m.id=memory_semantic_vectors.memory AND m.revision=memory_semantic_vectors.revision AND ${RETAINED}))`

export function memorySemanticCopiesCleared(db: DatabaseSync, ids: readonly number[], revision: number) {
  try {
    const kind = db.prepare("SELECT type FROM main.sqlite_schema WHERE name='memory_semantic_vectors'").get()?.type
    return kind === undefined || (kind === 'table' && schemaMatches(db)
      && !db.prepare(`SELECT 1 FROM memory_semantic_vectors WHERE ${STALE_VECTORS} LIMIT 1`).get(JSON.stringify(ids), revision))
  } catch { return false }
}

/** Rebuildable index. It runs on ordinary SQLite so vector support can degrade independently of memory reads. */
export function openMemorySemanticIndex(db: DatabaseSync) {
  let healthy = true
  function initialize(repair = false) {
    if (repair) discardDerivedTables(db)
    db.exec(SCHEMA)
    if (!schemaMatches(db)) throw new Error('incompatible semantic index')
    db.prepare('INSERT OR IGNORE INTO memory_semantic_config VALUES (1,NULL,?,0)').run(CODEC_VERSION)
    const statements = {
      config: db.prepare('SELECT fingerprint,codec,version FROM memory_semantic_config WHERE singleton=1'),
      updateConfig: db.prepare('UPDATE memory_semantic_config SET fingerprint=?,codec=?,version=version+1 WHERE singleton=1'),
      clearVectors: db.prepare('DELETE FROM memory_semantic_vectors'),
      removeVector: db.prepare('DELETE FROM memory_semantic_vectors WHERE memory=?'),
      saveVector: db.prepare(`INSERT OR REPLACE INTO memory_semantic_vectors(memory,revision,vector)
        SELECT m.id,m.revision,? FROM memories m WHERE m.id=? AND m.revision=? AND ${RETAINED}`),
      missingVectors: db.prepare(`SELECT DISTINCT m.id,m.revision ${AUTHORIZED_ROWS}
        LEFT JOIN memory_semantic_vectors v ON ${VECTOR_JOIN}
        WHERE ${MISSING_VECTOR} AND ${RETAINED} ORDER BY refs.key LIMIT ?`),
      scopedVectors: db.prepare(`WITH page AS (
        SELECT memory FROM memory_semantic_vectors WHERE memory>? AND memory<=? ORDER BY memory LIMIT ?
      )
        SELECT p.memory AS cursor,m.id,m.revision,v.vector FROM page p
        LEFT JOIN memories m ON m.id=p.memory AND ${IN_SCOPE_AT}
        LEFT JOIN memory_semantic_vectors v ON ${VECTOR_JOIN}
        ORDER BY p.memory`),
      missingScopedVectors: db.prepare(`SELECT m.id,m.revision FROM memories m
        LEFT JOIN memory_semantic_vectors v ON ${VECTOR_JOIN}
        WHERE ${IN_SCOPE_AT} AND ${MISSING_VECTOR} ORDER BY m.id DESC LIMIT ?`),
      missingAfterId: db.prepare(`SELECT m.id,m.revision FROM memories m
        LEFT JOIN memory_semantic_vectors v ON ${VECTOR_JOIN}
        WHERE ${RETAINED} AND m.id>? AND ${MISSING_VECTOR} ORDER BY m.id LIMIT ?`),
    }
    // The optional index shares the transaction with canonical writes. A broken vector
    // table disables its own generation and must not abort edits or forgetting.
    db.function('viva_invalidate_memory_vector', value => {
      if (!healthy || typeof value !== 'number') return null
      try { statements.removeVector.run(value) }
      catch { healthy = false }
      return null
    })
    db.exec(INVALIDATION)
    return statements
  }
  let statements: ReturnType<typeof initialize>
  try {
    // Remove legacy persistent hooks before trying repair. An unavailable index must not gate a fact write.
    db.exec(DROP_INVALIDATION)
    try { statements = transaction(db, () => initialize()) }
    catch { statements = transaction(db, () => initialize(true)) }
  } catch {
    return null
  }
  const { config, updateConfig, clearVectors, saveVector, missingVectors,
    scopedVectors, missingScopedVectors, missingAfterId } = statements
  const scanCursors = new Map<string, number>()

  const settings = () => config.get() as { fingerprint: string | null, codec: number, version: number } | undefined
  function version(fingerprint: string) {
    if (!healthy) return null
    const current = settings()
    return current?.fingerprint === configHash(fingerprint) && current.codec === CODEC_VERSION ? current.version : null
  }

  function missingScoped(fingerprint: string, scope: MemoryScope | undefined, interval: MemoryInterval, limit = MEMORY_EMBEDDING_BATCH) {
    if (version(fingerprint) === null || !Number.isSafeInteger(limit) || limit < 1) return []
    return (missingScopedVectors.all(...scopeBounds(scope, interval), Math.min(limit, MEMORY_EMBEDDING_BATCH)) as MemorySemanticReference[]).map(receipt)
  }

  async function searchScoped(fingerprint: string, query: Float32Array, scope: MemoryScope | undefined, limit: number, {
    interval, signal, deadline = Infinity, accept = () => true,
  }: { interval: MemoryInterval, signal?: AbortSignal, deadline?: number, accept?: (ref: MemorySemanticReference) => boolean }) {
    const snapshot = version(fingerprint)
    if (snapshot === null || !validVector(query) || !Number.isSafeInteger(limit) || limit < 1) {
      return { hits: [], partial: false, skipped: false, incomplete: false }
    }
    const key = memoryScopeKeys(scope)[1]
    const origin = scanCursors.get(key) ?? 0
    const bounds = scopeBounds(scope, interval)
    const stop = Math.min(deadline, performance.now() + SCAN_BUDGET_MS)
    const count = Math.min(limit, MAX_RESULTS)
    let after = origin, through = Number.MAX_SAFE_INTEGER
    let partial = false, skipped = false, truncated = false
    let ranked: Scored[] = []
    scan: while (true) {
      if (signal?.aborted || version(fingerprint) !== snapshot) return { hits: [], partial: true, skipped: false, incomplete: false }
      if (performance.now() >= stop) { partial = true; break }
      const rows = scopedVectors.all(after, through, SCAN_BATCH, ...bounds) as Array<{
        cursor: number, id: number | null, revision: number | null, vector: Uint8Array | null,
      }>
      for (const { cursor, id, revision, vector } of rows) {
        if (performance.now() >= stop) { partial = true; break scan }
        after = cursor
        if (id === null || revision === null || vector === null) continue
        const similarity = cosine(vector, query)
        if (!Number.isFinite(similarity)) skipped = true
        else if (similarity >= MIN_SIMILARITY) {
          const item = { id, revision, similarity }
          const worst = ranked[count - 1]
          if (truncated && worst && byScore(item, worst) >= 0) continue
          if (!accept(receipt(item))) continue
          ranked.push(item)
          ranked.sort(byScore)
          if (ranked.length > count) { truncated = true; ranked.pop() }
        }
      }
      if (rows.length < SCAN_BATCH) {
        if (!origin || through === origin) break
        // Wrap so a request that finishes the sweep ranks both ranges together.
        after = 0
        through = origin
      }
      await setImmediate()
    }
    scanCursors.delete(key)
    if (partial && after) {
      scanCursors.set(key, after)
      if (scanCursors.size > MAX_SCAN_CURSORS) scanCursors.delete(scanCursors.keys().next().value!)
    }
    return { hits: ranked.sort(byScore).map(receipt), partial: partial || truncated, skipped,
      incomplete: missingScoped(fingerprint, scope, interval, 1).length > 0 }
  }

  return {
    configure(fingerprint: string) {
      if (!healthy || version(fingerprint) !== null) return false
      return transaction(db, () => {
        clearVectors.run()
        updateConfig.run(configHash(fingerprint), CODEC_VERSION)
        scanCursors.clear()
        return true
      })
    },
    version,
    clear() {
      if (!healthy) throw new Error('semantic index requires reconstruction')
      transaction(db, () => {
        clearVectors.run()
        updateConfig.run(settings()?.fingerprint ?? null, CODEC_VERSION)
        scanCursors.clear()
      })
    },
    purge(ids: readonly number[], revision: number) {
      try {
        if (!healthy || !schemaMatches(db)) return false
        transaction(db, () => {
          db.prepare(`DELETE FROM memory_semantic_vectors WHERE ${STALE_VECTORS}`).run(JSON.stringify(ids), revision)
          updateConfig.run(settings()?.fingerprint ?? null, CODEC_VERSION)
          scanCursors.clear()
        })
        return memorySemanticCopiesCleared(db, ids, revision)
      } catch { return false }
    },
    missing(fingerprint: string, authorized: readonly MemorySemanticReference[], limit = MEMORY_EMBEDDING_BATCH) {
      if (version(fingerprint) === null || !authorized.length || !Number.isSafeInteger(limit) || limit < 1) return []
      return (missingVectors.all(refPairs(authorized), Math.min(limit, MEMORY_EMBEDDING_BATCH)) as MemorySemanticReference[])
        .map(({ id, revision }) => ({ id, revision }))
    },
    missingScoped,
    missingAfter(fingerprint: string, afterId: number, limit = MEMORY_EMBEDDING_BATCH) {
      if (version(fingerprint) === null || !Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1) return []
      return (missingAfterId.all(afterId, Math.min(limit, MEMORY_EMBEDDING_BATCH)) as MemorySemanticReference[]).map(receipt)
    },
    put(fingerprint: string, items: readonly MemorySemanticProjection[], expectedVersion: number) {
      if (items.length > MEMORY_EMBEDDING_BATCH || !items.every(({ vector }) => vector === null || validVector(vector))) return 0
      return transaction(db, () => {
        const current = version(fingerprint)
        if (current !== expectedVersion) return 0
        return items.reduce((count, { id, revision, vector }) => count + Number(saveVector.run(packVector(vector), id, revision).changes), 0)
      })
    },
    searchScoped,
  }
}

export type MemorySemanticIndex = NonNullable<ReturnType<typeof openMemorySemanticIndex>>
