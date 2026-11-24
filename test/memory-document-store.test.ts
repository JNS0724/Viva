import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryFileJournal } from '../src/memory/node/memory-file-journal.ts'
import type { FileCheckpoint } from '../src/memory/node/memory-file-journal.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import type { DocumentCommit, DocumentSourceRef } from '../src/memory/core/ports/documents.ts'
import { runToCrash } from './fixtures/memory-crash-process.ts'

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


test('document commits persist identity and history; repeat receipts do not add revisions', t => {
  const f = fixture(t), documents = f.create()
  const saved = documents.commit(f.input)
  assert.deepEqual(documents.commit(f.input), saved)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 1)
  assert.throws(() => documents.commit({ ...f.input, markdown: 'different' }), /input-mismatch/)
  assert.equal(readFileSync(join(f.root, workspace, path), 'utf8'), f.input.markdown)
  assert.equal(f.create().read(workspace, path)?.id, saved.documentId)
  assert.equal(documents.receipt(memoryFileRevision('other'), 'create'), null)
})

for (const point of ['intent', 'replace', 'receipt', 'checkpoint'] as const) {
  test(`document ${point} crash recovers body, identity and revision together`, t => {
    const f = fixture(t)
    let crashed = false
    const documents = f.create(at => { if (at === point && !crashed) { crashed = true; throw new Error('crash') } })
    assert.throws(() => documents.commit(f.input), /crash/)
    assert.equal(documents.read(workspace, path), null)
    const resumed = f.create()
    assert.equal(resumed.read(workspace, path)?.markdown, f.input.markdown)
    const receipt = resumed.receipt(workspace, 'create')
    assert(receipt)
    assert.deepEqual(resumed.commit(f.input), receipt)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 1)
  })
}




test('REFINE persists previous snapshot; undo creates a revision and does not cover later edits', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const snapshot = documents.read(workspace, path)!
  const update: DocumentCommit = { ...f.input, operationId: 'refine', action: 'REFINE', expectedRevision: first.revision,
    markdown: '# 居住地\n上海', sources: [...snapshot.sources, { id: 's2', token: 'v2' }], reads: [snapshot] }
  const refined = documents.commit(update)
  const restored = f.create().undo({ operationId: 'undo', workspace, documentId: first.documentId, revision: refined.revision!, usageVersion: refined.usageVersion })
  assert.equal(documents.read(workspace, path)?.markdown, f.input.markdown)
  assert.equal(restored.usageVersion, 3)
  assert.throws(() => documents.undo({ operationId: 'late', workspace, documentId: first.documentId, revision: refined.revision!, usageVersion: refined.usageVersion }), /version/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 3)
})

test('invalid action or changed source cannot commit; external edits are quarantined', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  assert.throws(() => documents.commit({ ...f.input, operationId: 'bad', action: 'CREATE', expectedRevision: first.revision, markdown: 'new' }), /document-version|document-action/)
  f.sources.set('s1', { workspace, token: 'changed', text: 'changed' })
  assert.equal(documents.read(workspace, path), null)
  f.sources.set('s1', { workspace, token: 'v1', text: '我住深圳。我喜欢茶。' })
  writeFileSync(join(f.root, workspace, path), 'unverified external edit')
  assert.equal(documents.read(workspace, path), null)
  assert.throws(() => documents.commit({ ...f.input, operationId: 'overwrite', action: 'REFINE', expectedRevision: first.revision }), /unavailable/)
})

test('disabling a digest leaves other files over the same source available', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const clone = documents.commit({ ...f.input, operationId: 'clone', path: 'digest/wiki/home.md' })
  const tea = documents.commit({ ...f.input, operationId: 'tea', path: 'digest/wiki/tea.md', markdown: '喜欢茶', sources: [{ id: 's1', token: 'v1', spans: [{ start: 5, end: 10 }] }] })
  documents.setEnabled({ operationId: 'disable', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion, enabled: false })
  assert.equal(documents.read(workspace, path), null)
  assert(documents.read(workspace, clone.path))
  assert(documents.read(workspace, tea.path))
  f.sources.set('independent', { workspace, token: 'new', text: '我住深圳。' })
  assert(documents.commit({ ...f.input, operationId: 'new-input', path: 'digest/wiki/new.md', sources: [{ id: 'independent', token: 'new' }] }))
  documents.setEnabled({ operationId: 'enable', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion + 1, enabled: true })
  assert(documents.read(workspace, clone.path))
})


