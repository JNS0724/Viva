import { DatabaseSync } from 'node:sqlite'
import { SQLITE_BUSY_TIMEOUT_MS } from '../../src/memory/node/sqlite.ts'

/** A second control connection to the live owner's database, not another owner. */
export function openMemoryControlDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  try {
    // Keep the owner's journal/durability settings; only share its finite busy policy.
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    return db
  } catch (error) { db.close(); throw error }
}
