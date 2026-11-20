import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { renameSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { scratch } from './fixtures/scratch.js'
import { legacyDailyRename, noteSource } from './fixtures/memory-note-fixture.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'

function fixture(t: test.TestContext) {
  const { dir, defer } = scratch(t, 'viva-memory-rename-')
  const store = openMemoryStore(join(dir, 'memory.db'))
  defer(() => store.close())
  const source = noteSource(store), workspace = memorySourceWorkspace(source)
  const ref = { id: source.id, token: memorySourceToken(source) }
  const documents = () => openMemoryDocuments({ db: store.db, root: store.fileRoot,
    source: id => id === source.id ? { workspace, token: ref.token, text: source.text! } : undefined })
  const notes = () => openMemoryNotes(store, id => Boolean(store.readSource(id)?.text))
  function createDaily() {
    const ledger = notes(), key = ledger.add('session', '2026-11-14', [source], '')!
    ledger.commit(key, ledger.pending(key), { status: 'write', title: 'Tea', markdown: 'Enjoy tea.' }, 1, 1, [ref], undefined)
    return ledger.read(key)!
  }
  return { store, source, workspace, ref, documents, notes, createDaily, physical: (path: string) => join(store.fileRoot, workspace, path) }
}

test('an accepted digest rename retains old links, stop state, and semantic undo after upgrade', t => {
  const f = fixture(t), docs = f.documents(), from = 'digest/wiki/a.md', to = 'digest/wiki/renamed.md'
  docs.commit({ operationId: 'create', workspace: f.workspace, path: from, expectedRevision: null,
    markdown: 'old', sources: [f.ref], reads: [], action: 'CREATE' })
  const first = docs.read(f.workspace, from)!
  docs.commit({ operationId: 'correct', workspace: f.workspace, path: from, expectedRevision: first.revision,
    markdown: 'new', sources: [f.ref], reads: [first], action: 'CORRECT',
    corrections: [{ path: from, revision: first.revision, startLine: 1, endLine: 1, text: 'old', condition: '', time: '' }] })
  const corrected = docs.read(f.workspace, from)!
  docs.setEnabled({ operationId: 'stop', workspace: f.workspace, documentId: first.id,
    expectedRevision: corrected.revision, expectedUsageVersion: corrected.usageVersion, enabled: false })
  const stopped = docs.read(f.workspace, from, { includeDisabled: true })!
  renameSync(f.physical(from), f.physical(to))
  f.store.tx(() => {
    f.store.db.prepare('UPDATE memory_documents SET path=? WHERE id=?').run(to, first.id)
    f.store.db.prepare('INSERT INTO memory_document_aliases VALUES(?,?,?)').run(f.workspace, from, first.id)
  })
  const reopened = f.documents()
  assert.equal(reopened.resolveFileAlias(f.workspace, from), to)
  assert.equal(reopened.read(f.workspace, to), null)
  assert.equal(reopened.read(f.workspace, to, { includeDisabled: true })?.id, first.id)
  assert.equal(reopened.supersessions(f.workspace, to).length, 1)
  assert.equal(reopened.supersessions(f.workspace, from).length, 0)
  reopened.undo({ operationId: 'undo', workspace: f.workspace, documentId: first.id,
    revision: stopped.revision, usageVersion: stopped.usageVersion })
  assert.equal(reopened.read(f.workspace, to, { includeDisabled: true })?.markdown, 'old')
  assert.equal(reopened.read(f.workspace, to), null)
  const unregistered = 'digest/wiki/another.md'
  renameSync(f.physical(to), f.physical(unregistered))
  const again = f.documents()
  assert.equal(again.resolveFileAlias(f.workspace, unregistered), null)
  assert.equal(again.read(f.workspace, to, { includeDisabled: true }), null)
  assert.equal(again.read(f.workspace, unregistered, { includeDisabled: true }), null)
})

test('an accepted cross-day rename retains daily links, correction anchors and withdrawal after upgrade', t => {
  const f = fixture(t), before = f.createDaily(), to = 'daily/2026-11-15/renamed.md'
  const docs = f.documents(), digest = 'digest/wiki/correction.md'
  const line = before.document.split('\n').findIndex(text => text === 'Enjoy tea.') + 1
  docs.commit({ operationId: 'create', workspace: f.workspace, path: digest, expectedRevision: null,
    markdown: 'Prior summary.', sources: [f.ref], reads: [], action: 'CREATE' })
  docs.commit({ operationId: 'correct', workspace: f.workspace, path: digest, expectedRevision: docs.read(f.workspace, digest)!.revision,
    markdown: 'Coffee instead.', sources: [f.ref], reads: [], files: [{ path: before.path, revision: before.fileRevision }],
    action: 'CORRECT', corrections: [{ path: before.path, revision: before.fileRevision, startLine: line, endLine: line,
      text: 'Enjoy tea.', condition: '', time: '' }] })
  legacyDailyRename(f.store, before, to)
  const notes = f.notes()
  assert.equal(notes.resolveFileAlias(f.workspace, before.path), to)
  assert.equal(notes.read(before.key)?.day, before.day)
  assert.equal(notes.read(before.key)?.markdown, before.markdown)
  assert.equal(docs.supersessions(f.workspace, to).length, 1)
  assert.equal(docs.supersessions(f.workspace, before.path).length, 0)
  notes.withdraw(f.source.id)
  notes.recover()
  assert.equal(notes.pendingCleanup(), 0)
  assert.equal(existsSync(f.physical(to)), false)
  const index = readFileSync(f.physical('daily/2026-11-14.md'), 'utf8')
  assert.equal(index.includes(to), false)
  assert.equal(index.includes(before.path), false)
})

test('an unfinished legacy daily rename leaves moved bytes and a partly applied day index alone on restart', t => {
  const f = fixture(t), before = f.createDaily(), to = 'daily/2026-11-14/moved.md'
  const indexPath = 'daily/2026-11-14.md', index = readFileSync(f.physical(indexPath), 'utf8')
  const movedIndex = index.replace(before.path, to)
  assert.notEqual(index, movedIndex)
  renameSync(f.physical(before.path), f.physical(to))
  writeFileSync(f.physical(indexPath), movedIndex)
  const input = { operationId: 'legacy', workspace: f.workspace, id: before.key, from: before.path, to,
    revision: before.fileRevision, usageVersion: before.revision }
  const plan = { workspace: f.workspace, changes: [
    { path: indexPath, before: index, after: movedIndex },
    { path: before.path, before: null, after: null },
    { path: to, before: before.document, after: before.document },
  ], data: { kind: 'rename', key: before.key, workspace: f.workspace, from: before.path, to,
    revision: before.revision, fileRevision: before.fileRevision, at: 1, input, refs: [f.ref], indexKeys: [before.key] } }
  const id = 'notes:rename:legacy'
  f.store.db.prepare('INSERT INTO memory_file_intents VALUES(?,?,?,?,?,?)').run(id, 'legacy-fingerprint', 'pending', f.workspace, JSON.stringify(plan), 'notes')
  const notes = f.notes()
  notes.recover()
  assert.equal(notes.read(before.key), undefined)
  assert.equal(notes.resolveFileAlias(f.workspace, to), null)
  assert.equal(f.store.db.prepare('SELECT 1 FROM memory_note_aliases').get(), undefined)
  assert.equal(notes.registered()[0]?.path, before.path)
  assert.equal(notes.registered()[0]?.revision, before.revision)
  assert.equal(readFileSync(f.physical(to), 'utf8'), before.document)
  assert.equal(readFileSync(f.physical(indexPath), 'utf8'), movedIndex)
  assert.deepEqual({ ...f.store.db.prepare('SELECT state,plan FROM memory_file_intents WHERE id=?').get(id) }, { state: 'cancelled', plan: null })
})
