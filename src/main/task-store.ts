import fs from 'node:fs'
import path from 'node:path'

/**
 * Background tasks (task-ipc.js), kept on disk: dsh ends with the app, so a task that had not finished is
 * offered again at the next launch, to go on with or let go, and one that ended (`endedAt`, `status`) comes
 * back to be asked again. A task leaves the store when it is closed or undone, or when it is among the
 * oldest of those that ended.
 */
const FILE_VERSION = 1

/** A task as kept; task-ipc.js adds what else it needs (words, cwd, startedAt, endedAt, status). */
export interface StoredTask { id: string, segmentId: string, title: string, [field: string]: any }

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isTask = (entry: any): entry is StoredTask => Boolean(entry) && typeof entry === 'object' && isText(entry.id) && isText(entry.segmentId) && isText(entry.title)

export interface TaskStore {
  list: () => StoredTask[]
  /** Kept once: the same task again replaces what was kept. */
  add: (task: StoredTask) => void
  remove: (id: string) => void
}

export function createTaskStore({ file, onError = () => {} }: { file: string, onError?: (err: Error) => void }): TaskStore {
  function read(): StoredTask[] {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data?.tasks) ? data.tasks.filter(isTask) : []
    } catch (err: any) {
      if (err.code !== 'ENOENT') onError(err)
      return []
    }
  }

  function write(tasks: StoredTask[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, tasks }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  return {
    list: read,
    add: (task) => write([...read().filter((entry) => entry.id !== task.id), task]),
    remove: (id) => write(read().filter((entry) => entry.id !== id)),
  }
}
