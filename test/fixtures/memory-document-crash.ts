import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { openMemoryDocuments } from '../../src/memory/node/memory-document-store.ts'
import { memoryFileRevision } from '../../src/memory/node/memory-file-store.ts'
import { crashAt } from './memory-crash-process.ts'

const [point, root] = process.argv.slice(2)
if (!root || !point) throw new Error('missing-crash-fixture-arguments')
const db = new DatabaseSync(join(root, 'memory.db'))
const workspace = memoryFileRevision('scope')
const source = () => ({ workspace, token: 'v1', text: '原来在深圳，现在搬到上海。' })
const first = openMemoryDocuments({ db, root, source }).commit({ operationId: 'create', workspace, path: 'digest/personal/home.md', expectedRevision: null, markdown: '深圳', action: 'CREATE', sources: [{ id: 's1', token: 'v1' }], reads: [] })
const documents = openMemoryDocuments({ db, root, source, checkpoint(at) { if (at === point) crashAt(point) } })
documents.commit({ operationId: 'refine', workspace, path: first.path, expectedRevision: first.revision, markdown: '上海', action: 'REFINE', sources: [{ id: 's1', token: 'v1' }], reads: [] })
throw new Error('crash-point-not-reached')
