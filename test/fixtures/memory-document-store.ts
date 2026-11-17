import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDocuments } from '../../src/memory/node/memory-document-store.ts'
import { openMemoryFileJournal } from '../../src/memory/node/memory-file-journal.ts'
import type { FileCheckpoint } from '../../src/memory/node/memory-file-journal.ts'
import { memoryFileRevision } from '../../src/memory/node/memory-file-store.ts'
import type { DocumentCommit, DocumentSourceRef } from '../../src/memory/core/ports/documents.ts'
import { runToCrash } from './memory-crash-process.ts'
const workspace = memoryFileRevision('scope')
const path = 'digest/personal/home.md'
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'memory-documents-'))
  const db = new DatabaseSync(join(root, 'memory.db'))
  const sources = new Map([['s1', { workspace, token: 'v1', text: '我住深圳。我喜欢茶。' }], ['s2', { workspace, token: 'v2', text: '更正：我搬到上海了。' }]])
  const source = (id: string) => sources.get(id)
  const create = (checkpoint?: (point: FileCheckpoint, path?: string) => void) => openMemoryDocuments({ db, root, source, checkpoint,
    managementCurrent: (_, guard) => guard.policyToken === 'policy-v1' })
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  const input: DocumentCommit = { operationId: 'create', workspace, path, expectedRevision: null, markdown: '# 居住地\n深圳', action: 'CREATE', sources: [{ id: 's1', token: 'v1', spans: [{ start: 0, end: 5 }] }], reads: [] }
  return { root, db, sources, create, input }
}

export {
  DatabaseSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, join, tmpdir, openMemoryDocuments, openMemoryFileJournal, memoryFileRevision, runToCrash, workspace, path, fixture,
}

export type { FileCheckpoint, DocumentCommit, DocumentSourceRef }
