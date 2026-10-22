import fs from 'node:fs'
import path from 'node:path'

/** Windows refuses to remove a file that another process still has open for a moment after it lets go. */
const RETRIES = Object.freeze({ maxRetries: 10, retryDelay: 100 })

/**
 * Removes a directory tree without following links out of it. A dsh profile links each plugin into its
 * node_modules (a junction on Windows), and `fs.rmSync(dir, { recursive: true })` on Windows walks into a
 * junction and deletes what it points at: the app's own plugin sources. So every link is unlinked first,
 * then what is left holds only the tree's own files. Files made read-only (dsh keeps the pictures it stored
 * so, image-store.js) are made writable on the way: Windows will not remove a read-only file.
 */
export function removeTree(dir: string): void {
  unlinkLinks(dir)
  fs.rmSync(dir, { recursive: true, force: true, ...RETRIES })
}

const OWNER_WRITE = 0o200

function unlinkLinks(dir: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return
    throw err
  }
  for (const name of names) {
    const full = path.join(dir, name)
    // lstat, not the directory entry's type: it is what reports a Windows junction as a link.
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) fs.unlinkSync(full)
    else if (stat.isDirectory()) unlinkLinks(full)
    else if (!(stat.mode & OWNER_WRITE)) fs.chmodSync(full, stat.mode | OWNER_WRITE)
  }
}