test('journal namespaces isolate recovery callbacks while sharing file exclusion', t => {
  const f = fixture(t)
  let noteFinished = 0
  const notes = openMemoryFileJournal<{ kind: 'note' }>({ db: f.db, root: f.root, namespace: 'notes', valid: () => true, finish: () => noteFinished++, checkpoint: at => { if (at === 'intent') throw new Error('crash') } })
  assert.throws(() => notes.commit('same-id', 'note', () => ({ workspace, changes: [{ path, before: null, after: 'note-owned' }], data: { kind: 'note' } })), /crash/)
  const documents = f.create()
  assert.equal(noteFinished, 0)
  assert.throws(() => documents.commit(f.input), /plan-busy/)
  assert.equal(documents.read(workspace, path), null)
})

test('usage versions reject ABA undo even when later refinements restore identical Markdown', t => {
  const f = fixture(t), documents = f.create()
  documents.commit(f.input)
  const edited = documents.commit({ ...f.input, operationId: 'edit', action: 'REFINE', expectedRevision: memoryFileRevision(f.input.markdown), markdown: 'same new body' })
  documents.commit({ ...f.input, operationId: 'same-body', action: 'REFINE', expectedRevision: edited.revision, markdown: 'same new body' })
  assert.throws(() => documents.undo({ operationId: 'stale-undo', workspace, documentId: edited.documentId, revision: edited.revision!, usageVersion: edited.usageVersion }), /version/)
})


test('document commit and request revision notification share one durable transaction', t => {
  const f = fixture(t)
  f.db.exec('CREATE TABLE dispatch_version (value INTEGER); INSERT INTO dispatch_version VALUES(0)')
  const documents = openMemoryDocuments({ db: f.db, root: f.root, source: id => f.sources.get(id), onCommitted() {
    assert(f.db.isTransaction)
    f.db.prepare('UPDATE dispatch_version SET value=value+1').run()
  } })
  documents.commit(f.input)
  assert.equal(f.db.prepare('SELECT value FROM dispatch_version').get()?.value, 1)
  documents.commit(f.input)
  assert.equal(f.db.prepare('SELECT value FROM dispatch_version').get()?.value, 1)
})

test('a failed request-revision callback rolls back metadata and is replayed on recovery', t => {
  const f = fixture(t)
  f.db.exec('CREATE TABLE dispatch_version (value INTEGER); INSERT INTO dispatch_version VALUES(0)')
  const documents = openMemoryDocuments({ db: f.db, root: f.root, source: id => f.sources.get(id), onCommitted() {
    f.db.prepare('UPDATE dispatch_version SET value=value+1').run()
    throw new Error('dispatch-failed')
  } })
  assert.throws(() => documents.commit(f.input), /dispatch-failed/)
  assert.equal(documents.read(workspace, path), null)
  assert.equal(documents.receipt(workspace, 'create'), null)
  assert.equal(f.db.prepare('SELECT value FROM dispatch_version').get()?.value, 0)
  const resumed = openMemoryDocuments({ db: f.db, root: f.root, source: id => f.sources.get(id), onCommitted() {
    f.db.prepare('UPDATE dispatch_version SET value=value+1').run()
  } })
  assert(resumed.receipt(workspace, 'create'))
  assert.equal(f.db.prepare('SELECT value FROM dispatch_version').get()?.value, 1)
})

for (const point of ['intent', 'replace', 'receipt', 'checkpoint'] as const) {
  test(`killed process at ${point} recovers REFINE metadata and supports safe undo`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'memory-doc-process-'))
    let db: DatabaseSync | undefined
    t.after(() => { db?.close(); rmSync(root, { recursive: true, force: true }) })
    await runToCrash(new URL('./fixtures/memory-document-crash.ts', import.meta.url), point, root)
    db = new DatabaseSync(join(root, 'memory.db'))
    const documents = openMemoryDocuments({ db, root, source: () => ({ workspace, token: 'v1', text: '原来在深圳，现在搬到上海。' }) })
    const refined = documents.read(workspace, path)!
    assert.equal(refined.markdown, '上海')
    assert(documents.receipt(workspace, 'refine'))
    documents.undo({ operationId: 'undo', workspace, documentId: refined.id, revision: refined.revision, usageVersion: refined.usageVersion })
    assert.equal(documents.read(workspace, path)?.markdown, '深圳')
  })
}

