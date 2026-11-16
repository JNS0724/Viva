import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { nativeToolCallShape, type NativeToolCall } from './native-tool-reads.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const intent = z.strictObject({ call: nativeToolCallShape, root: z.string().min(1), hash, bytes: z.int().nonnegative() })
const file = z.strictObject({ path: z.string().min(1), dev: z.int().nonnegative(), ino: z.int().nonnegative() })
export type NativeSpillIntent = z.output<typeof intent>
export type NativeSpillFile = z.output<typeof file>

/** Exact local spill receipts contain identities and digests, never tool prose. */
export function createNativeSpills(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_native_spills (
    id TEXT PRIMARY KEY,intent TEXT NOT NULL,file TEXT,erased INTEGER NOT NULL DEFAULT 0
  )`)
  const lookup = db.prepare('SELECT intent,file,erased FROM owner_native_spills WHERE id=?')
  return {
    begin(value: NativeSpillIntent) {
      const id = randomUUID()
      db.prepare('INSERT INTO owner_native_spills VALUES (?,?,NULL,0)').run(id, JSON.stringify(intent.parse(value)))
      return id
    },
    finish(id: string, receipt: NativeSpillFile) {
      const row = lookup.get(id), encoded = JSON.stringify(file.parse(receipt))
      if (!row || row.erased || row.file !== null && row.file !== encoded) throw new Error('Native spill receipt changed identity')
      db.prepare('UPDATE owner_native_spills SET file=? WHERE id=?').run(encoded, id)
    },
    affected(calls: readonly NativeToolCall[], outputs: readonly { id: string }[]) {
      const callIds = new Set(calls.map(call => call.id)), attempts = new Set(outputs.map(attempt => attempt.id))
      return db.prepare('SELECT id,intent,file FROM owner_native_spills WHERE erased=0').all().flatMap(row => {
        const data = intent.parse(JSON.parse(String(row.intent)))
        if (!callIds.has(data.call.id) && !(data.call.outputAttempt && attempts.has(data.call.outputAttempt))) return []
        return [{ id: String(row.id), ...data, file: row.file === null ? null : file.parse(JSON.parse(String(row.file))) }]
      })
    },
    complete(id: string) {
      if (!lookup.get(id)?.file) throw new Error('Native spill has no verified file receipt')
      db.prepare('UPDATE owner_native_spills SET erased=1 WHERE id=?').run(id)
    },
  }
}
