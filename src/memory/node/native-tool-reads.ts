import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { intersectsMemoryErasure, memoryErasureEvidence, memoryErasureEvidenceSchema, type MemoryErasureEvidence } from '../contracts/provenance.ts'
import type { MemoryFileDependency } from '../contracts/records.ts'
import { transaction } from './sqlite.ts'

const ordinal = z.int().nonnegative()
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
export const nativeToolCallShape = z.strictObject({
  id: z.uuid(), session: z.string().min(1).max(256), callId: z.string().min(1).max(256),
  generation: ordinal, turn: ordinal, step: ordinal, seq: ordinal, digest,
  outputAttempt: z.uuid().optional(),
  ptc: z.strictObject({ rootCallId: z.string().min(1).max(256), parentCallId: z.string().min(1).max(256) }).optional(),
})
const resultShape = z.strictObject({ seq: ordinal, digest })
export type NativeToolCall = z.output<typeof nativeToolCallShape>
export type NativeToolResult = z.output<typeof resultShape>

/** Keep the readset of the tool execution that produced the bytes, even when
 * no subsequent model request consumes its result. */
export function createNativeToolReads(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_native_tool_calls (id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT);
    CREATE TABLE IF NOT EXISTS owner_native_tool_reads (
      call TEXT NOT NULL REFERENCES owner_native_tool_calls(id), evidence TEXT NOT NULL,
      PRIMARY KEY(call,evidence)
    ) WITHOUT ROWID;
  `)
  const existing = db.prepare('SELECT identity,result FROM owner_native_tool_calls WHERE id=?')
  const add = db.prepare('INSERT INTO owner_native_tool_calls VALUES (?,?,NULL)')
  const append = db.prepare('INSERT OR IGNORE INTO owner_native_tool_reads VALUES (?,?)')
  const settle = db.prepare('UPDATE owner_native_tool_calls SET result=? WHERE id=?')
  const reads = db.prepare(`SELECT c.identity,c.result,r.evidence FROM owner_native_tool_reads r
    JOIN owner_native_tool_calls c ON c.id=r.call`)
  function record(call: NativeToolCall, files: readonly MemoryFileDependency[], sources: readonly string[]) {
    if (!files.length) return
    const evidence = memoryErasureEvidence({ files: [...files], sources: [...sources], fileSources: [...sources],
      dependencies: [], turnOnly: false, epoch: 0 })
    recordEvidence(call, evidence)
  }
  function recordEvidence(call: NativeToolCall, evidence: MemoryErasureEvidence) {
    const identity = JSON.stringify(nativeToolCallShape.parse(call))
    transaction(db, () => {
      const prior = existing.get(call.id)
      if (!prior) add.run(call.id, identity)
      else if (prior.identity !== identity || prior.result !== null) throw new Error('Native tool read does not belong to the live call')
      append.run(call.id, JSON.stringify(memoryErasureEvidenceSchema.parse(evidence)))
    })
  }
  function finish(call: NativeToolCall, result: NativeToolResult) {
    const prior = existing.get(call.id)
    if (!prior) return
    if (prior.identity !== JSON.stringify(nativeToolCallShape.parse(call)) || result.seq <= call.seq) throw new Error('Native tool result changed call identity')
    const encoded = JSON.stringify(resultShape.parse(result))
    if (prior.result === encoded) return
    if (prior.result !== null) throw new Error('Native tool result conflicts with its receipt')
    settle.run(encoded, call.id)
  }
  function affected(ranges: Parameters<typeof intersectsMemoryErasure>[1]) {
    const matches = new Map<string, NativeToolCall & { result: NativeToolResult | null }>()
    for (const row of reads.iterate()) {
      const evidence = memoryErasureEvidenceSchema.parse(JSON.parse(String(row.evidence)))
      if (!intersectsMemoryErasure(evidence, ranges)) continue
      const call = nativeToolCallShape.parse(JSON.parse(String(row.identity)))
      matches.set(call.id, { ...call, result: row.result === null ? null : resultShape.parse(JSON.parse(String(row.result))) })
    }
    return [...matches.values()]
  }
  return { record, recordEvidence, finish, affected }
}