test('a changed daily dependency cancels prepared digest recovery without advancing its receipt', t => {
  const f = fixture(t)
  const dailyPath = 'daily/2026-11-16.md'
  const journal = openMemoryFileJournal({ db: f.db, root: f.root, valid: () => true, finish: () => {} })
  const daily = journal.files(workspace).write(dailyPath, '原始日记', null)
  const documents = f.create(at => { if (at === 'intent') throw new Error('crash') })
  assert.throws(() => documents.commit({ ...f.input, files: [{ path: dailyPath, revision: daily.revision }] }), /crash/)
  journal.files(workspace).write(dailyPath, '日记已经改过', daily.revision)
  const resumed = f.create()
  assert.equal(resumed.read(workspace, path), null)
  assert.equal(resumed.receipt(workspace, f.input.operationId), null)
  assert.equal(existsSync(join(f.root, workspace, path)), false)
})

test('re-enabling a digest leaves a separately disabled digest unavailable', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const second = documents.commit({ ...f.input, operationId: 'clone', path: 'digest/wiki/home.md' })
  documents.setEnabled({ operationId: 'disable1', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion, enabled: false })
  documents.setEnabled({ operationId: 'disable2', workspace, documentId: second.documentId, expectedRevision: second.revision!, expectedUsageVersion: second.usageVersion, enabled: false })
  documents.setEnabled({ operationId: 'enable1', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion + 1, enabled: true })
  assert(documents.read(workspace, path))
  assert.equal(documents.read(workspace, second.path), null)
})




test('undo after restart skips usage changes to revert the semantic refinement', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const refined = documents.commit({ ...f.input, operationId: 'refine', action: 'REFINE', expectedRevision: first.revision, markdown: '上海', sources: [...f.input.sources, { id: 's2', token: 'v2' }] })
  const stopped = documents.setEnabled({ operationId: 'stop', workspace, documentId: first.documentId, expectedRevision: refined.revision!, expectedUsageVersion: refined.usageVersion, enabled: false })
  const reopened = f.create()
  assert.deepEqual(reopened.undoCandidate(workspace, first.documentId), { changeId: 'refine', revision: stopped.revision, usageVersion: stopped.usageVersion })
  reopened.undo({ operationId: 'undo', workspace, documentId: first.documentId, revision: stopped.revision!, usageVersion: stopped.usageVersion, expectedChangeId: 'refine' })
  assert.equal(reopened.undoCandidate(workspace, first.documentId), null)
  assert.equal(reopened.read(workspace, path, { includeDisabled: true })?.markdown, f.input.markdown)
  assert.equal(reopened.read(workspace, path), null)
})


test('undo candidates bind the latest semantic change, stop at undo and never expose old Markdown', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  assert.equal(documents.undoCandidate(workspace, first.documentId), null)
  const refine = documents.commit({ ...f.input, operationId: 'refine', action: 'REFINE', expectedRevision: first.revision, markdown: '# 居住地\n深圳市' })
  assert.deepEqual(documents.undoCandidate(workspace, first.documentId), { changeId: 'refine', revision: refine.revision, usageVersion: refine.usageVersion })
  const latest = documents.commit({ ...f.input, operationId: 'latest', action: 'REFINE', expectedRevision: refine.revision, markdown: '# 居住地\n深圳市常住' })
  const input = { operationId: 'undo-latest', workspace, documentId: first.documentId, revision: latest.revision!, usageVersion: latest.usageVersion, expectedChangeId: 'latest', expectedPolicyToken: 'policy-v1' }
  assert.throws(() => documents.undo({ ...input, expectedChangeId: 'refine' }), /change-version/)
  assert.deepEqual(documents.undoCandidate(workspace, first.documentId), { changeId: 'latest', revision: latest.revision, usageVersion: latest.usageVersion })
  const undone = documents.undo(input)
  assert.equal(documents.read(workspace, path)?.markdown, '# 居住地\n深圳市')
  const reopened = f.create()
  assert.deepEqual(reopened.undo(input), undone)
  assert.throws(() => reopened.undo({ ...input, expectedChangeId: 'refine' }), /input-mismatch/)
  assert.throws(() => reopened.undo({ ...input, expectedPolicyToken: 'policy-v2' }), /input-mismatch/)
  assert.equal(reopened.undoCandidate(workspace, first.documentId), null)
  assert.throws(() => reopened.undo({ ...input, operationId: 'undo-again', revision: undone.revision!, usageVersion: undone.usageVersion }), /undo-unavailable/)
  const stopped = reopened.setEnabled({ operationId: 'stop-after-undo', workspace, documentId: first.documentId, expectedRevision: undone.revision!, expectedUsageVersion: undone.usageVersion, enabled: false })
  assert.equal(reopened.undoCandidate(workspace, first.documentId), null)
  reopened.setEnabled({ operationId: 'enable-after-undo', workspace, documentId: first.documentId, expectedRevision: stopped.revision!, expectedUsageVersion: stopped.usageVersion, enabled: true })
  const next = reopened.commit({ ...f.input, operationId: 'new-edit', action: 'REFINE', expectedRevision: undone.revision, markdown: '深圳常住' })
  assert.deepEqual(reopened.undoCandidate(workspace, first.documentId), { changeId: 'new-edit', revision: next.revision, usageVersion: next.usageVersion })
})


