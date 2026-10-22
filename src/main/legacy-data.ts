import fs from 'node:fs'
import path from 'node:path'

/**
 * The app was called my-agent before it was Viva, and Electron keeps each app's data under its name. On the
 * first launch as Viva the conversations, memories and trace come along: copied, never moved, so the old
 * folder stays as it was. The saved API key cannot come: the OS keychain entry that encrypts it is per app
 * name, so it has to be entered again (or come from DEEPSEEK_API_KEY).
 */
export const LEGACY_NAME = 'my-agent'
const DATA_FILES = Object.freeze(['history.db', 'memory.db', 'trace.db'])
/** SQLite's write-ahead log and index travel with the database, or recent writes are lost. */
const SQLITE_SIDECARS = Object.freeze(['', '-wal', '-shm'])

/** @returns the databases copied (none when there was nothing to bring or it is here already) */
export function adoptLegacyData({ userData, legacyDir }: { userData: string, legacyDir: string }): string[] {
  if (path.resolve(userData) === path.resolve(legacyDir) || !fs.existsSync(legacyDir)) return []
  fs.mkdirSync(userData, { recursive: true })
  return DATA_FILES.filter((name) => fs.existsSync(path.join(legacyDir, name)) && !fs.existsSync(path.join(userData, name)))
    .map((name) => {
      for (const suffix of SQLITE_SIDECARS) {
        const from = path.join(legacyDir, name + suffix)
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(userData, name + suffix), fs.constants.COPYFILE_EXCL)
      }
      return name
    })
}
