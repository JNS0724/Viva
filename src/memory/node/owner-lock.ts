import { accessSync, constants, mkdirSync, realpathSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** SQLite's OS lock is released by process death, never by guessing a stale PID or timeout. */
export function lockMemoryRoot(input: string) {
  try { mkdirSync(input, { recursive: true }) }
  catch (error) {
    // Recursive mkdir succeeds for existing directories, including directory aliases.
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw Object.assign(new Error('Memory root must be a directory', { cause: error }), { code: 'ENOTDIR' })
    }
    throw error
  }
  const root = realpathSync(input)
  // SQLite can report CANTOPEN for permission failures without forwarding the OS reason.
  accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK)
  for (const name of ['owner.lock.sqlite', 'memory.db', 'memory-files']) {
    const file = path.join(root, name)
    const entry = lstatSync(file, { throwIfNoEntry: false })
    if (!entry) continue
    if (entry.isSymbolicLink()) throw Object.assign(new Error('Memory storage cannot be a symlink'), { code: 'denied' })
    if (name === 'memory-files' ? !entry.isDirectory() : !entry.isFile()) {
      throw Object.assign(new Error(`Unexpected memory storage entry type for ${name}`), { code: 'invalid_record' })
    }
    accessSync(file, constants.R_OK | constants.W_OK | (entry.isDirectory() ? constants.X_OK : 0))
  }
  const db = new DatabaseSync(path.join(root, 'owner.lock.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE')
  } catch (error) {
    db.close()
    if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 255)) {
      throw Object.assign(new Error('Memory root already has an active owner', { cause: error }), { code: 'busy' })
    }
    throw error
  }
  let closed = false
  return { root, close() { if (!closed) { closed = true; db.exec('ROLLBACK'); db.close() } } }
}
