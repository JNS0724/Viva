import type { DatabaseSync } from 'node:sqlite'
import { memoryProvenanceSchema, type MemoryProvenance } from '../memory/contracts/provenance.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { REPORT } from './task-reports.ts'

/** A report keeps its originating proof when read into another conversation. */
export function eraseMemoryReportCopies(db: DatabaseSync, matches: (memory: MemoryProvenance) => boolean): string[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
  const hasQueue = Boolean(exists.get('effects')), hasRecords = Boolean(exists.get('report_records'))
  const hasProofs = Boolean(exists.get('memory_report_proofs'))
  const ids = new Set<string>()
  const matchesProof = (raw: unknown) => {
    const proof = memoryProvenanceSchema.safeParse(raw)
    return proof.success && matches(proof.data)
  }
  if (hasQueue) for (const row of db.prepare('SELECT key,payload FROM effects WHERE kind=?').all(REPORT)) {
    if (matchesProof(objectOf(JSON.parse(String(row.payload)))?.memory)) ids.add(String(row.key))
  }
  if (hasProofs) for (const row of db.prepare('SELECT report_id,memory FROM memory_report_proofs').all()) {
    if (matchesProof(JSON.parse(String(row.memory)))) ids.add(String(row.report_id))
  }
  for (const id of ids) {
    if (hasQueue) db.prepare('DELETE FROM effects WHERE kind=? AND key=?').run(REPORT, id)
    if (hasRecords) db.prepare('DELETE FROM report_records WHERE report_id=?').run(id)
    if (hasProofs) db.prepare('DELETE FROM memory_report_proofs WHERE report_id=?').run(id)
  }
  return [...ids]
}
