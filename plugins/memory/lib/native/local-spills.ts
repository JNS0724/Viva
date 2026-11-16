import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { sessionDir } from '@deepseek-ai/dsh-spill-local'
import type { NativeSpillFile, NativeSpillIntent } from '../../../../src/memory/node/native-spills.ts'

const absent = (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function assertNativeSpillDirectory(file: string) {
  const stat = await lstat(file, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32'
    && (stat.mode & 0o022n || process.getuid && stat.uid !== BigInt(process.getuid()))) throw new Error('Native spill directory is not private')
}
const directory = assertNativeSpillDirectory

async function syncDirectory(file: string) {
  // Windows cannot open directories as file handles; local file removal is synchronous there.
  if (process.platform === 'win32') return
  const handle = await open(file, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

/** The receipt is for the actual local store's exact file, not another same-text artifact. */
export async function verifyNativeSpill(intent: NativeSpillIntent, locator: string, durable = true): Promise<NativeSpillFile> {
  const parent = sessionDir(intent.root, intent.call.session)
  await directory(intent.root)
  await directory(parent)
  if (await realpath(path.dirname(locator)) !== parent || path.basename(locator) === '.' || path.basename(locator) === '..') {
    throw new Error('Native spill locator escaped its session')
  }
  const file = path.join(parent, path.basename(locator))
  const handle = await open(file, (durable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat({ bigint: true }), bytes = await handle.readFile()
    if (!stat.isFile() || stat.nlink !== 1n || bytes.byteLength !== intent.bytes || hash(bytes) !== intent.hash) throw new Error('Native spill bytes differ from its receipt')
    if (durable) { await handle.sync(); await syncDirectory(parent) }
    return { path: file, dev: stat.dev.toString(), ino: stat.ino.toString() }
  } finally { await handle.close() }
}

/** Missing or changed evidence remains pending; cold maintenance never guesses a spill file. */
export async function eraseNativeSpill(target: NativeSpillIntent & { file: NativeSpillFile | null }, isCold: () => boolean) {
  if (target.publication) return eraseGovernedNativeSpill(target, isCold)
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
      const stat = await handle.stat({ bigint: true }), bytes = await handle.readFile(), current = await lstat(file, { bigint: true })
      if (!stat.isFile() || stat.nlink !== 1n || stat.dev.toString() !== target.file.dev || stat.ino.toString() !== target.file.ino
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

/** A preallocated empty staging inode is archived before any private byte is written.
 * Atomic publication can therefore recover even before the final locator receipt. */
async function eraseGovernedNativeSpill(target: NativeSpillIntent, isCold: () => boolean) {
  const proof = target.publication!
  const parent = sessionDir(target.root, target.call.session)
  if (path.dirname(proof.target) !== parent || path.dirname(proof.stage.path) !== parent
    || !path.basename(proof.target).startsWith(`viva-${proof.nonce}-`)
    || path.basename(proof.stage.path) !== `.viva-${proof.nonce}.tmp`) return false
  if (!isCold()) throw new Error('Native spill erasure requires a cold lifecycle')
  try {
    await directory(target.root)
    await directory(parent)
  } catch (error) { if (absent(error)) return isCold(); throw error }
  if (await realpath(target.root) !== target.root || await realpath(parent) !== parent) return false
  const files: { path: string, links: bigint }[] = []
  for (const file of [proof.target, proof.stage.path]) {
    let handle
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) { if (absent(error)) continue; throw error }
    try {
      const stat = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true })
      if (!stat.isFile() || stat.dev.toString() !== proof.stage.dev || stat.ino.toString() !== proof.stage.ino
        || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || stat.nlink > 2n) return false
      // Only staging may be incomplete; it was never returned to a caller.
      if (file === proof.target) {
        const bytes = await handle.readFile()
        if (bytes.byteLength !== target.bytes || hash(bytes) !== target.hash) return false
      }
      files.push({ path: file, links: stat.nlink })
    } finally { await handle.close() }
  }
  if (files.some(file => file.links !== BigInt(files.length))) return false
  if (!isCold()) throw new Error('Native spill lifecycle changed during erasure')
  for (const file of files) await unlink(file.path)
  await syncDirectory(parent)
  return isCold()
}
