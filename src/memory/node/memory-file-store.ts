import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { dailyPath, digestPath, memoryFilePath } from '../contracts/memory-file-contract.ts'
import { parseMemoryDocument } from '../core/memory-document.ts'
import { createRequestBudget, RequestTimeout } from '../../shared/request-budget.ts'
import type { MemoryPhysicalFile, ReadMemoryPhysicalFile } from '../core/ports/documents.ts'

export class MemoryFileError extends Error {
  code: 'path' | 'version' | 'not-file'
  constructor(code: MemoryFileError['code']) {
    super(`memory-file-${code}`)
    this.name = 'MemoryFileError'
    this.code = code
  }
}

export const memoryFileRevision = (text: string) => createHash('sha256').update(text).digest('hex')

const MAX_PHYSICAL_FILE_BYTES = 4 * 1024 * 1024
// Windows NTFS metadata + open/read chains on loaded runners routinely exceed 250 ms; stay well below fileVerificationBudgetMs (2500 ms).
const PHYSICAL_FILE_TIMEOUT_MS = process.platform === 'win32' ? 1_200 : 250
const PHYSICAL_FILE_CONCURRENCY = 3

/** Native I/O can outlive its caller. Hold the slot until the operation actually ends,
 * so multiple timeouts cannot fill the owner's filesystem thread pool. */
export function createMemoryPhysicalFileReader(root: () => string) {
  const active = new Map<string, { signal: AbortSignal, result: Promise<MemoryPhysicalFile | null> }>()
  const available = new Set<() => void>()
  const lifetime = new AbortController()
  async function inspect(workspace: string, path: string, signal: AbortSignal): Promise<MemoryPhysicalFile | null> {
    const directory = resolve(root())
    const parts = [workspace, ...path.split('/')]
    const target = join(directory, ...parts)
    async function safeStat() {
      let cursor = directory
      let info = await lstat(cursor)
      for (const part of parts) {
        signal.throwIfAborted()
        if (!info.isDirectory() || info.isSymbolicLink()) throw new MemoryFileError('path')
        cursor = join(cursor, part)
        info = await lstat(cursor)
      }
      signal.throwIfAborted()
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PHYSICAL_FILE_BYTES) throw new MemoryFileError('not-file')
      return info
    }
    const expected = await safeStat()
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      signal.throwIfAborted()
      const stat = await handle.stat()
      signal.throwIfAborted()
      if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > MAX_PHYSICAL_FILE_BYTES) throw new MemoryFileError('version')
      const bytes = Buffer.allocUnsafe(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        signal.throwIfAborted()
        if (!bytesRead) break
        offset += bytesRead
      }
      const after = await safeStat()
      if (offset !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
        || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new MemoryFileError('version')
      const markdown = bytes.subarray(0, offset).toString('utf8')
      return { path, revision: memoryFileRevision(markdown), markdown }
    } finally { await handle.close() }
  }

  const read: ReadMemoryPhysicalFile = async (workspace, path, signal) => {
    lifetime.signal.throwIfAborted()
    if (!/^[a-f0-9]{64}$/u.test(workspace)
      || !memoryFilePath.safeParse(path).success
      || !(dailyPath.safeParse(path).success || digestPath.safeParse(path).success)) throw new MemoryFileError('path')
    const key = JSON.stringify([workspace, path])
    const caller = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const budget = createRequestBudget(PHYSICAL_FILE_TIMEOUT_MS, caller)
    try {
      while (!active.has(key) && active.size >= PHYSICAL_FILE_CONCURRENCY) {
        let wake: () => void = () => {}
        const waiting = new Promise<void>(resolve => { wake = resolve; available.add(wake) })
        try { await budget.run(() => waiting) } finally { available.delete(wake) }
      }
      budget.remainingMs()
      let operation = active.get(key)
      if (!operation) {
        // Coalesced I/O has its own deadline. One cancelled lookup must not
        // cancel verification for another caller still waiting on this path.
        const nativeSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(PHYSICAL_FILE_TIMEOUT_MS)])
        const result = inspect(workspace, path, nativeSignal).catch(error => {
          if (nativeSignal.aborted) throw new RequestTimeout()
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }).finally(() => {
          active.delete(key)
          for (const wake of available) wake()
        })
        // An expiring budget can reject before it starts observing the native operation.
        void result.catch(() => {})
        operation = { signal: nativeSignal, result }
        active.set(key, operation)
      }
      if (operation.signal.aborted) throw new RequestTimeout()
      const timeout = () => budget.cancel(new RequestTimeout())
      operation.signal.addEventListener('abort', timeout, { once: true })
      try { return await budget.run(() => operation.result) }
      finally { operation.signal.removeEventListener('abort', timeout) }
    } finally { budget.close() }
  }
  return Object.assign(read, { close: () => lifetime.abort(new Error('Memory file reader closed')) })
}

const ABANDONED_TEMP = /^\.viva-memory-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u

/** Best-effort cleanup under the owner lock. A write renames or discards its unique
 * temporary file in one synchronous turn, before cleanup can act on the listing. */
