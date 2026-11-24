import { mkdirSync, realpathSync, lstatSync, existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** SQLite's OS lock is released by process death, never by guessing a stale PID or timeout. */
export function lockMemoryRoot(input: string) {
  mkdirSync(input, { recursive: true })
  const root = realpathSync(input)
  for (const name of ['owner.lock.sqlite', 'memory.db', 'memory-files']) {
    const file = path.join(root, name)
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('Memory storage cannot be a symlink'), { code: 'denied' })
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
