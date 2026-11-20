import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'

for (const kind of ['digest', 'daily'] as const) test(`upgrading cancels an unfinished external ${kind} edit without accepting or reverting the user's bytes`, t => {
  const { dir, defer } = scratch(t, 'viva-memory-edit-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const source = noteSource(store), workspace = memorySourceWorkspace(source)
  const ref = { id: source.id, token: memorySourceToken(source) }
  const openDocuments = () => openMemoryDocuments({ db: store.db, root: store.fileRoot,
    source: id => id === source.id ? { workspace, token: ref.token, text: source.text! } : undefined })
  const openNotes = () => openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  const operationId = 'legacy'
  const observedEdit = (id: string, path: string, expectedRevision: string, expectedUsageVersion: number, edited: string) => ({
    operationId, workspace, id, path, expectedRevision, expectedUsageVersion, observedRevision: memoryFileRevision(edited),
    sources: [ref], policyToken: 'legacy-policy',
  })
  let path: string, planData: (edited: string) => object, read: () => string | undefined
  if (kind === 'digest') {
    const docs = openDocuments()
    path = 'digest/wiki/report.md'
    docs.commit({ operationId: 'authored', workspace, path, action: 'CREATE', expectedRevision: null,
      sources: [ref], reads: [], markdown: 'Accepted original' })
    const before = docs.read(workspace, path)!
    planData = edited => {
      const externalEdit = observedEdit(before.id, path, before.revision, before.usageVersion, edited)
      const after = { ...before, markdown: edited, revision: externalEdit.observedRevision, usageVersion: before.usageVersion + 1 }
      const receipt = { operationId, documentId: before.id, path, revision: after.revision, usageVersion: after.usageVersion, action: 'REFINE' }
      return { kind: 'revision', input: 'legacy-fingerprint', before, after, receipt, workspace,
        sources: [ref], reads: [], files: [], externalEdit }
    }
    read = () => openDocuments().read(workspace, path)?.markdown
  } else {
    const notes = openNotes()
    const key = notes.add('session', '2026-11-14', [source], '')!
    notes.commit(key, notes.pending(key), { status: 'write', title: 'Report', markdown: 'Accepted original' }, 1, 1, [ref], undefined)
    const before = notes.read(key)!
    path = before.path
    planData = edited => {
      const input = observedEdit(key, path, before.fileRevision, before.revision, edited)
      return { kind: 'edit', key, workspace, path, refs: [ref], revision: before.revision, fileRevision: before.fileRevision,
        input, observedRevision: input.observedRevision, at: 1, indexKeys: [key] }
    }
    read = () => openNotes().read(key)?.markdown
  }
  const physical = join(store.fileRoot, workspace, path), original = readFileSync(physical, 'utf8')
  const edited = original.replace('Accepted original', 'User edited outside the application')
  writeFileSync(physical, edited)
  const namespace = kind === 'digest' ? 'documents' : 'notes'
  const id = kind === 'digest' ? 'documents:legacy' : 'notes:external-edit:legacy'
  const plan = { workspace, changes: [{ path, before: edited, after: edited }], data: planData(edited) }
  store.db.prepare('INSERT INTO memory_file_intents VALUES(?,?,?,?,?,?)').run(id, 'legacy-fingerprint', 'pending', workspace, JSON.stringify(plan), namespace)
  assert.equal(read(), undefined)
  assert.equal(readFileSync(physical, 'utf8'), edited)
  assert.deepEqual({ ...store.db.prepare('SELECT state,plan FROM memory_file_intents WHERE id=?').get(id) }, { state: 'cancelled', plan: null })
  writeFileSync(physical, original)
  assert.equal(read(), 'Accepted original', 'restoring the accepted bytes makes the existing record readable again')
})
