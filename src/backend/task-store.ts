import type { DatabaseSync } from 'node:sqlite'
import { memoryProvenanceSchema, type MemoryProvenance } from '../memory/contracts/provenance.ts'
import type { GeneratedHistoryScope } from './history-generated-copies.ts'

/**
 * Background tasks (task-runtime.ts, their one writer), kept in the app database (src/backend/app-db.ts): dsh ends with the app, so a task
 * that had not finished is offered again at the next launch, to go on with or let go, and one that ended (`endedAt`,
 * `status`) comes back to be asked again. A task leaves the store when it is closed or undone, or when it is among
 * the oldest of those that ended.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS background_tasks (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memory_erased_task_bodies (id TEXT PRIMARY KEY, effect TEXT NOT NULL);
`

/** A task as kept; task-runtime.ts adds what else it needs (words, cwd, startedAt, endedAt, status). */
export interface StoredTask { id: string, segmentId: string, title: string, runStart?: number, resultTruncated?: boolean, resultFromTerminal?: boolean, terminalMessage?: string, resultErased?: boolean, requestMemory?: MemoryProvenance, resultKey?: string, [field: string]: any }

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isTask = (entry: any): entry is StoredTask => Boolean(entry) && typeof entry === 'object' && isText(entry.id) && isText(entry.segmentId) && isText(entry.title)

export interface TaskStore {
  /** In the order they were kept, the last kept last. */
  list: () => StoredTask[]
  /** Kept once: the same task again replaces what was kept, and goes last. */
  add: (task: StoredTask) => void
  remove: (id: string) => void
  eraseMemoryBodies?: (effect: string, matches: (proof: MemoryProvenance) => boolean, removed: readonly GeneratedHistoryScope[]) => readonly string[]
}

export function createTaskStore({ db, retainedReply, onError = () => {} }: {
  db: DatabaseSync
  retainedReply?: (session: string, key: string) => boolean
  onError?: (err: Error) => void
}): TaskStore {
  db.exec(SCHEMA)
  const all = db.prepare('SELECT id, task FROM background_tasks ORDER BY rowid')
  // REPLACE deletes the row it replaces, so the task kept again takes a new rowid: last.
  const put = db.prepare('INSERT OR REPLACE INTO background_tasks (id, task) VALUES (?, ?)')
  const drop = db.prepare('DELETE FROM background_tasks WHERE id = ?')
  const erased = db.prepare('SELECT 1 FROM memory_erased_task_bodies WHERE id=?')
  const retire = db.prepare('INSERT OR IGNORE INTO memory_erased_task_bodies VALUES (?,?)')
  const update = db.prepare('UPDATE background_tasks SET task=? WHERE id=?')
  const retiredBy = db.prepare('SELECT id FROM memory_erased_task_bodies WHERE effect=?')

  function list(): StoredTask[] {
    return (all.all() as Array<{ id: string, task: string }>).flatMap((row) => {
      try {
        const task: unknown = JSON.parse(row.task)
        return isTask(task) ? [task] : []
      } catch (err) {
        onError(new Error(`background task ${row.id} cannot be read: ${(err as Error).message}`))
        return []
      }
    })
  }

  return {
    list,
    add: (task) => {
      if (erased.get(task.id)) throw new Error('Erased task body cannot be restored')
      // A retained task may still receive a late ending after a previous result was erased.
      // Host/provider terminal error messages (resultFromTerminal without a reply key) are not memory-derived replies.
      const terminalResult = Boolean(task.resultFromTerminal) && !task.resultKey && !task.resultErased
      if (retainedReply && !terminalResult && (!task.resultKey || !retainedReply(task.id, task.resultKey))) {
        const erasedResult = Boolean(task.resultKey) || Boolean(task.resultErased)
        task = { ...task, resultKey: undefined, resultPreview: '', resultTruncated: undefined, resultFromTerminal: undefined, terminalMessage: undefined, ...(erasedResult ? { resultErased: true } : {}) }
      }
      put.run(task.id, JSON.stringify(task))
    },
    remove: (id) => { drop.run(id) },
    eraseMemoryBodies(effect, matches, removed) {
      const sessions = new Set(removed.map(entry => entry.session))
      const affected = new Set<string>()
      for (const task of list()) {
        if (task.requestMemory && matches(memoryProvenanceSchema.parse(task.requestMemory))) {
          retire.run(task.id, effect)
          drop.run(task.id)
        } else if (sessions.has(task.id)) {
          if (removed.some(entry => entry.session === task.id && entry.key === task.resultKey)) {
            update.run(JSON.stringify({ ...task, resultKey: undefined, resultPreview: '', resultTruncated: undefined, resultFromTerminal: undefined, terminalMessage: undefined, resultErased: true }), task.id)
          }
          affected.add(task.id)
        }
      }
      for (const row of retiredBy.all(effect)) affected.add(String(row.id))
      return [...affected]
    },
  }
}
