import type { DatabaseSync } from 'node:sqlite'
import { withOperation } from '../../diagnostics/node/context.ts'
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { transaction } from './sqlite.ts'
import { memoryFileRevision, openMemoryFileStore } from './memory-file-store.ts'

export type FileReplacement = { path: string, before: string | null, after: string | null }
/** A journaled append retains the new line and hashes, never the earlier transcript. */
type FileAppend = { path: string, beforeRevision: string | null, afterRevision: string, append: string }
export type FileErasure = { path: string, beforeRevision: string, afterRevision: string | null, erase: true }
export type FileChange = FileReplacement | FileAppend | FileErasure
export function fileErasure(change: FileReplacement): FileChange {
  return change.before === null ? change : { path: change.path, beforeRevision: memoryFileRevision(change.before),
    afterRevision: change.after === null ? null : memoryFileRevision(change.after), erase: true }
}
export type FilePlan<T> = { workspace: string, changes: FileChange[], data: T }
type Intent<T> = { id: string, input: string, state: string, plan: FilePlan<T> }
export type FileCheckpoint = 'intent' | 'replace' | 'receipt' | 'checkpoint'

/** One backend owner. Intent commits precede IO; receipt and application checkpoint share one SQL transaction. */
export function openMemoryFileJournal<T>({ db, root, valid, finish, checkpoint = () => {}, namespace = 'notes', cancelOnConflict = () => false, projectErasure }: {
  db: DatabaseSync, root: string, valid: (data: T) => boolean, finish: (data: T) => void,
  checkpoint?: (point: FileCheckpoint, path?: string) => void, namespace?: string,
  cancelOnConflict?: (data: T) => boolean,
  projectErasure?: (data: T, path: string, before: string) => string | null | undefined,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_file_intents (
    id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, workspace TEXT NOT NULL, plan TEXT, namespace TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS memory_file_reservations (workspace TEXT NOT NULL, path TEXT NOT NULL, owner TEXT NOT NULL, PRIMARY KEY(workspace,path))`)
  if (!/^[a-z][a-z0-9-]*$/u.test(namespace)) throw new Error('invalid-memory-journal-namespace')
  const operationKey = (id: string) => `${namespace}:${id}`
  const stores = new Map<string, ReturnType<typeof openMemoryFileStore>>()
  function files(workspace: string) {
    if (!/^[a-f0-9]{64}$/u.test(workspace)) throw new Error('invalid-memory-workspace')
    let store = stores.get(workspace)
    if (!store) {
      for (const directory of [root, join(root, workspace)]) {
        if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('memory-workspace-symlink')
      }
      store = openMemoryFileStore(join(root, workspace), { sessions: true }); stores.set(workspace, store)
    }
    return store
  }
  function pending(all = false) {
    return (db.prepare("SELECT id,input,state,plan FROM memory_file_intents WHERE plan IS NOT NULL AND (? OR namespace=?)").all(all ? 1 : 0, namespace) as
      Array<{ id: string, input: string, state: string, plan: string }>).map(row => ({ ...row, plan: JSON.parse(row.plan) as FilePlan<T> }))
  }
  const hash = (text: string | null) => text === null ? null : memoryFileRevision(text)
  const beforeRevision = (change: FileChange) => 'beforeRevision' in change ? change.beforeRevision : hash(change.before)
  const afterRevision = (change: FileChange) => 'afterRevision' in change ? change.afterRevision : hash(change.after)
  function targetText(data: T, change: FileChange, before: string | null, accepted: boolean): string | null | undefined {
    if ('erase' in change) return change.afterRevision === null ? null : before === null ? undefined : projectErasure?.(data, change.path, before)
    if (!('append' in change)) return accepted ? change.after : change.before
    if (accepted) return (before ?? '') + change.append
    if (!before?.endsWith(change.append)) return undefined
    return change.beforeRevision === null ? null : before.slice(0, -change.append.length)
  }
  function apply(intent: Intent<T>) {
    if (db.isTransaction) throw new Error('memory-file-commit-inside-transaction')
    const store = files(intent.plan.workspace)
    const conflict = () => {
      if (cancelOnConflict(intent.plan.data)) {
        db.prepare("UPDATE memory_file_intents SET state='cancelled',plan=NULL WHERE id=?").run(intent.id)
        return false
      }
      db.prepare("UPDATE memory_file_intents SET state='conflict' WHERE id=?").run(intent.id)
      throw new Error('memory-file-plan-conflict')
    }
    // Preflight the ENTIRE plan, before writing any member. A third hash is never overwritten.
    const conflicts = intent.plan.changes.some(change => {
      const actual = store.read(change.path)?.revision ?? null
      return actual !== beforeRevision(change) && actual !== afterRevision(change)
    })
    if (conflicts) return conflict()
    const accepted = valid(intent.plan.data)
    // Once erasure begins there is no authorized reversible before-image.
    if (!accepted && intent.plan.changes.some(change => 'erase' in change)) return conflict()
    for (const change of intent.plan.changes) {
      const file = store.read(change.path), actual = file?.revision ?? null
      const previous = beforeRevision(change), next = afterRevision(change)
      if (actual !== previous && actual !== next) return conflict()
      const expected = accepted ? next : previous
      if (actual !== expected) {
        const target = targetText(intent.plan.data, change, file?.markdown ?? null, accepted)
        if (target === undefined || hash(target) !== expected) return conflict()
        if (target === null) store.remove(change.path, actual!)
        else store.write(change.path, target, actual)
      }
      // A member is ready even when an external edit already supplied the exact target bytes.
      checkpoint('replace', change.path)
    }
    transaction(db, () => {
      db.prepare('UPDATE memory_file_intents SET state=?,plan=NULL WHERE id=?').run(accepted ? 'done' : 'cancelled', intent.id)
      checkpoint('receipt')
      if (accepted) finish(intent.plan.data)
      checkpoint('checkpoint')
    })
    return accepted
  }
  function recover(id?: string, includes = (_data: T) => true) {
    return withOperation('storage', () => recoverPrepared(id, includes), { stage: 'recovering', identities: { requestId: id ?? null, methodId: namespace } })
  }
  function recoverPrepared(id: string | undefined, includes: (data: T) => boolean) {
    for (const intent of pending()) {
      if (id !== undefined && intent.id !== operationKey(id) || !includes(intent.plan.data)) continue
      try { apply(intent) } catch (error) {
        if (!(error instanceof Error && error.message === 'memory-file-plan-conflict')) throw error
      }
    }
  }
  function commit(id: string, input: string, plan: () => FilePlan<T>) {
    return withOperation('storage', () => commitPrepared(id, input, plan), { stage: 'checkpoint', identities: { requestId: id, methodId: namespace } })
  }
  function commitPrepared(id: string, input: string, plan: () => FilePlan<T>) {
    if (db.isTransaction) throw new Error('memory-file-commit-inside-transaction')
    id = operationKey(id)
    const existing = db.prepare('SELECT input,state FROM memory_file_intents WHERE id=?').get(id) as { input: string, state: string } | undefined
    if (existing) {
      if (existing.input !== input) throw new Error('memory-request-input-mismatch')
      if (existing.state === 'done') return true
      if (existing.state === 'cancelled') return false
      return apply(pending().find(item => item.id === id)!)
    }
    const next = plan()
    if (!valid(next.data)) throw new Error('memory-source-version')
    const paths = new Set(next.changes.map(change => change.path))
    if (paths.size !== next.changes.length) throw new Error('duplicate-memory-plan-path')
    if (next.changes.some(change => db.prepare('SELECT 1 FROM memory_file_reservations WHERE workspace=? AND path=?').get(next.workspace, change.path)) || pending(true).some(item => item.plan.workspace === next.workspace && item.plan.changes.some(change => paths.has(change.path)))) {
      throw new Error('memory-file-plan-busy')
    }
    const store = files(next.workspace)
    for (const change of next.changes) {
      if ((store.read(change.path)?.revision ?? null) !== beforeRevision(change)) throw new Error('memory-file-version')
    }
    transaction(db, () => db.prepare('INSERT INTO memory_file_intents(id,input,state,workspace,plan,namespace) VALUES(?,?,?,?,?,?)')
      .run(id, input, 'pending', next.workspace, JSON.stringify(next), namespace))
    checkpoint('intent')
    return apply({ id, input, state: 'pending', plan: next })
  }
  function visible(workspace: string, path: string) {
    return !db.prepare('SELECT 1 FROM memory_file_reservations WHERE workspace=? AND path=?').get(workspace, path) && !pending(true).some(item => item.plan.workspace === workspace && item.plan.changes.some(change => change.path === path))
  }
  const state = (id: string) => (db.prepare('SELECT state FROM memory_file_intents WHERE id=?').get(operationKey(id)) as { state: string } | undefined)?.state
  return { files, commit, recover, visible, state }
}
