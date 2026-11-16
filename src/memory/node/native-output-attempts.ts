import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { intersectsMemoryErasure, memoryErasureEvidence, memoryErasureEvidenceSchema, type MemoryProvenance } from '../contracts/provenance.ts'
import { transaction } from './sqlite.ts'

const ordinal = z.int().nonnegative()
const attemptShape = z.strictObject({
  id: z.uuid(), session: z.string().min(1).max(256), generation: ordinal,
  turn: ordinal, step: ordinal, floor: ordinal,
})
const terminalShape = z.strictObject({
  seq: ordinal, kind: z.enum(['reply', 'attempt']),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
})
const resultShape = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('open') }),
  z.strictObject({ state: z.literal('abandoned') }),
  z.strictObject({ state: z.literal('settled'), terminal: terminalShape }),
])
export type NativeOutputAttempt = z.output<typeof attemptShape>
export type NativeOutputTerminal = z.output<typeof terminalShape>
type Result = z.output<typeof resultShape>

/** Records the authority of a physical send and the settlement identity independently of intake
 * and context generation checks. The output can finish after the send's generation was retired. */
export function createNativeOutputAttempts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_native_output_attempts (
      id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_native_output_reads (
      attempt TEXT NOT NULL REFERENCES owner_native_output_attempts(id), evidence TEXT NOT NULL,
      PRIMARY KEY(attempt,evidence)
    ) WITHOUT ROWID;
  `)
  const read = db.prepare('SELECT identity,result FROM owner_native_output_attempts WHERE id=?')
  const begin = db.prepare('INSERT INTO owner_native_output_attempts VALUES (?,?,?)')
  const attach = db.prepare('INSERT OR IGNORE INTO owner_native_output_reads VALUES (?,?)')
  const settle = db.prepare('UPDATE owner_native_output_attempts SET result=? WHERE id=?')
  const relevant = db.prepare(`SELECT a.identity,a.result,r.evidence FROM owner_native_output_reads r
    JOIN owner_native_output_attempts a ON a.id=r.attempt`)

  const byOutput = db.prepare(`SELECT r.evidence FROM owner_native_output_reads r JOIN owner_native_output_attempts a ON a.id=r.attempt
    WHERE json_extract(a.identity,'$.session')=? AND json_extract(a.result,'$.state')='settled'
    AND json_extract(a.result,'$.terminal.kind')='reply' AND json_extract(a.result,'$.terminal.seq')=?
    AND json_extract(a.result,'$.terminal.digest')=? ORDER BY r.evidence`)

  function outputEvidence(session: string, seq: number, digest: string) {
    const rows = byOutput.all(session, seq, digest)
    return rows.length ? rows.map(row => memoryErasureEvidenceSchema.parse(JSON.parse(String(row.evidence)))) : null
  }

  function record(attempt: NativeOutputAttempt, evidence: MemoryProvenance) {
    const identity = JSON.stringify(attemptShape.parse(attempt))
    const bound = JSON.stringify(memoryErasureEvidence(evidence))
    transaction(db, () => {
      const current = read.get(attempt.id)
      if (!current) begin.run(attempt.id, identity, JSON.stringify({ state: 'open' }))
      else if (current.identity !== identity || resultShape.parse(JSON.parse(String(current.result))).state !== 'open') {
        throw new Error('Native output send attempt identity conflicts')
      }
      attach.run(attempt.id, bound)
    })
  }

  function finish(attempt: NativeOutputAttempt, terminal?: NativeOutputTerminal) {
    const identity = JSON.stringify(attemptShape.parse(attempt))
    if (terminal && terminal.seq < attempt.floor) throw new Error('Unexpected native output settlement')
    const result: Result = terminal ? { state: 'settled', terminal: terminalShape.parse(terminal) } : { state: 'abandoned' }
    const encoded = JSON.stringify(result)
    const current = read.get(attempt.id)
    // A late SDK retry can still hold the permit of an attempt that sent no body.
    if (!current) { begin.run(attempt.id, identity, encoded); return }
    if (current.identity !== identity) throw new Error('Unexpected native output settlement')
    if (current.result === encoded) return
    if (resultShape.parse(JSON.parse(String(current.result))).state !== 'open') throw new Error('Native output settlement conflicts')
    settle.run(encoded, attempt.id)
  }

  function affected(ranges: Parameters<typeof intersectsMemoryErasure>[1], memoryIds: readonly number[]) {
    const matches = new Map<string, NativeOutputAttempt & { result: Result }>()
    for (const row of relevant.iterate()) {
      const evidence = memoryErasureEvidenceSchema.parse(JSON.parse(String(row.evidence)))
      if (!intersectsMemoryErasure(evidence, ranges, memoryIds)) continue
      const attempt = attemptShape.parse(JSON.parse(String(row.identity)))
      const result = resultShape.parse(JSON.parse(String(row.result)))
      if (result.state !== 'abandoned') matches.set(attempt.id, { ...attempt, result })
    }
    return [...matches.values()]
  }

  return { record, finish, affected, outputEvidence }
}
