import type { DatabaseSync } from 'node:sqlite'
import { memoryProvenanceSchema, usesErasedMemory } from '../contracts/provenance.ts'
import { transaction } from './sqlite.ts'

/** The adapter knows the native role and source tag. The owner already stores
 * content digests and provenance, so this table records only that role binding. */
export function createNativeDerivedMessages(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_native_derived_messages (
    message TEXT PRIMARY KEY, source TEXT NOT NULL, erased INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`)
  const read = db.prepare('SELECT source FROM owner_native_derived_messages WHERE message=?')
  const bind = db.prepare('INSERT INTO owner_native_derived_messages(message,source) VALUES (?,?)')
  const mark = db.prepare('UPDATE owner_native_derived_messages SET erased=1 WHERE message=?')
  const rows = db.prepare(`SELECT n.message,n.source,d.evidence,c.digest FROM owner_native_derived_messages n
    JOIN owner_derived d ON d.message=n.message JOIN owner_message_content c ON c.message=n.message
    WHERE n.erased=0`)
  return {
    bind(message: string, source: string) {
      const previous = read.get(message)
      if (!previous) bind.run(message, source)
      else if (previous.source !== source) throw new Error('Native derived message source conflicts')
    },
    affected(ranges: Parameters<typeof usesErasedMemory>[1], memoryIds: readonly number[]) {
      return rows.all().flatMap(row => {
        const evidence = memoryProvenanceSchema.parse(JSON.parse(String(row.evidence)))
        return usesErasedMemory(evidence, ranges, memoryIds) ? [{ message: String(row.message), source: String(row.source), digest: String(row.digest) }] : []
      })
    },
    erased(messages: readonly string[]) {
      transaction(db, () => { for (const message of messages) mark.run(message) })
    },
  }
}
