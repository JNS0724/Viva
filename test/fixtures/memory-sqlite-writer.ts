import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const file: unknown = workerData
if (typeof file !== 'string' || !parentPort) throw new Error('Missing SQLite writer fixture input')
const port = parentPort
const db = new DatabaseSync(file)
db.exec("BEGIN IMMEDIATE; UPDATE memory_meta SET value=value WHERE key='secret'")
let released = false
const release = () => {
  if (released) return
  released = true
  db.exec('COMMIT')
  db.close()
  port.postMessage('released')
  port.close()
}
port.on('message', (command: unknown) => {
  if (command === 'release') release()
  else if (command === 'release-soon') setTimeout(release, 100)
  else throw new Error('Unknown SQLite writer fixture command')
})
port.postMessage('locked')
