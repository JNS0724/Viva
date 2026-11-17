import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { SESSION_FORMAT_VERSION, Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { verifyCompleteArtifact } from './verify-native-artifact.ts'

export type NativeReplacementIntent = {
  before: string
  after: string
  events: string
}
type Journal = {
  pending(): NativeReplacementIntent | undefined
  prepare(intent: NativeReplacementIntent): void
  finish(intent: NativeReplacementIntent): void
}
type Compression = 'none' | 'zstd'
type Artifact = { file: string, compression: Compression, device: bigint, inode: bigint, bytes: string }

async function digestFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const eventDigest = (events: readonly SessionEvent[]) => createHash('sha256').update(JSON.stringify(events)).digest('hex')

function requireCold(retired: () => boolean) {
  if (!retired()) throw new Error('Native session readers must be retired for physical erasure')
}

async function artifact(root: string, snapshot: SessionPersistenceSnapshot | undefined): Promise<Artifact> {
  if (snapshot?.formatStatus !== 'current' || snapshot.location?.kind !== 'jsonl') throw new Error('Current JSONL session required')
  const file = await realpath(snapshot.location.path)
  if (file !== path.resolve(snapshot.location.path)) throw new Error('Native session location is a link')
  const relative = path.relative(await realpath(root), file)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Native session file is outside its persistence root')
  }
  const base = `session.v${SESSION_FORMAT_VERSION}.jsonl`
  const name = path.basename(file)
  const compression = name === base ? 'none' : name === base + '.zstd' ? 'zstd' : undefined
  if (!compression) throw new Error('Unsupported native session encoding')
  const generations = (await readdir(path.dirname(file))).filter(entry => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/u.test(entry))
  if (generations.length !== 1 || generations[0] !== name) throw new Error('Native session has additional generations to erase')
  const stat = await lstat(file, { bigint: true })
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Native session artifact is not a private file')
  const bytes = await digestFile(file)
  const after = await lstat(file, { bigint: true })
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
    throw new Error('Native session artifact changed during verification')
  }
  return { file, compression, device: stat.dev, inode: stat.ino, bytes }
}

async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function publish(staging: string, target: string) {
  if (process.platform === 'win32') {
    // The pinned provider already uses Koffi for its Windows writer lease.
    const { default: koffi } = await import('koffi')
    const kernel = koffi.load('kernel32.dll')
    const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as
      (from: string, to: string, flags: number) => number
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint', []) as () => number
    const REPLACE_EXISTING = 0x00000001, WRITE_THROUGH = 0x00000008
    if (!move(path.toNamespacedPath(staging), path.toNamespacedPath(target), REPLACE_EXISTING | WRITE_THROUGH)) {
      throw new Error('Durable native session replacement failed on Windows (' + lastError() + ')')
    }
  } else {
    await rename(staging, target)
    await syncDirectory(path.dirname(target))
  }
}

