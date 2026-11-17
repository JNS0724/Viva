import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')

/** A cold participant acknowledges the immutable native plan after its own
 * publishers, catalog validation and durable memory checkpoint finish. */
export function createNativeErasureReceipts(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_native_cleanup_receipts (
    operation TEXT PRIMARY KEY, plan TEXT NOT NULL, catalog TEXT NOT NULL
  ) WITHOUT ROWID`)
  const plan = db.prepare('SELECT payload FROM owner_file_native_erasures WHERE operation=?')
  const received = db.prepare('SELECT plan FROM owner_native_cleanup_receipts WHERE operation=?')
  const insert = db.prepare('INSERT OR REPLACE INTO owner_native_cleanup_receipts VALUES (?,?,?)')
  return {
    complete(operation: string) {
      const current = plan.get(operation)
      return !current || received.get(operation)?.plan === fingerprint(String(current.payload))
    },
    acknowledge(operation: string, catalog: string) {
      if (!/^[a-f0-9]{64}$/u.test(catalog)) throw new Error('Native catalog receipt is invalid')
      const current = plan.get(operation)
      if (!current) throw new Error('Native erasure plan is unavailable')
      // This connection is the cold owner. No writer can change the plan or
      // reintroduce plaintext between this checkpoint and the body-free receipt.
      const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      if (result?.busy !== 0 || result.log !== result.checkpointed) throw new Error('Native cleanup awaits a durable memory checkpoint')
      insert.run(operation, fingerprint(String(current.payload)), catalog)
    },
  }
}
