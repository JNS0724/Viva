import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { openMemoryOwner } from '../../../../src/memory/node/owner.ts'
import type { NativeToolReadScope } from '../../../../src/memory/node/native-tool-reads.ts'
import { verifyNativeSpill } from './local-spills.ts'
import { replaceServiceMethod } from './service-method.ts'

type Owner = ReturnType<typeof openMemoryOwner>
type SpillReadLease = { current(): boolean, revalidate?(): Promise<boolean> }
type SpillReader = {
  nativeSpillCandidates(): ReturnType<Owner['nativeSpillCandidates']> | Promise<ReturnType<Owner['nativeSpillCandidates']>>,
  admitNativeSpillRead(id: string, scope: NativeToolReadScope, signal?: AbortSignal): SpillReadLease | Promise<SpillReadLease>,
}

/** Guard the filesystem service seam, including grep/stream consumers and path aliases. */
export function trackNativeSpillReads(ctx: Context, owner: SpillReader, scope: () => NativeToolReadScope | undefined) {
  return ctx.inject(['fs'], scoped => {
    const fs = scoped.fs, read = fs.readText, stream = fs.streamText
    let active = true
    async function admit(target: FsTarget, signal?: AbortSignal) {
      const actual = fs.processPath(target)
      for (const candidate of await owner.nativeSpillCandidates()) {
        const locations = [candidate.file, candidate.publication ? { ...candidate.publication.stage, path: candidate.publication.target } : null,
          candidate.publication?.stage].filter(item => item != null)
        const file = locations.find(file => fs.processPathFromHostPath(file.path) === actual)
        if (!file) continue
        const stat = await lstat(file.path, { bigint: true })
        // A different file at an old locator is independent, even with identical prose.
        if (stat.dev.toString() !== file.dev || stat.ino.toString() !== file.ino) continue
        signal?.throwIfAborted()
        if (!candidate.file || candidate.file.path !== file.path) throw new Error('Native spill publication is unfinished')
        await verifyNativeSpill(candidate, file.path, false)
        if (!active) throw new Error('Native spill guard retired during reading')
        const execution = scope()
        if (!execution) throw new Error('Native spill read has no authenticated execution')
        const lease = await owner.admitNativeSpillRead(candidate.id, execution, signal)
        return { current: () => active && lease.current(),
          validate: async () => active && lease.current() && (!lease.revalidate || await lease.revalidate()) && active && lease.current(),
          hash: candidate.hash, bytes: candidate.bytes }
      }
    }
    const guardedRead: typeof read = async (target, signal) => {
      if (!active) return read.call(fs, target, signal)
      const permit = await admit(target, signal), value = await read.call(fs, target, signal)
      signal?.throwIfAborted()
      if (permit && (!await permit.validate() || Buffer.byteLength(value, 'utf8') !== permit.bytes
        || createHash('sha256').update(value).digest('hex') !== permit.hash)) throw new Error('Native spill changed during reading')
      return value
    }
    const guardedStream: typeof stream = async (target, signal) => {
      if (!active) return stream.call(fs, target, signal)
      const permit = await admit(target, signal), chunks = await stream.call(fs, target, signal)
      if (!permit) return chunks
      // read/grep may close a stream after its first matching lines. Validate
      // the entire bounded artifact before offering any chunk to that consumer.
      const hash = createHash('sha256'), snapshot: string[] = []; let bytes = 0
      for await (const chunk of chunks) {
        signal?.throwIfAborted()
        if (!permit.current()) throw new Error('Native spill source changed during reading')
        hash.update(chunk); bytes += Buffer.byteLength(chunk, 'utf8')
        if (bytes > permit.bytes) throw new Error('Native spill grew during reading')
        snapshot.push(chunk)
      }
      signal?.throwIfAborted()
      if (!await permit.validate() || bytes !== permit.bytes || hash.digest('hex') !== permit.hash) throw new Error('Native spill changed during reading')
      return (async function* () {
        for (const chunk of snapshot) {
          signal?.throwIfAborted()
          if (!await permit.validate()) throw new Error('Native spill source changed before its snapshot was consumed')
          yield chunk
        }
      })()
    }
    const restoreRead = replaceServiceMethod(fs, 'readText', guardedRead)
    const restoreStream = replaceServiceMethod(fs, 'streamText', guardedStream)
    scoped.effect(() => () => {
      active = false
      restoreStream(); restoreRead()
    }, 'memory spill read provenance')
  })
}
