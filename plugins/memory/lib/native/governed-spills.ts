import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { encodeSegment, sessionDir } from '@deepseek-ai/dsh-spill-local'
import { SpillLocator } from '@deepseek-ai/dsh-spill'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { NativeSpillIntent } from '../../../../src/memory/node/native-spills.ts'
import { assertNativeSpillDirectory, verifyNativeSpill } from './local-spills.ts'

export async function reserveNativeSpill(intent: NativeSpillIntent, name: string) {
  const nonce = randomUUID(), parent = sessionDir(intent.root, intent.call.session)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await assertNativeSpillDirectory(intent.root)
  await assertNativeSpillDirectory(parent)
  if (await realpath(intent.root) !== intent.root || await realpath(parent) !== parent) throw new Error('Native spill directory identity changed')
  const stagePath = path.join(parent, `.viva-${nonce}.tmp`)
  const handle = await open(stagePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await handle.stat({ bigint: true })
    return { handle, intent: { ...intent, publication: { nonce,
      stage: { path: stagePath, dev: stat.dev.toString(), ino: stat.ino.toString() },
      target: path.join(parent, `viva-${nonce}-${encodeSegment(name).slice(0, 120)}`) } } }
  } catch (error) { await handle.close(); throw error }
}

/** The intent must commit before this function writes content. */
export async function publishGovernedNativeSpill(handle: FileHandle, intent: NativeSpillIntent, content: string, current: () => boolean) {
  const proof = intent.publication!
  try {
    if (!current()) throw new Error('Native spill execution changed before writing')
    await handle.writeFile(content)
    await handle.sync()
    if (!current()) throw new Error('Native spill execution changed before publishing')
    const stage = await lstat(proof.stage.path, { bigint: true })
    if (!stage.isFile() || stage.dev.toString() !== proof.stage.dev || stage.ino.toString() !== proof.stage.ino || stage.nlink !== 1n) {
      throw new Error('Native spill staging identity changed before publishing')
    }
    // An exclusive link publishes complete bytes atomically without replacing a
    // preexisting file; both locations retain the intent's exact staging inode.
    await link(proof.stage.path, proof.target)
    await unlink(proof.stage.path)
    const receipt = await verifyNativeSpill(intent, proof.target)
    if (!current()) throw new Error('Native spill execution changed before its locator was returned')
    const ref: SpillRef = { locator: SpillLocator(proof.target), bytes: intent.bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.' }
    return { receipt, ref }
  } finally { await handle.close() }
}