async function stageCopy(source: string, temporary: string, expected: string) {
  await copyFile(source, temporary, constants.COPYFILE_EXCL)
  const handle = await open(temporary, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  if (await digestFile(temporary) !== expected) throw new Error('Native staging copy changed')
}

/** A cold writer for the pinned provider. The caller closes every reader and
 * excludes reopening for the duration. The lease is never used to append. */
export async function rewriteColdNativeSession({ root, sessionId, operationId, compression, retired, journal, transform }: {
  root: string
  sessionId: SessionId
  operationId: string
  compression: Compression
  retired(): boolean
  journal: Journal
  transform(events: readonly SessionEvent[]): readonly SessionEvent[]
}): Promise<void> {
  requireCold(retired)
  if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('Invalid native rewrite operation')
  root = await realpath(root)
  const maintenance = new Context()
  const mounted = await maintenance.plugin(jsonl, { root, compression })
  try {
    const persistence = maintenance.sessionPersistence
    const observed = await artifact(root, await persistence.stat(sessionId))
    if (observed.compression !== compression) throw new Error('Native session encoding changed')
    const lease = await persistence.open(sessionId, 'write')
    try {
      const before = await artifact(root, await persistence.stat(sessionId))
      if (observed.file !== before.file || observed.device !== before.device || observed.inode !== before.inode || observed.bytes !== before.bytes) {
        throw new Error('Native session changed before its writer lease was acquired')
      }
      const old = (await lease.read()).events
      await verifyCompleteArtifact(before.file, before.bytes, compression === 'zstd', old.length)
      const previous = journal.pending()
      const directory = path.dirname(before.file)
      const scratch = path.join(directory, '.viva-native-stage-' + operationId)
      const temporary = scratch + '.tmp'
      async function cleanStage() {
        await rm(temporary, { force: true })
        await rm(scratch, { force: true, recursive: true })
        await syncDirectory(directory)
      }
      await cleanStage()
      if (previous?.after === before.bytes) {
        if (eventDigest(old) !== previous.events) throw new Error('Published native erasure receipt does not match its events')
        requireCold(retired)
        if (process.platform === 'win32') {
          // A process can die after the updated name is visible but before
          // MoveFileExW returns its write-through acknowledgement.
          try {
            await stageCopy(before.file, temporary, previous.after)
            await publish(temporary, before.file)
          } finally { await cleanStage() }
          if (await digestFile(before.file) !== previous.after) throw new Error('Published native erasure bytes changed')
        }
        journal.finish(previous)
        return
      }
      if (previous && previous.before !== before.bytes) throw new Error('Interrupted native erasure no longer owns the source log')
      const next = transform(old)
      if (next.length !== old.length || next.some((event, index) => event.type !== old[index]?.type || event.seq !== old[index]?.seq)) {
        throw new Error('Native erasure cannot change event identities or numbering')
      }
      if (isDeepStrictEqual(old, next)) throw new Error('Native erasure did not change the authorized log')
      const checked = Session.fromRestore(sessionId, next, lease.header, lease.inheritedEventCount, 'detached', [imageOffloadProjection])
      if (!isDeepStrictEqual(checked.snapshotEvents(SessionLogOffset(0), SessionLogOffset(next.length)), next)) throw new Error('Redacted native checkpoint did not preserve its event prefix')
      await mkdir(scratch, { mode: 0o700 })
      let published: NativeReplacementIntent | undefined
      try {
        const staging = new Context()
        const output = await staging.plugin(jsonl, { root: scratch, compression })
        let staged: Artifact
        try {
          const store = staging.sessionPersistence
          const writer = await store.create(lease.header, { inheritedEventCount: lease.inheritedEventCount })
          try {
            await writer.append(next)
            await writer.flush()
          } finally { await writer.close() }
          const verify = await store.open(sessionId, 'read')
          try {
            if (!isDeepStrictEqual(verify.header, lease.header) || verify.inheritedEventCount !== lease.inheritedEventCount
              || !isDeepStrictEqual((await verify.read()).events, next)) throw new Error('The staged native log did not verify')
          } finally { await verify.close() }
          staged = await artifact(scratch, await store.stat(sessionId))
          await verifyCompleteArtifact(staged.file, staged.bytes, compression === 'zstd', next.length)
        } finally { await output.dispose() }
        await stageCopy(staged.file, temporary, staged.bytes)
        const intent = { before: before.bytes, after: staged.bytes, events: eventDigest(next) }
        if (previous && !isDeepStrictEqual(previous, intent)) throw new Error('Retried native erasure did not reproduce the staged artifact')
        if (!previous) journal.prepare(intent)
        const current = await artifact(root, await persistence.stat(sessionId))
        if (!isDeepStrictEqual(before, current)) throw new Error('Native session changed before publication')
        requireCold(retired)
        await publish(temporary, before.file)
        if (await digestFile(before.file) !== intent.after) throw new Error('Native publication did not match its receipt')
        published = intent
      } finally { await cleanStage() }
      if (published) journal.finish(published)
    } finally { await lease.close() }
  } finally { await mounted.dispose() }
}
