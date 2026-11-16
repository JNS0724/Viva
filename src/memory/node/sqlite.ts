import type { DatabaseSync } from 'node:sqlite'

export const APP_DB_PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 2000;'

let savepoints = 0

/**
 * `work` in one transaction. Inside another (a store's write inside the event core's apply), it is a savepoint of
 * that one: a write that throws is undone on its own, and the outer one commits or rolls back the whole.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (!db.isTransaction) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  savepoints += 1
  const name = `nested_${savepoints}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = work()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw err
  }
}

/** Checkpoint after replica erasure; a live reader keeps cleanup pending rather than reporting success. */
export function truncateMemoryJournal(db: DatabaseSync): boolean {
  if (db.isTransaction || db.prepare('PRAGMA secure_delete').get()?.secure_delete !== 1) return false
  const timeout = Number(db.prepare('PRAGMA busy_timeout').get()?.timeout ?? 0)
  db.exec('PRAGMA busy_timeout=0')
  try {
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    return result?.busy === 0 && result.log === result.checkpointed
  } finally { db.exec(`PRAGMA busy_timeout=${timeout}`) }
}
