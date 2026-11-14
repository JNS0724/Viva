import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { transaction } from './app-db.ts'
import { memoryProfileRefs, memoryProfileScope } from './memory-profile.ts'
import type { MemoryProfileRef, MemoryProfileScope } from './memory-profile.ts'
import { memoryScopeKey, memoryScopeKeys } from './memory-store.ts'

const projectionRecord = z.strictObject({
  revision: z.int().nonnegative(),
  generator: z.string().min(1).max(256),
  generatedAt: z.int(),
  validUntil: z.int().nullable(),
  refs: memoryProfileRefs,
})

export type MemoryProfileProjection = z.infer<typeof projectionRecord> & { scope: MemoryProfileScope }

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

/** Store generation receipts in memory.db and re-read the text from canonical evidence on delivery. */
export function openMemoryProfileStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_projections (
    scope TEXT PRIMARY KEY, content_revision INTEGER NOT NULL, generator TEXT NOT NULL,
    generated_at INTEGER NOT NULL, valid_until INTEGER, refs TEXT NOT NULL
  )`)
  const get = db.prepare(`SELECT content_revision AS revision,generator,generated_at AS generatedAt,
    valid_until AS validUntil,refs FROM memory_projections WHERE scope=?`)
  const write = db.prepare(`INSERT INTO memory_projections VALUES (?,?,?,?,?,?)
    ON CONFLICT(scope) DO UPDATE SET content_revision=excluded.content_revision,generator=excluded.generator,
      generated_at=excluded.generated_at,valid_until=excluded.valid_until,refs=excluded.refs
    WHERE excluded.content_revision>=memory_projections.content_revision`)
  const contentRevision = db.prepare("SELECT value FROM memory_meta WHERE key='revision'")
  const memory = db.prepare(`SELECT 1 FROM memories WHERE id=? AND revision=? AND scope IN (?,?)
    AND retention='retained' AND state IN ('active','superseded') AND modality='asserted' AND conditional=0`)
  const field = db.prepare('SELECT 1 FROM profile WHERE field=? AND revision=?')
  const listScopes = db.prepare('SELECT scope FROM memory_projections ORDER BY generated_at DESC,scope LIMIT ?')
  const expire = db.prepare('DELETE FROM memory_projections WHERE content_revision<?')
  const clear = db.prepare('DELETE FROM memory_projections')

  function exactRefs(scope: MemoryProfileScope, refs: readonly MemoryProfileRef[]) {
    const [, exactScope, alternateScope] = memoryScopeKeys(scope)
    const seen = new Set<string>()
    for (const ref of refs) {
      const key = ref.kind === 'memory' ? `memory:${ref.id}` : `manual:${ref.field}`
      if (seen.has(key)) return false
      seen.add(key)
      if (ref.kind === 'memory') {
        if (!memory.get(ref.id, ref.revision, exactScope, alternateScope)) return false
      } else if (scope.kind !== 'user' || !field.get(ref.field, ref.revision)) return false
    }
    return true
  }

  return {
    read(scope: MemoryProfileScope): MemoryProfileProjection | null {
      const row = get.get(memoryScopeKey(scope))
      if (!row) return null
      const parsed = projectionRecord.safeParse({ ...row, refs: decoded(row.refs) })
      return parsed.success ? { ...parsed.data, scope } : null
    },
    /** The caller can also complete its effect generation in this transaction. */
    save({ scope, ...projection }: MemoryProfileProjection, now: number) {
      const parsed = projectionRecord.safeParse(projection)
      if (!memoryProfileScope.safeParse(scope).success || !parsed.success || projection.generatedAt > now
        || (projection.validUntil !== null && projection.validUntil <= now)) return false
      return transaction(db, () => {
        const current = Number(contentRevision.get()?.value ?? 0)
        if (current !== projection.revision || !exactRefs(scope, projection.refs)) return false
        return write.run(memoryScopeKey(scope), projection.revision, projection.generator, projection.generatedAt,
          projection.validUntil, JSON.stringify(projection.refs)).changes > 0
      })
    },
    scopes(limit = -1): MemoryProfileScope[] {
      return listScopes.all(limit).flatMap(row => {
        const parsed = memoryProfileScope.safeParse(decoded(row.scope))
        return parsed.success ? [parsed.data] : []
      })
    },
    invalidate(revision: number) { expire.run(revision) },
    clear() { clear.run() },
  }
}
