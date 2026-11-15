import { join } from 'node:path'
import { openMemoryStore } from '../../src/backend/memory-store.ts'
import { openMemoryNotes } from '../../src/backend/memory-note-store.ts'
import { crashAt } from './memory-crash-process.ts'

const [point, directory, id] = process.argv.slice(2) as [string, string, string]
const store = openMemoryStore(join(directory, 'memory.db'))
const notes = openMemoryNotes(store, () => true, actual => { if (actual === point) crashAt(point) })
notes.add('new-session', '2026-11-14', [store.readSource(id)!], '已完成这个回合')
throw new Error('expected crash boundary')
