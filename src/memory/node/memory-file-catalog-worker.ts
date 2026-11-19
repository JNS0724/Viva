import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dailyPath, digestPath } from '../contracts/memory-file-contract.ts'
import type { MemoryCatalogChange, MemoryCatalogObservation } from '../core/ports/file-index.ts'
import { memoryFileRevision, createMemoryPhysicalFileReader } from './memory-file-store.ts'

export interface CatalogScan {
  complete?: boolean
  files: MemoryCatalogObservation[]
  quarantined: Array<Extract<MemoryCatalogChange, { kind: 'quarantined' }>>
}

const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024

async function inspect(root: string, workspace: string, send: NonNullable<typeof process.send>) {
  const pending: CatalogScan = { files: [], quarantined: [] }
  const flush = (last?: boolean) => {
    if (last === undefined && pending.files.length === 0 && pending.quarantined.length === 0) return
    const batch = { files: pending.files.splice(0), quarantined: pending.quarantined.splice(0), complete: last }
    send(batch, error => {
      if (error || last !== undefined) process.exit(error ? 1 : 0)
    })
  }
  const progress = () => {
    if (pending.files.length + pending.quarantined.length >= 128) flush()
  }
  const workspaceRoot = join(root, workspace)
  const quarantine = (path: string, reason: CatalogScan['quarantined'][number]['reason']) => {
    pending.quarantined.push({ kind: 'quarantined', path, reason })
    progress()
  }
  async function safeStat(path: string) {
    let stat = await lstat(root)
    if (stat.isSymbolicLink()) throw new Error('symlink')
    let cursor = root
    for (const part of [workspace, ...path.split('/').filter(Boolean)]) {
      if (!stat.isDirectory()) throw new Error('invalid-path')
      cursor = join(cursor, part)
      stat = await lstat(cursor)
      if (stat.isSymbolicLink()) throw new Error('symlink')
    }
    return stat
  }
  function quarantineError(path: string, error: unknown) {
    const reason = error instanceof Error ? error.message : ''
    quarantine(path, reason === 'symlink' || reason === 'invalid-path' ? reason : 'unreadable')
  }
  async function inspectFile(path: string) {
    try {
      const expected = await safeStat(path)
      if (!expected.isFile() || expected.size > MAX_SCAN_FILE_BYTES) throw new Error('invalid-path')
      const handle = await open(join(workspaceRoot, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > MAX_SCAN_FILE_BYTES) throw new Error('invalid-path')
        const bytes = Buffer.allocUnsafe(stat.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        const after = await safeStat(path)
        if (offset !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
          || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('file-changed')
        pending.files.push({ path, revision: memoryFileRevision(bytes.subarray(0, offset).toString('utf8')) })
        progress()
      } finally { await handle.close() }
    } catch (error) { quarantineError(path, error) }
  }
  async function walk(relative: string) {
    let entered = false
    try {
      if (!(await safeStat(relative)).isDirectory()) { quarantine(relative, 'invalid-path'); return }
      entered = true
      for (const entry of await readdir(join(workspaceRoot, relative), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || /(?:\.tmp|\.bak|~)$/u.test(entry.name)) continue
        const path = `${relative}/${entry.name}`
        if (entry.isSymbolicLink()) { quarantine(path, 'symlink'); continue }
        if (entry.isDirectory()) { await walk(path); continue }
        if (!entry.name.endsWith('.md')) continue
        const schema = path.startsWith('daily/') ? dailyPath : digestPath
        if (!entry.isFile() || !schema.safeParse(path).success) { quarantine(path, 'invalid-path'); continue }
        await inspectFile(path)
      }
    } catch (error) {
      if (entered || (error as NodeJS.ErrnoException).code !== 'ENOENT') quarantineError(relative, error)
    }
  }

  // Small periodic batches preserve already completed observations if a later read hangs.
  const timer = setInterval(flush, 100)
  try { await Promise.all([walk('daily'), walk('digest')]) }
  finally { clearInterval(timer) }
  flush(true)
}

// This entry has no owner, database, or write capability. Losing its parent ends the scan.
process.once('disconnect', () => process.exit(0))
const [root, workspace, path] = process.argv.slice(2)
if (root && workspace && /^[a-f0-9]{64}$/u.test(workspace) && process.send) {
  const send = process.send.bind(process)
  if (path) {
    const read = createMemoryPhysicalFileReader(() => root)
    try {
      const file = await read(workspace, path)
      send(file ?? { missing: true }, error => process.exit(error ? 1 : 0))
    } catch { send({ unavailable: true }, error => process.exit(error ? 1 : 0)) }
  } else await inspect(root, workspace, send)
}
