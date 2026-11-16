import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { sessionDir } from '@deepseek-ai/dsh-spill-local'
import type { NativeSpillFile, NativeSpillIntent } from '../../../../src/memory/node/native-spills.ts'

const absent = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function directory(file: string) {
  const stat = await lstat(file)
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
    && (stat.mode & 0o022 || process.getuid && stat.uid !== process.getuid())) throw new Error('Native spill directory is not private')
}

async function syncDirectory(file: string) {
  // Windows cannot open directories as file handles; local file removal is synchronous there.
  if (process.platform === 'win32') return
  const handle = await open(file, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

/** The receipt is for the actual local store's exact file, not another same-text artifact. */
export async function verifyNativeSpill(intent: NativeSpillIntent, locator: string): Promise<NativeSpillFile> {
  const parent = sessionDir(intent.root, intent.call.session)
  await directory(intent.root)
  await directory(parent)
  if (await realpath(path.dirname(locator)) !== parent || path.basename(locator) === '.' || path.basename(locator) === '..') {
    throw new Error('Native spill locator escaped its session')
  }
  const file = path.join(parent, path.basename(locator))
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat(), bytes = await handle.readFile()
    if (!stat.isFile() || stat.nlink !== 1 || bytes.byteLength !== intent.bytes || hash(bytes) !== intent.hash) throw new Error('Native spill bytes differ from its receipt')
    await handle.sync()
    await syncDirectory(parent)
    return { path: file, dev: stat.dev, ino: stat.ino }
  } finally { await handle.close() }
}

/** Missing or changed evidence remains pending; cold maintenance never guesses a spill file. */
export async function eraseNativeSpill(target: NativeSpillIntent & { file: NativeSpillFile | null }, isCold: () => boolean) {
  if (!target.file) return false
  if (!isCold()) throw new Error('Native spill erasure requires a cold lifecycle')
  const parent = sessionDir(target.root, target.call.session), file = target.file.path
  if (path.dirname(file) !== parent || path.resolve(file) !== file) return false
  try {
    await directory(target.root)
    await directory(parent)
    if (await realpath(target.root) !== target.root || await realpath(parent) !== parent) return false
    let handle
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (!absent(error)) throw error
      await syncDirectory(parent)
      return isCold()
    }
    try {
      const stat = await handle.stat(), bytes = await handle.readFile(), current = await lstat(file)
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== target.file.dev || stat.ino !== target.file.ino
        || current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink()
        || bytes.byteLength !== target.bytes || hash(bytes) !== target.hash) return false
      if (!isCold()) throw new Error('Native spill lifecycle changed during erasure')
      await unlink(file)
      await syncDirectory(parent)
      return isCold()
    } finally { await handle.close() }
  } catch (error) {
    // The complete receipt's root or session directory no longer exists.
    if (absent(error)) return isCold()
    throw error
  }
}
