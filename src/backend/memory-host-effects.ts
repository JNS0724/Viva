import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HostMemoryCaller } from '../memory/contracts/host.ts'
import type { MemoryHostEffect, MemoryHostErasureRange } from '../memory/contracts/service.ts'
import type { Apply } from './journal.ts'
import { transaction, truncateMemoryJournal } from './app-db.ts'
import { usesErasedMemory, type MemoryProvenance } from '../memory/contracts/provenance.ts'
import { eraseScheduledMemoryCopies } from './memory-scheduled-copies.ts'
import { eraseMemoryReportCopies } from './memory-report-copies.ts'
import type { GeneratedHistoryScope } from './history-generated-copies.ts'
import { objectOf } from '../shared/unknown-value.ts'

type Cleanup = MemoryHostEffect & { sessions?: readonly string[], memoryIds?: readonly number[] }

export function affectedTraceSessions(effect: MemoryHostEffect) {
  if (effect.kind === 'erase-file-copies') return [...new Set([...effect.sessions ?? [], ...effect.traceSessions ?? []])]
  return effect.kind === 'erase-copies' ? effect.sessions ?? [] : []
}
/** Host-owned copy erasure. The owner supplies identities; this adapter never infers memory semantics. */
export function createMemoryHostEffects({ db, call, apply, eraseHistory, eraseFileHistory, invalidate, invalidateScheduled = () => {}, eraseRoutedMemory = () => {}, reportsRemoved = () => {}, traceInvalidated = () => {}, eraseTaskBodies = () => [], invalidateTaskBodies = () => {}, fileCopiesDurable = () => {} }: {
  db: DatabaseSync, call: HostMemoryCaller, apply: Apply,
  eraseHistory(sources: readonly string[], sessions: readonly string[], briefs?: readonly { session: string, text: string }[]): void,
  eraseFileHistory(ranges: readonly MemoryHostErasureRange[], memoryIds?: readonly number[]): readonly GeneratedHistoryScope[] | void,
  eraseTaskBodies?(effect: string, matches: (proof: MemoryProvenance) => boolean, erased: readonly GeneratedHistoryScope[]): readonly string[],
  invalidateTaskBodies?(sessions: readonly string[]): void | Promise<void>,
  /** A local host receipt only. Native publishers and other replica owners acknowledge separately. */
  fileCopiesDurable?(effect: Extract<MemoryHostEffect, { kind: 'erase-file-copies' }>): void | Promise<void>,
  invalidateScheduled?(matches: (memory: MemoryProvenance) => boolean, changed: boolean): void,
  eraseRoutedMemory?(matches: (memory: MemoryProvenance) => boolean): void,
  reportsRemoved?(reportIds: readonly string[]): void,
  traceInvalidated?(sessions: readonly string[]): void,
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
  const notifiedTraces = new Set<string>()
  const discardedTaskCopies = new Map<string, Set<string>>()
  async function recover() {
    if (closed) return
    if (running) return running
    clearTimeout(retry); retry = undefined
    running = (async () => {
      const effects = await call('pendingHostEffects', {})
      let rangeError: { cause: unknown } | undefined
      const checkpointRanges: Extract<MemoryHostEffect, { kind: 'erase-file-copies' }>[] = []
      const blockedRanges = new Set<string>()
      for (const effect of effects) {
        const trace = affectedTraceSessions(effect)
        if (trace.length && !notifiedTraces.has(effect.effectId)) {
          traceInvalidated(trace)
          notifiedTraces.add(effect.effectId)
        }
        if (effect.kind === 'erase-file-copies') {
          try {
            if (effect.ranges.some(cut => blockedRanges.has(cut.sourceId))) continue
            const matches = (memory: MemoryProvenance) => usesErasedMemory(memory, effect.ranges, effect.memoryIds)
            const { scheduled, reports, tasks } = transaction(db, () => {
              const outputs = eraseFileHistory(effect.ranges, effect.memoryIds) ?? []
              const tasks = eraseTaskBodies(effect.effectId, matches, outputs)
              eraseRoutedMemory(matches)
              return { scheduled: eraseScheduledMemoryCopies(db, matches), reports: eraseMemoryReportCopies(db, matches), tasks }
            })
            invalidateScheduled(matches, scheduled)
            if (reports.length) reportsRemoved(reports)
            const discarded = discardedTaskCopies.get(effect.effectId) ?? new Set<string>()
            const pendingTasks = tasks.filter(task => !discarded.has(task))
            if (pendingTasks.length) {
              await invalidateTaskBodies(pendingTasks)
              for (const task of pendingTasks) discarded.add(task)
              discardedTaskCopies.set(effect.effectId, discarded)
            }
            checkpointRanges.push(effect)
          } catch (error) {
            rangeError ??= { cause: error }
            for (const cut of effect.ranges) blockedRanges.add(cut.sourceId)
          }
          // The complete effect also covers native transcripts, later trace groups and host maintenance receipts.
          continue
        }
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
      if (checkpointRanges.length && !truncateMemoryJournal(db)) throw new Error('Memory host replica cleanup is pending a durable checkpoint')
      for (const effect of checkpointRanges) await fileCopiesDurable(effect)
      if (rangeError) throw rangeError.cause
    })()
    try { await running } catch (error) {
      if (!closed) { retry = setTimeout(() => { void recover().catch(() => {}) }, 1000); retry.unref() }
      throw error
    } finally { running = undefined }
  }
  return { recover, close() { closed = true; clearTimeout(retry) } }
}