test('setEnabled no-op has a durable input-bound receipt without a revision or commit notification', t => {
  const f = fixture(t)
  let commits = 0
  const documents = openMemoryDocuments({ db: f.db, root: f.root, source: id => f.sources.get(id),
    managementCurrent: (_, guard) => guard.policyToken === 'policy-v1', onCommitted: () => { commits++ } })
  const first = documents.commit(f.input)
  const input = { operationId: 'already-enabled', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion, enabled: true, expectedPolicyToken: 'policy-v1' }
  const receipt = documents.setEnabled(input)
  assert.equal(receipt.usageVersion, first.usageVersion)
  assert.equal(commits, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 1)
  const reopened = f.create()
  assert.deepEqual(reopened.receipt(workspace, input.operationId), receipt)
  assert.deepEqual(reopened.setEnabled(input), receipt)
  assert.throws(() => reopened.setEnabled({ ...input, expectedPolicyToken: 'policy-v2' }), /input-mismatch/)
  assert.throws(() => reopened.setEnabled({ ...input, enabled: false }), /input-mismatch/)
  const stopped = reopened.setEnabled({ ...input, operationId: 'stop', enabled: false })
  const same = reopened.setEnabled({ ...input, operationId: 'already-disabled', enabled: false, expectedUsageVersion: stopped.usageVersion })
  assert.equal(same.usageVersion, stopped.usageVersion)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 2)
})


for (const point of ['intent', 'receipt', 'checkpoint'] as const) {
  test(`setEnabled no-op ${point} crash recovers only its idempotent receipt`, t => {
    const f = fixture(t), initial = f.create().commit(f.input)
    const input = { operationId: 'no-op', workspace, documentId: initial.documentId, expectedRevision: initial.revision!, expectedUsageVersion: initial.usageVersion, enabled: true }
    let commits = 0
    const interrupted = openMemoryDocuments({ db: f.db, root: f.root, source: id => f.sources.get(id), onCommitted: () => { commits++ }, checkpoint: at => { if (at === point) throw new Error('crash') } })
    assert.throws(() => interrupted.setEnabled(input), /crash/)
    const resumed = openMemoryDocuments({ db: f.db, root: f.root, source: id => f.sources.get(id), onCommitted: () => { commits++ } })
    assert.equal(resumed.receipt(workspace, 'no-op')?.usageVersion, initial.usageVersion)
    assert.equal(resumed.setEnabled(input).usageVersion, initial.usageVersion)
    assert.equal(resumed.read(workspace, path)?.usageVersion, initial.usageVersion)
    assert.equal(commits, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 1)
  })
}

test('openMemoryDocuments refuses pre-v11 schemas before mutating tables or opening the journal', t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-documents-legacy-'))
  const dbs: DatabaseSync[] = []
  t.after(() => {
    for (const db of dbs) db.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const standaloneDb = new DatabaseSync(join(root, 'standalone.db'))
  dbs.push(standaloneDb)
  standaloneDb.exec(`CREATE TABLE memory_documents (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL,
    usage_version INTEGER NOT NULL, enabled INTEGER NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0,
    sources TEXT NOT NULL, corrections TEXT NOT NULL, UNIQUE(workspace,path)
  )`)
  assert.throws(
    () => openMemoryDocuments({ db: standaloneDb, root, source: () => undefined }),
    /incompatible contract version/,
  )
  assert.equal(
    standaloneDb.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_document_revisions'").get(),
    undefined,
  )

  const versionedDb = new DatabaseSync(join(root, 'versioned.db'))
  dbs.push(versionedDb)
  versionedDb.exec('PRAGMA user_version = 10')
  assert.throws(
    () => openMemoryDocuments({ db: versionedDb, root, source: () => undefined }),
    /incompatible contract version/,
  )
  assert.equal(
    versionedDb.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_documents'").get(),
    undefined,
  )
})
