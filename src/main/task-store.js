import fs from 'node:fs'
import path from 'node:path'

/**
 * Background tasks (task-ipc.js), kept on disk: dsh ends with the app, so a task that had not finished is
 * offered again at the next launch, to go on with or let go, and one that ended (`endedAt`, `status`) comes
 * back to be asked again. A task leaves the store when it is closed or undone, or when it is among the
 * oldest of those that ended.
 */
const FILE_VERSION = 1

const isText = (value) => typeof value === 'string' && value.length > 0
const isTask = (entry) => Boolean(entry) && typeof entry === 'object' && isText(entry.id) && isText(entry.segmentId) && isText(entry.title)

/**
 * @param {{ file: string, onError?: (err: Error) => void }} options
 * @returns {{ list: () => object[], add: (task: object) => void, remove: (id: string) => void }}
 */
export function createTaskStore({ file, onError = () => {} }) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data?.tasks) ? data.tasks.filter(isTask) : []
    } catch (err) {
      if (err.code !== 'ENOENT') onError(err)
      return []
    }
  }

  function write(tasks) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, tasks }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  return {
    list: read,
    /** Kept once: the same task again replaces what was kept. */
    add: (task) => write([...read().filter((entry) => entry.id !== task.id), task]),
    remove: (id) => write(read().filter((entry) => entry.id !== id)),
  }
}
