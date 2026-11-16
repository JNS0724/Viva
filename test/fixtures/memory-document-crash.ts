import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { openMemoryDocuments } from '../../src/memory/node/memory-document-store.ts'
import { memoryFileRevision } from '../../src/memory/node/memory-file-store.ts'

const [root, point] = process.argv.slice(2)
if (!root || !point) throw new Error('missing-crash-fixture-arguments')
const db = new DatabaseSync(join(root, 'memory.db'))
const workspace = memoryFileRevision('scope')
const source = () => ({ workspace, token: 'v1', text: '原来在深圳，现在搬到上海。' })
const first = openMemoryDocuments({ db, root, source }).commit({ operationId: 'create', workspace, path: 'digest/personal/home.md', expectedRevision: null, markdown: '深圳', action: 'CREATE', sources: [{ id: 's1', token: 'v1' }], reads: [] })
const documents = openMemoryDocuments({ db, root, source, checkpoint(at) { if (at === point) process.kill(process.pid, 'SIGKILL') } })
documents.commit({ operationId: 'correct', workspace, path: first.path, expectedRevision: first.revision, markdown: '上海', action: 'CORRECT', sources: [{ id: 's1', token: 'v1' }], reads: [], corrections: [{ path: first.path, revision: first.revision!, startLine: 1, endLine: 1, text: '深圳', condition: '居住地', time: '搬迁后' }] })
throw new Error('crash-point-not-reached')
