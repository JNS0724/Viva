import { memoryWorkerEnvironment } from './memory-worker-environment.ts'
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MemoryFileCatalog, MemoryCatalogChange, MemoryFileIdentity } from '../core/ports/file-index.ts'
import type { CatalogScan } from './memory-file-catalog-worker.ts'
import { createMemoryPhysicalFileReader, openMemoryFileStore } from './memory-file-store.ts'
import type { ReadMemoryPhysicalFile } from '../core/ports/documents.ts'

function byRevision<T extends { revision: string }>(items: Iterable<T>) {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const existing = grouped.get(item.revision)
    if (existing) existing.push(item)
    else grouped.set(item.revision, [item])
  }
  return grouped
}

function classify(accepted: readonly MemoryFileIdentity[], scan: CatalogScan): MemoryCatalogChange[] {
  const { complete } = scan
  const output: MemoryCatalogChange[] = scan.quarantined
  const found = new Map(scan.files.map(file => [file.path, file]))
  const bound = new Set(accepted.map(file => file.path))
  const unavailable = (path: string) => scan.quarantined.some(entry => entry.path === path || path.startsWith(entry.path + '/'))
  const missing = complete ? accepted.filter(file => !found.has(file.path) && !unavailable(file.path)) : []
  // An unreadable eligible file or subtree might conceal a competing rename.
  // Invalid paths and symlinks cannot be alternate accepted destinations.
  const uncertainRename = scan.quarantined.some(entry => entry.reason === 'unreadable')
  const added = [...found.values()].filter(file => !bound.has(file.path))
  const renamed = new Set<string>()

  for (const file of accepted) {
    const observed = found.get(file.path)
    if (observed) output.push({ kind: observed.revision === file.revision ? 'unchanged' : 'modified', identity: file, file: observed })
  }
  const missingByRevision = byRevision(missing)
  const observedByRevision = byRevision(found.values())
  const acceptedByRevision = byRevision(accepted)
  for (const file of added) {
    const old = missingByRevision.get(file.revision) ?? []
    const peers = observedByRevision.get(file.revision) ?? []
    const prior = acceptedByRevision.get(file.revision) ?? []
    if (!uncertainRename && old.length === 1 && peers.length === 1 && prior.length === 1) {
      output.push({ kind: 'rename', identity: old[0]!, file })
      renamed.add(old[0]!.id)
    } else if (old.length > 0) output.push({ kind: 'quarantined', path: file.path, reason: 'ambiguous-rename' })
    else if (prior.length || peers.length > 1) output.push({ kind: 'quarantined', path: file.path, reason: 'duplicate-content' })
    else output.push({ kind: 'added', file })
  }
  for (const file of missing) if (!renamed.has(file.id)) output.push({ kind: 'missing', identity: file })
  return output
}

/** A hung scan keeps its slot until the child actually exits. The owner only interprets observations. */
export function openMemoryFileCatalog({ root, timeoutMs = 5_000, forkWorker = fork, readPhysicalFile = createMemoryPhysicalFileReader(() => root) }: {
  root: string, timeoutMs?: number, readPhysicalFile?: ReadMemoryPhysicalFile & { close?(): void },
  forkWorker?: (entry: string, args: readonly string[], options: ForkOptions) => ChildProcess,
}): MemoryFileCatalog {
  const active = new Map<string, () => void>()
  let closed = false
  const location = resolve(root)
  const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const entry = fileURLToPath(new URL(`./memory-file-catalog-worker${suffix}`, import.meta.url))
  const unavailable = (): MemoryCatalogChange[] => [{ kind: 'quarantined', path: '', reason: 'scan-unavailable' }]

  function workspaceRoot(workspace: string) {
    if (!/^[a-f0-9]{64}$/u.test(workspace)) throw new Error('invalid-memory-workspace')
    return join(location, workspace)
  }
  async function scan(workspace: string, accepted: readonly MemoryFileIdentity[]) {
    workspaceRoot(workspace)
    if (accepted.some(file => file.workspace !== workspace)) throw new Error('invalid-memory-workspace')
    if (closed || active.has(workspace) || active.size >= 2) return unavailable()
    return new Promise<MemoryCatalogChange[]>(done => {
      const observation: CatalogScan = { files: [], quarantined: [], complete: false }
      let complete: boolean | undefined
      const child = forkWorker(entry, [location, workspace], {
        execPath: process.execPath, execArgv: [], windowsHide: true,
        env: memoryWorkerEnvironment(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      let settled = false
      const finish = (changes: MemoryCatalogChange[]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done(changes)
      }
      const incomplete = () => {
        if (settled) return
        observation.quarantined.push({ kind: 'quarantined', path: '', reason: 'scan-unavailable' })
        finish(classify(accepted, observation))
      }
      const stop = () => { incomplete(); child.kill() }
      const timer = setTimeout(stop, timeoutMs)
      active.set(workspace, stop)
      child.once('close', code => {
        active.delete(workspace)
        if (settled) return
        if (code !== 0 || complete === undefined) { incomplete(); return }
        observation.complete = complete
        finish(classify(accepted, observation))
      })
      child.on('error', incomplete)
      child.on('message', (batch: CatalogScan) => {
        if (settled) return
        observation.files.push(...batch.files)
        observation.quarantined.push(...batch.quarantined)
        complete = batch.complete
      })
    })
  }
  return {
    scan,
    async read(workspace, path, signal) {
      if (closed) throw new Error('memory-file-catalog-closed')
      return readPhysicalFile(workspace, path, signal)
    },
    readAtCommit(workspace, path) {
      const directory = workspaceRoot(workspace)
      try {
        if (lstatSync(location).isSymbolicLink() || lstatSync(directory).isSymbolicLink()) throw new Error('unsafe-memory-path')
        return openMemoryFileStore(directory, { create: false }).read(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    close() {
      closed = true
      readPhysicalFile.close?.()
      for (const stop of active.values()) stop()
    },
  }
}
