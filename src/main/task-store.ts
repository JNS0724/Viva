import type { DatabaseSync } from 'node:sqlite'

/**
 * Background tasks (task-ipc.ts), kept in the app database (src/backend/app-db.ts): dsh ends with the app, so a task
 * that had not finished is offered again at the next launch, to go on with or let go, and one that ended (`endedAt`,
 * `status`) comes back to be asked again. A task leaves the store when it is closed or undone, or when it is among
 * the oldest of those that ended.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS background_tasks (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL
  );
`

/** A task as kept; task-ipc.ts adds what else it needs (words, cwd, startedAt, endedAt, status). */
export interface StoredTask { id: string, segmentId: string, title: string, [field: string]: any }

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isTask = (entry: any): entry is StoredTask => Boolean(entry) && typeof entry === 'object' && isText(entry.id) && isText(entry.segmentId) && isText(entry.title)

export interface TaskStore {
  /** In the order they were kept, the last kept last. */
  list: () => StoredTask[]
  /** Kept once: the same task again replaces what was kept, and goes last. */
  add: (task: StoredTask) => void
  remove: (id: string) => void
}

export function createTaskStore({ db, onError = () => {} }: { db: DatabaseSync, onError?: (err: Error) => void }): TaskStore {
  db.exec(SCHEMA)
  const all = db.prepare('SELECT id, task FROM background_tasks ORDER BY rowid')
  // REPLACE deletes the row it replaces, so the task kept again takes a new rowid: last.
  const put = db.prepare('INSERT OR REPLACE INTO background_tasks (id, task) VALUES (?, ?)')
  const drop = db.prepare('DELETE FROM background_tasks WHERE id = ?')

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
    add: (task) => { put.run(task.id, JSON.stringify(task)) },
    remove: (id) => { drop.run(id) },
  }
}
