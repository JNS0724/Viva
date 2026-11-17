import { join } from 'node:path'
import { openMemoryStore } from '../../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../../src/memory/node/memory-note-store.ts'
import { crashAt } from './memory-crash-process.ts'

const [point, directory, key] = process.argv.slice(2) as [string, string, string]
const store = openMemoryStore(join(directory, 'memory.db'))
const notes = openMemoryNotes(store, id => Boolean(store.readSource(id)?.text), (actual, path) => {
  if (actual === point && (actual !== 'replace' || path?.includes('/daily/') || /daily\/.*\//u.test(path ?? ''))) crashAt(point)
})
const rows = notes.pending(key)
notes.commit(key, rows, { status: 'write', title: '发布流程', markdown: '先核对版本，再发布。' }, 7, Date.now(), notes.snapshot([...notes.sources(key), ...rows.flatMap(row => row.sourceIds)]), notes.read(key))
throw new Error('expected crash boundary')
