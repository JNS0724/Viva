import type { DatabaseSync } from 'node:sqlite'
import { memoryProvenanceSchema, type MemoryProvenance } from '../memory/contracts/provenance.ts'
import { feedSourceIdentity } from './feed-store.ts'

/** Body-bearing schedules, queued inputs and feed results are separate copies with their own provenance. */
export function eraseScheduledMemoryCopies(db: DatabaseSync, matches: (memory: MemoryProvenance) => boolean, effect: string) {
  db.exec('CREATE TABLE IF NOT EXISTS memory_erased_feed_copies (id TEXT PRIMARY KEY,identity TEXT NOT NULL UNIQUE,effect TEXT NOT NULL)')
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
  const hasScheduleRuns = exists.get('schedule_runs')
  const matchesStored = (stored: unknown) => {
    const proof = memoryProvenanceSchema.safeParse(JSON.parse(String(stored)))
    return proof.success && matches(proof.data)
  }
  let changed = false
  if (exists.get('schedules')) for (const row of db.prepare('SELECT id,revision,memory FROM schedules WHERE memory IS NOT NULL').all()) {
    if (!matchesStored(row.memory)) continue
    db.prepare('DELETE FROM schedules WHERE id=?').run(row.id)
    if (hasScheduleRuns) db.prepare('DELETE FROM schedule_runs WHERE schedule_id=? AND schedule_revision=?').run(row.id, row.revision)
    changed = true
  }
  if (hasScheduleRuns) for (const row of db.prepare('SELECT key,memory FROM schedule_runs WHERE memory IS NOT NULL').all()) {
    if (!matchesStored(row.memory)) continue
    db.prepare('DELETE FROM schedule_runs WHERE key=?').run(row.key)
    changed = true
  }
  const hasEffects = exists.get('effects')
  if (exists.get('feed_items')) for (const row of db.prepare('SELECT id,source,key,memory FROM feed_items WHERE memory IS NOT NULL').all()) {
    if (!matchesStored(row.memory)) continue
    db.prepare('INSERT OR IGNORE INTO memory_erased_feed_copies VALUES (?,?,?)').run(row.id, feedSourceIdentity(String(row.source), String(row.key)), effect)
    db.prepare('DELETE FROM feed_items WHERE id=?').run(row.id)
    if (hasEffects) db.prepare("DELETE FROM effects WHERE kind='feed-notice' AND key=?").run(row.id)
    changed = true
  }
  return { changed, feedIds: db.prepare('SELECT id FROM memory_erased_feed_copies WHERE effect=?').all(effect).map(row => String(row.id)) }
}