export async function removeAbandonedMemoryTemps(root: string, signal: AbortSignal) {
  async function entries(directory: string) {
    if (signal.aborted) return []
    try {
      const status = await lstat(directory)
      if (signal.aborted || !status.isDirectory()) return []
      const physical = await realpath(directory)
      if (signal.aborted || physical !== directory) return []
      return await readdir(directory, { withFileTypes: true })
    } catch { return [] }
  }

  async function clean(directory: string) {
    let changed = false
    for (const item of await entries(directory)) {
      if (signal.aborted) return
      const target = join(directory, item.name)
      if (item.isDirectory() && !item.name.startsWith('.')) {
        await clean(target)
      } else if (item.isFile() && ABANDONED_TEMP.test(item.name)) {
        try {
          // Recheck after enumeration, including ancestor symlinks and junctions.
          const status = await lstat(target)
          if (signal.aborted || !status.isFile()) continue
          const physical = await realpath(target)
          if (signal.aborted || physical !== target) continue
          await unlink(target)
          changed = true
        } catch { /* An unreadable or disappearing file can wait for another startup. */ }
      }
    }
    if (!changed || signal.aborted || process.platform === 'win32') return
    try {
      if (await realpath(directory) !== directory || signal.aborted) return
      const handle = await open(directory, 'r')
      try { if (!signal.aborted) await handle.sync() } finally { await handle.close() }
    } catch { /* An interrupted sync may leave the temp for a later retry. */ }
  }

  // Windows TEMP can use an 8.3 alias. Canonicalize the trusted root once so
  // descendant comparisons use the same spelling as fs.promises.realpath.
  const supplied = resolve(root)
  let location = supplied
  if (process.platform === 'win32') {
    try {
      for (let cursor = supplied; ; cursor = dirname(cursor)) {
        if (signal.aborted || (await lstat(cursor)).isSymbolicLink()) return
        if (dirname(cursor) === cursor) break
      }
      location = await realpath(supplied)
    } catch { return }
  }
  for (const workspace of await entries(location)) {
    if (signal.aborted) return
    if (!workspace.isDirectory() || !/^[0-9a-f]{64}$/u.test(workspace.name)) continue
    for (const area of ['daily', 'digest', 'session']) await clean(join(location, workspace.name, area))
  }
}

/** Synchronous compatibility check at the commit boundary for trusted write paths. */
export function readMemoryFileAtCommit(root: string, workspace: string, path: string): MemoryPhysicalFile | null {
  if (!/^[a-f0-9]{64}$/u.test(workspace)) throw new MemoryFileError('path')
  const directory = join(root, workspace)
  try {
    if (lstatSync(root).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) throw new MemoryFileError('path')
    return openMemoryFileStore(directory, { create: false }).read(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * File primitive for a single backend owner. Synchronous IO makes version-check + rename
 * indivisible to other callbacks in that owner. The expected revision guards each write.
 * The caller binds this root to an authorized scope; a model never supplies the root.
 */
export function openMemoryFileStore(root: string, { sessions = false, create = true } = {}) {
  const created = create ? mkdirSync(root, { recursive: true }) : undefined
  if (created && process.platform !== 'win32') {
    let current = resolve(root)
    const first = resolve(created)
    while (current !== first) { syncDirectory(current); current = dirname(current) }
    syncDirectory(first)
    syncDirectory(dirname(first))
  }
  const directory = realpathSync(resolve(root))

  function locate(path: string, createParents = false): string {
    if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) throw new MemoryFileError('path')
    if (!memoryFilePath.safeParse(path).success ||
      !(dailyPath.safeParse(path).success || digestPath.safeParse(path).success ||
        sessions && /^session\/dialog\/[a-f0-9]{64}\.jsonl$/u.test(path))) throw new MemoryFileError('path')
    // Check each existing component before following it. Reject dangling symlinks too.
    let current = directory
    const parts = path.split('/')
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!)
      let info: ReturnType<typeof lstatSync>
      try { info = lstatSync(current) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        if (createParents && i < parts.length - 1) {
          mkdirSync(current)
          syncDirectory(dirname(current))
        }
        continue
      }
      if (info.isSymbolicLink()) throw new MemoryFileError('path')
      if (i < parts.length - 1 && !info.isDirectory()) throw new MemoryFileError('path')
      if (i === parts.length - 1 && !info.isFile()) throw new MemoryFileError('not-file')
    }
    return current
  }

  function read(path: string): MemoryPhysicalFile | null {
    const target = locate(path)
    let markdown: string
    try { markdown = readFileSync(target, 'utf8') }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    return { path, revision: memoryFileRevision(markdown), markdown }
  }

  function write(path: string, markdown: string, expectedRevision: string | null): MemoryPhysicalFile {
    // Validate before creating directories or a temporary file.
    if (!path.endsWith('.jsonl')) parseMemoryDocument(markdown)
    const previous = read(path)
    if ((previous?.revision ?? null) !== expectedRevision) throw new MemoryFileError('version')
    if (previous?.markdown === markdown) return previous
    const target = locate(path, true)
    const temporary = join(dirname(target), `.viva-memory-${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, markdown, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, target)
      syncDirectory(dirname(target))
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
    return { path, revision: memoryFileRevision(markdown), markdown }
  }

  function remove(path: string, expectedRevision: string) {
    const previous = read(path)
    if (previous?.revision !== expectedRevision) throw new MemoryFileError('version')
    const target = locate(path)
    unlinkSync(target)
    syncDirectory(dirname(target))
  }

  function list(): string[] {
    const result: string[] = []
    function visit(relative: string) {
      const location = join(directory, relative)
      if (!existsSync(location)) return
      if (lstatSync(location).isSymbolicLink()) throw new MemoryFileError('path')
      for (const item of readdirSync(location, { withFileTypes: true })) {
        if (item.isSymbolicLink() || item.name.startsWith('.')) continue
        const path = relative ? `${relative}/${item.name}` : item.name
        if (item.isDirectory()) visit(path)
        else if (dailyPath.safeParse(path).success || digestPath.safeParse(path).success) result.push(path)
      }
    }
    for (const part of ['daily', 'digest']) visit(part)
    return result.sort()
  }
  return { read, write, remove, list }
}

/** Windows does not support opening directories for fsync. File handles are synced on both platforms. */
function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const fd = openSync(directory, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
