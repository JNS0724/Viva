import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { dailyPath, digestPath, memoryFilePath } from '../contracts/memory-file-contract.ts'
import { parseMemoryDocument } from '../core/memory-document.ts'

export interface MemoryFileSnapshot {
  path: string
  revision: string
  markdown: string
}

export class MemoryFileError extends Error {
  code: 'path' | 'version' | 'not-file'
  constructor(code: MemoryFileError['code']) {
    super(`memory-file-${code}`)
    this.name = 'MemoryFileError'
    this.code = code
  }
}

export const memoryFileRevision = (text: string) => createHash('sha256').update(text).digest('hex')

/** Call only while holding the exclusive memory owner lock. Temporary writes may
 * survive process death between syncing the file and replacing the destination. */
export function removeAbandonedMemoryTemps(root: string) {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return
  function clean(directory: string) {
    let changed = false
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, item.name)
      if (item.isDirectory() && !item.name.startsWith('.')) clean(target)
      else if (item.isFile() && /^\.viva-memory-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/u.test(item.name)) {
        unlinkSync(target)
        changed = true
      }
    }
    if (changed) syncDirectory(directory)
  }
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory() || !/^[0-9a-f]{64}$/u.test(workspace.name)) continue
    for (const area of ['daily', 'digest', 'session']) {
      const directory = join(root, workspace.name, area)
      if (existsSync(directory) && lstatSync(directory).isDirectory()) clean(directory)
    }
  }
}

/**
 * File primitive for a single backend owner. Synchronous IO makes version-check + rename
 * indivisible to other callbacks in that owner. External editors are reconciled by R2's
 * journal; this primitive is NOT a cross-process compare-and-swap or multi-file transaction.
 * The caller binds this root to an authorized scope; a model never supplies the root.
 */
export function openMemoryFileStore(root: string, { sessions = false } = {}) {
  const created = mkdirSync(root, { recursive: true })
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

  function read(path: string): MemoryFileSnapshot | null {
    const target = locate(path)
    let markdown: string
    try { markdown = readFileSync(target, 'utf8') }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    return { path, revision: memoryFileRevision(markdown), markdown }
  }

  function write(path: string, markdown: string, expectedRevision: string | null): MemoryFileSnapshot {
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
