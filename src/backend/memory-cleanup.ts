import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { MemorySpan } from '../shared/memory-contract.ts'
import { operationId } from '../shared/memory-contract.ts'
import type { MemoryDeleteResult } from '../shared/ipc-results.ts'
import { transaction } from './app-db.ts'
import type { Effect, Effects, Outcome } from './effects.ts'

export const MEMORY_CLEANUP = 'memory.cleanup'
const RECEIPT_PREFIX = 'cleanup-receipt:'
const cleanupPlan = z.strictObject({
  id: z.int().positive(),
  ids: z.array(z.int().positive()),
  revision: z.int().positive(),
  questions: z.array(operationId),
  redactions: z.array(z.strictObject({
    sourceId: operationId,
    spans: z.array(z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() }))
      .refine(spans => spans.every(span => span.start < span.end)),
  })),
})
type Redaction = { sourceId: string, spans: readonly MemorySpan[] }
type CleanupPlan = z.infer<typeof cleanupPlan>

export function createMemoryCleanup({ db, effects, lexical, clearSemantic, clearProfile, hasCandidateReference, onCleared }: {
  db: DatabaseSync,
  effects: Pick<Effects, 'queue' | 'get' | 'holds' | 'finishGeneration' | 'runs' | 'wake'>,
  lexical: { purge: (ids: readonly number[], revision: number) => boolean },
  clearSemantic: (ids: readonly number[], revision: number) => boolean,
  clearProfile?: (revision: number) => boolean,
  hasCandidateReference: (id: number) => boolean,
  onCleared?: () => void,
}) {
  const receipt = db.prepare('SELECT value FROM memory_meta WHERE key=?')
  const saveReceipt = db.prepare('INSERT OR REPLACE INTO memory_meta VALUES (?,?)')
  const count = db.prepare(`SELECT count(*) AS count FROM memory_meta
    WHERE key >= '${RECEIPT_PREFIX}' AND key < 'cleanup-receipt;' AND value='stopped'`)
  const removed = db.prepare(`
    SELECT 1 FROM memories WHERE id=?
    UNION ALL SELECT 1 FROM memory_evidence WHERE memory=?
    UNION ALL SELECT 1 FROM memory_facts WHERE memory=?
    LIMIT 1
  `)
  const source = db.prepare('SELECT text,question FROM memory_sources WHERE id=?')
  const questionCopy = db.prepare(`SELECT 1 FROM json_each(?) ids JOIN memory_sources s ON s.id=ids.value
    WHERE s.question IS NOT NULL LIMIT 1`)
  const candidate = db.prepare('SELECT 1 FROM memory_candidates WHERE source=? LIMIT 1')
  const extraction = db.prepare("SELECT 1 FROM effects WHERE kind='memory.extract' AND key=?")
  const evidence = db.prepare(`SELECT e.spans FROM memory_evidence e WHERE e.source=?`)

  function canonicalClear({ id, redactions, questions }: CleanupPlan) {
    if (removed.get(id, id, id) || hasCandidateReference(id) || questionCopy.get(JSON.stringify(questions))) return false
    return redactions.every(({ sourceId, spans }) => {
      const row = source.get(sourceId) as { text: string | null, question: string | null } | undefined
      const remaining = (evidence.all(sourceId) as { spans: string }[])
        .flatMap(edge => JSON.parse(edge.spans) as MemorySpan[])
      // Changes retain offsets to explain the surviving fact, while the removed values at those offsets stay blank.
      return !candidate.get(sourceId) && !extraction.get(sourceId) && row?.question == null
        && spans.every(({ start, end }) => /^ *$/u.test(row?.text?.slice(start, end) ?? '')
          && !remaining.some(span => span.start < end && start < span.end))
    })
  }

  function truncateJournal() {
    if (db.prepare('PRAGMA secure_delete').get()?.secure_delete !== 1) return false
    const timeout = Number(db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0)
    db.exec('PRAGMA busy_timeout=0')
    try {
      const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      return result?.busy === 0 && result.log === result.checkpointed
    } finally {
      db.exec(`PRAGMA busy_timeout=${timeout}`)
    }
  }

  function clean(job: Effect): Outcome {
    try {
      if (!effects.holds(job)) return 'wait'
      const plan = cleanupPlan.parse(job.payload)
      const ids = [...new Set([plan.id, ...plan.ids])]
      if (db.isTransaction || !canonicalClear(plan)
        || !lexical.purge(ids, plan.revision)
        || !clearSemantic(ids, plan.revision)
        || (clearProfile && !clearProfile(plan.revision))
        || !truncateJournal()) return 'retry'
      const recorded = transaction(db, () => {
        if (!effects.finishGeneration(job)) return false
        saveReceipt.run(RECEIPT_PREFIX + job.key, 'cleared')
        return true
      })
      if (!recorded) return 'retry'
    } catch { return 'retry' }
    try { onCleared?.() } catch { /* The completion is already durable. */ }
    return 'done'
  }

  effects.runs(MEMORY_CLEANUP, async jobs => new Map(jobs.map(job => [job.key, clean(job)])))
  const status = (operation: string): MemoryDeleteResult => ({
    status: receipt.get(RECEIPT_PREFIX + operation)?.value === 'cleared' ? 'cleared' : 'stopped',
  })
  return {
    queue(operation: string, id: number, ids: readonly number[], revision: number, redactions: readonly Redaction[] = [], questions: readonly string[] = []) {
      transaction(db, () => {
        saveReceipt.run(RECEIPT_PREFIX + operation, 'stopped')
        effects.queue(MEMORY_CLEANUP, operation, { id, ids, revision, redactions, questions })
      })
    },
    attempt(operation: string): MemoryDeleteResult {
      try {
        const job = effects.get(MEMORY_CLEANUP, operation)
        if (job && clean(job) !== 'done') void effects.wake()
      } catch {
        void effects.wake()
      }
      return status(operation)
    },
    status,
    pending: () => Number(count.get()?.count ?? 0),
  }
}
