import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HostMemoryCaller } from '../memory/contracts/host.ts'
import type { MemoryHostEffect } from '../memory/contracts/service.ts'
import type { Apply } from './journal.ts'
import { truncateMemoryJournal } from './app-db.ts'
import { objectOf } from '../shared/unknown-value.ts'

type Cleanup = MemoryHostEffect & { sessions?: readonly string[], memoryIds?: readonly number[] }
/** Host-owned copy erasure. The owner supplies identities; this adapter never infers memory semantics. */
export function createMemoryHostEffects({ db, call, apply, eraseHistory, invalidate }: {
  db: DatabaseSync, call: HostMemoryCaller, apply: Apply,
  eraseHistory(sources: readonly string[], sessions: readonly string[], briefs?: readonly { session: string, text: string }[]): void,
  invalidate(effect: MemoryHostEffect): void | Promise<void>,
}) {
  db.exec('CREATE TABLE IF NOT EXISTS memory_host_receipts (effect TEXT PRIMARY KEY,cause TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL)')
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  function eraseDerived(effect: Cleanup) {
    const sources = new Set(effect.sources.map(source => source.sourceId)), sessions = new Set(effect.sessions ?? []), memories = new Set(effect.memoryIds ?? [])
    const matches = (raw: unknown) => {
      const value = objectOf(raw)
      return Boolean(value && (Array.isArray(value.sources) && value.sources.some(source => typeof source === 'string' && sources.has(source))
        || Array.isArray(value.dependencies) && value.dependencies.some(ref => { const item = objectOf(ref); return typeof item?.id === 'number' && memories.has(item.id) })))
    }
    if (table('feed_items')) for (const row of db.prepare('SELECT id,memory FROM feed_items WHERE memory IS NOT NULL').all()) {
      if (matches(JSON.parse(String(row.memory)))) {
        db.prepare('DELETE FROM feed_items WHERE id=?').run(row.id)
        if (table('effects')) db.prepare("DELETE FROM effects WHERE kind='feed-notice' AND key=?").run(row.id)
      }
    }
    if (table('schedules')) for (const row of db.prepare('SELECT id,memory,record FROM schedules WHERE memory IS NOT NULL').all()) {
      if (matches(JSON.parse(String(row.memory)))) {
        const record = objectOf(JSON.parse(String(row.record)))
        db.prepare("UPDATE schedules SET status='paused',record=?,revision=revision+1 WHERE id=?").run(JSON.stringify({ ...record, title: '', prompt: '' }), row.id)
      }
    }
    if (table('schedule_runs')) for (const row of db.prepare('SELECT key,memory FROM schedule_runs WHERE memory IS NOT NULL').all()) {
      if (matches(JSON.parse(String(row.memory)))) db.prepare('DELETE FROM schedule_runs WHERE key=?').run(row.key)
    }
    if (table('effects')) for (const row of db.prepare("SELECT kind,key,payload FROM effects WHERE kind='report'").all()) {
      const value = objectOf(JSON.parse(String(row.payload)))
      if (typeof value?.taskId === 'string' && sessions.has(value.taskId)) db.prepare('DELETE FROM effects WHERE kind=? AND key=?').run(row.kind, row.key)
    }
    if (table('background_tasks')) for (const session of sessions) db.prepare('DELETE FROM background_tasks WHERE id=?').run(session)
  }
  let running: Promise<void> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false
  async function recover() {
    if (closed) return
    if (running) return running
    clearTimeout(retry); retry = undefined
    running = (async () => {
      const effects = await call('pendingHostEffects', {})
      for (const effect of effects) {
        // Range erasure stays pending until the host can prove selective cleanup.
        // Applying the older whole-source path would erase unrelated user text.
        if (effect.kind === 'erase-file-copies') continue
        const fingerprint = createHash('sha256').update(JSON.stringify(effect)).digest('hex')
        const old = db.prepare('SELECT cause,revision,fingerprint FROM memory_host_receipts WHERE effect=?').get(effect.effectId)
        if (old && (old.cause !== effect.causeOperationId || old.revision !== effect.revision || old.fingerprint !== fingerprint)) throw new Error('Memory host effect identity conflicts')
        if (!old) apply('memory.host.effect', { effectId: effect.effectId, causeOperationId: effect.causeOperationId, revision: effect.revision }, () => {
          if (effect.kind === 'erase-copies') {
            const briefs = table('background_tasks') ? (effect.sessions ?? []).flatMap(session => {
              const row = db.prepare('SELECT task FROM background_tasks WHERE id=?').get(session)
              const task = row ? objectOf(JSON.parse(String(row.task))) : null
              return typeof task?.words === 'string' && task.words ? [{ session, text: task.words }] : []
            }) : []
            eraseHistory(effect.sources.map(source => source.sourceId), effect.sessions ?? [], briefs)
            eraseDerived(effect)
          }
          db.prepare('INSERT INTO memory_host_receipts VALUES (?,?,?,?)').run(effect.effectId, effect.causeOperationId, effect.revision, fingerprint)
        })
        await invalidate(effect)
        if (effect.kind === 'erase-copies' && !truncateMemoryJournal(db)) {
          throw new Error('Memory host replica cleanup is pending a durable checkpoint')
        }
        await call('ackHostEffect', { effectId: effect.effectId, causeOperationId: effect.causeOperationId, revision: effect.revision })
      }
    })()
    try { await running } catch (error) {
      if (!closed) { retry = setTimeout(() => { void recover().catch(() => {}) }, 1000); retry.unref() }
      throw error
    } finally { running = undefined }
  }
  return { recover, close() { closed = true; clearTimeout(retry) } }
}
