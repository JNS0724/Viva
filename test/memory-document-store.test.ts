import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryFileJournal } from '../src/memory/node/memory-file-journal.ts'
import type { FileCheckpoint } from '../src/memory/node/memory-file-journal.ts'
import { memoryFileRevision } from '../src/memory/node/memory-file-store.ts'
import type { DocumentCommit, DocumentSourceRef } from '../src/memory/core/ports/documents.ts'

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

test('locator cleanup replays a body-free intent and keeps exact historical undo available', t => {
  const f = fixture(t), documents = f.create()
  documents.commit(f.input)
  const independent = { ...f.input, path: 'digest/wiki/tea.md', sources: [{ id: 's1', token: 'v1', spans: [{ start: 5, end: 10 }] }] }
  const title = `Tea links to [[${path}]] once.`
  const first = documents.commit({ ...independent, operationId: 'tea', markdown: title })
  const edited = documents.commit({ ...independent, operationId: 'tea-update', expectedRevision: first.revision,
    markdown: `Tea links to [[${path}]] twice.`, action: 'REFINE' })
  documents.eraseSource({ ...f.input.sources[0]!, spans: [{ start: 0, end: 5 }], version: 1, length: 11, hash: 'first' })
  const disk = join(f.root, workspace, independent.path)
  let interrupted = false
  assert.throws(() => f.create((point, changed) => {
    if (point === 'replace' && changed === independent.path) { interrupted = true; throw new Error('locator crash') }
  }), /locator crash/)
  assert.ok(interrupted)
  assert.ok(!readFileSync(disk, 'utf8').includes(path))
  const pending = f.db.prepare("SELECT plan FROM memory_file_intents WHERE id LIKE 'documents:locators:%' AND plan IS NOT NULL").get()
  assert.ok(pending)
  assert.ok(!String(pending.plan).includes(path))

  const resumed = f.create(), current = resumed.read(workspace, independent.path)!
  assert.equal(current.revision, memoryFileRevision(readFileSync(disk, 'utf8')))
  assert.equal(current.usageVersion, edited.usageVersion)
  assert.equal(resumed.pendingCleanup(), 0)
  assert.ok(!JSON.stringify(f.db.prepare("SELECT before,after FROM memory_document_revisions WHERE document=?").all(current.id)).includes(path))
  const undo = resumed.undo({ operationId: 'tea-undo', workspace, documentId: current.id, revision: current.revision, usageVersion: current.usageVersion })
  const projected = resumed.projectErasedLocators(workspace, title)
  assert.equal(readFileSync(disk, 'utf8'), projected)
  assert.equal(undo.revision, memoryFileRevision(projected))
})

test('a third physical revision keeps locator cleanup pending and does not clobber external content', t => {
  const f = fixture(t), documents = f.create()
  documents.commit(f.input)
  const independent = { ...f.input, path: 'digest/wiki/tea.md', sources: [{ id: 's1', token: 'v1', spans: [{ start: 5, end: 10 }] }] }
  const markdown = `Tea [[${path}]]`
  documents.commit({ ...independent, operationId: 'tea', markdown })
  documents.eraseSource({ ...f.input.sources[0]!, spans: [{ start: 0, end: 5 }], version: 1, length: 10, hash: 'first' })
  const disk = join(f.root, workspace, independent.path)
  let started = false
  assert.throws(() => f.create(point => {
    if (point === 'intent' && f.db.prepare("SELECT 1 FROM memory_file_intents WHERE id LIKE 'documents:locators:%' AND plan IS NOT NULL").get()) {
      started = true; throw new Error('locator crash')
    }
  }), /locator crash/)
  assert.ok(started)
  const external = `${markdown}\nVisible only on disk.`
  writeFileSync(disk, external)
  const resumed = f.create()
  assert.equal(readFileSync(disk, 'utf8'), external)
  assert.equal(resumed.read(workspace, independent.path), null)
  assert.ok(resumed.pendingCleanup() > 0)
  writeFileSync(disk, markdown)
  resumed.recover()
  assert.ok(!readFileSync(disk, 'utf8').includes(path))
  assert.equal(resumed.pendingCleanup(), 0)
})

test('retired paths stay unavailable, and independent evidence can use and link a fresh path', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const nextSource = { id: 's2', token: 'v2' }
  const updated = documents.commit({ ...f.input, operationId: 'update', expectedRevision: first.revision, action: 'REFINE',
    markdown: 'Shanghai with older information retained.', sources: [...f.input.sources, nextSource] })
  documents.eraseSource({ ...nextSource, version: 1, length: f.sources.get('s2')!.text.length, hash: 'next',
    spans: [{ start: 0, end: f.sources.get('s2')!.text.length }] })
  const recovered = f.create()
  assert.ok(recovered.locatorRetired(workspace, path))
  assert.ok(!JSON.stringify(f.db.prepare('SELECT before,after FROM memory_document_revisions WHERE document=?').all(updated.documentId)).includes(path))
  assert.throws(() => recovered.commit({ ...f.input, operationId: 'fresh', markdown: 'Independent evidence' }), /document-unavailable/)
  const fresh = recovered.commit({ ...f.input, operationId: 'fresh', path: 'digest/personal/home-2.md', markdown: 'Independent evidence' })
  assert.ok(recovered.commit({ ...f.input, operationId: 'linked', path: 'digest/personal/linked.md', markdown: `Fresh reference [[${fresh.path}]]` }))
  assert.equal(recovered.pendingCleanup(), 0)
})

test('CORRECT persists exact old fragment; undo creates a revision and does not cover later edits', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const snapshot = documents.read(workspace, path)!
  const correction: DocumentCommit = { ...f.input, operationId: 'correct', action: 'CORRECT', expectedRevision: first.revision,
    markdown: '# 居住地\n上海', sources: [...snapshot.sources, { id: 's2', token: 'v2' }], reads: [snapshot],
    corrections: [{ path, revision: snapshot.revision, startLine: 2, endLine: 2, text: '深圳', condition: '主要居住地', time: '搬家后' }] }
  const corrected = documents.commit(correction)
  assert.equal(documents.supersessions(workspace, path).length, 1)
  const restored = f.create().undo({ operationId: 'undo', workspace, documentId: first.documentId, revision: corrected.revision!, usageVersion: corrected.usageVersion })
  assert.equal(documents.read(workspace, path)?.markdown, f.input.markdown)
  assert.equal(documents.supersessions(workspace, path).length, 0)
  assert.equal(restored.usageVersion, 3)
  assert.throws(() => documents.undo({ operationId: 'late', workspace, documentId: first.documentId, revision: corrected.revision!, usageVersion: corrected.usageVersion }), /version/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM memory_document_revisions').get()?.n, 3)
})

test('invalid correction or changed source cannot commit; external edits are quarantined', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  assert.throws(() => documents.commit({ ...f.input, operationId: 'bad', action: 'CORRECT', expectedRevision: first.revision, markdown: 'new' }), /correction-required/)
  f.sources.set('s1', { workspace, token: 'changed', text: 'changed' })
  assert.equal(documents.read(workspace, path), null)
  f.sources.set('s1', { workspace, token: 'v1', text: '我住深圳。我喜欢茶。' })
  writeFileSync(join(f.root, workspace, path), 'unverified external edit')
  assert.equal(documents.read(workspace, path), null)
  assert.throws(() => documents.commit({ ...f.input, operationId: 'overwrite', action: 'REFINE', expectedRevision: first.revision }), /unavailable/)
})

test('disable propagates through exact source spans without blocking unrelated text or independent new sources', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const clone = documents.commit({ ...f.input, operationId: 'clone', path: 'digest/wiki/home.md' })
  const tea = documents.commit({ ...f.input, operationId: 'tea', path: 'digest/wiki/tea.md', markdown: '喜欢茶', sources: [{ id: 's1', token: 'v1', spans: [{ start: 5, end: 10 }] }] })
  documents.setEnabled({ operationId: 'disable', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion, enabled: false })
  assert.equal(documents.read(workspace, path), null)
  assert.equal(documents.read(workspace, clone.path), null)
  assert(documents.read(workspace, tea.path))
  assert.throws(() => documents.commit({ ...f.input, operationId: 'copy-disabled', path: 'digest/wiki/another.md' }), /source-version/)
  f.sources.set('independent', { workspace, token: 'new', text: '我住深圳。' })
  assert(documents.commit({ ...f.input, operationId: 'new-input', path: 'digest/wiki/new.md', sources: [{ id: 'independent', token: 'new' }] }))
  documents.setEnabled({ operationId: 'enable', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion + 1, enabled: true })
  assert(documents.read(workspace, clone.path))
})

test('withdraw stages cleanup inside transaction and erases history and pending clarification bodies', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  documents.defer({ operationId: 'question', workspace, unit: { name: '居住地', bucket: 'personal', summary: '深圳', paths: ['daily/2026-11-16.md'] }, reason: '哪里', sources: f.input.sources, reads: [], files: [] })
  f.sources.delete('s1')
  f.db.exec('BEGIN IMMEDIATE')
  documents.withdraw('s1')
  f.db.exec('COMMIT')
  assert.equal(documents.read(workspace, path), null)
  assert(documents.hasPendingCleanup('s1'))
  assert.equal(documents.pending(workspace).length, 0)
  assert.throws(() => documents.undo({ operationId: 'undo-deleted', workspace, documentId: first.documentId, revision: first.revision!, usageVersion: first.usageVersion }), /version/)
  const revisions = f.db.prepare('SELECT before,after FROM memory_document_revisions').all()
  assert(revisions.every(row => row.before === null && row.after === null))
  documents.recover()
  assert.equal(documents.hasPendingCleanup('s1'), false)
  assert.equal(existsSync(join(f.root, workspace, path)), false)
  assert.equal(f.db.prepare('SELECT payload FROM memory_document_deferred').get()?.payload, null)
})

test('withdrawing the source of a correction quotation erases it without removing an independent replacement', t => {
  const f = fixture(t), documents = f.create()
  const marker = 'Old private quotation text'
  const original = documents.commit({ ...f.input, markdown: marker })
  const target = 'digest/wiki/current.md', current = 'Shanghai is the new home'
  const replacement = documents.commit({ ...f.input, operationId: 'new-file', path: target, markdown: 'Checking the new address',
    sources: [{ id: 's2', token: 'v2' }] })
  documents.commit({ ...f.input, operationId: 'correct-external', path: target, action: 'CORRECT', expectedRevision: replacement.revision,
    markdown: current, sources: [{ id: 's2', token: 'v2' }],
    corrections: [{ path, revision: original.revision!, startLine: 1, endLine: 1, text: marker, condition: 'Confidential condition', time: 'Private timeframe' }] })
  const supersession = documents.supersessions(workspace, path)[0]!
  assert.equal(supersession.text, marker)
  assert.equal(supersession.anchorSources, undefined)
  assert.deepEqual(documents.supersessions(workspace, path, { includeEvidence: true })[0]?.anchorSources, f.input.sources)
  assert.equal(documents.undoCandidate(workspace, replacement.documentId)?.changeId, 'correct-external')
  const snapshot = documents.read(workspace, target)!
  const work = documents.defer({ operationId: 'deferred-after-correction', workspace, reason: 'Confidential condition',
    unit: { name: 'Address', bucket: 'personal', summary: 'Check the address', paths: [] },
    reads: [snapshot], files: [], sources: snapshot.sources })
  assert.deepEqual(work.reads, [{ id: snapshot.id, revision: snapshot.revision, usageVersion: snapshot.usageVersion }])
  assert.doesNotMatch(String(f.db.prepare('SELECT payload FROM memory_document_deferred').get()?.payload), /Old private quotation text/)
  f.sources.delete('s1')
  documents.withdraw('s1')
  const reopened = f.create()
  assert.equal(reopened.read(workspace, target)?.markdown, current)
  assert.equal(reopened.acceptedSnapshot(workspace, replacement.documentId)?.markdown, current)
  assert.equal(reopened.undoCandidate(workspace, replacement.documentId), null)
  assert.equal(reopened.deferred(workspace, work.operationId), null)
  assert.equal(f.db.prepare('SELECT payload FROM memory_document_deferred').get()?.payload, null)
  const tombstone = reopened.supersessions(workspace, path)[0]!
  assert.equal(tombstone.sourceDocumentId, original.documentId)
  assert.deepEqual([tombstone.text, tombstone.time, tombstone.condition], ['', '', ''])
  assert.equal(reopened.read(workspace, path), null)
  assert.equal(reopened.pendingCleanup(), 0)
  const replicas = JSON.stringify([
    f.db.prepare('SELECT * FROM memory_documents').all(),
    f.db.prepare('SELECT * FROM memory_document_revisions').all(),
    f.db.prepare('SELECT plan FROM memory_file_intents').all(),
  ])
  assert.doesNotMatch(replicas, /Old private quotation text|Confidential condition|Private timeframe/)
})

test('deferred work only resumes on a current idempotent answer; changed nodes expire old questions', t => {
  const f = fixture(t), documents = f.create()
  documents.commit(f.input)
  const snapshot = documents.read(workspace, path)!
  documents.defer({ operationId: 'question', workspace, unit: { name: '居住地', bucket: 'personal', summary: '深圳', paths: ['daily/2026-11-16.md'] }, reason: '哪里', sources: f.input.sources, reads: [snapshot], files: [] })
  assert.equal(documents.pending(workspace)[0]?.status, 'pending_clarification')
  const answer = { operationId: 'answer', workspace, deferredId: 'question', source: { id: 's2', token: 'v2' }, text: '更正：我搬到上海了。' }
  assert.equal(documents.answer(answer).status, 'ready')
  assert.deepEqual(documents.answer(answer), documents.answer(answer))
  assert.throws(() => documents.answer({ ...answer, text: '北京' }), /input-mismatch/)
  documents.commit({ ...f.input, operationId: 'refine', action: 'REFINE', expectedRevision: snapshot.revision, markdown: '# 地点\n深圳' })
  assert.equal(documents.deferred(workspace, 'question'), null)
  assert.throws(() => documents.answer({ ...answer, operationId: 'later' }), /expired/)
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

test('withdraw erases unpublished plan replicas and stages a pending CREATE for durable purge', t => {
  const f = fixture(t)
  const documents = f.create(at => { if (at === 'replace') throw new Error('crash') })
  assert.throws(() => documents.commit(f.input), /crash/)
  assert(existsSync(join(f.root, workspace, path)))
  f.sources.delete('s1')
  f.db.exec('BEGIN IMMEDIATE')
  documents.withdraw('s1')
  f.db.exec('COMMIT')
  assert(documents.hasPendingCleanup('s1'))
  assert(documents.pendingCleanup() > 0)
  assert.equal(f.db.prepare("SELECT plan FROM memory_file_intents WHERE namespace='documents'").get()?.plan, null)
  const resumed = f.create()
  assert.equal(resumed.pendingCleanup(), 0)
  assert.equal(existsSync(join(f.root, workspace, path)), false)
  assert.equal(resumed.read(workspace, path), null)
  assert.throws(() => resumed.commit(f.input), /unavailable/)
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
  test(`killed process at ${point} recovers CORRECT metadata and supports safe undo`, t => {
    const root = mkdtempSync(join(tmpdir(), 'memory-doc-process-'))
    let db: DatabaseSync | undefined
    t.after(() => { db?.close(); rmSync(root, { recursive: true, force: true }) })
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/memory-document-crash.ts', import.meta.url)), root, point], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    assert.equal(result.signal, 'SIGKILL', result.stderr)
    db = new DatabaseSync(join(root, 'memory.db'))
    const documents = openMemoryDocuments({ db, root, source: () => ({ workspace, token: 'v1', text: '原来在深圳，现在搬到上海。' }) })
    const corrected = documents.read(workspace, path)!
    assert.equal(corrected.markdown, '上海')
    assert.equal(documents.supersessions(workspace, path).length, 1)
    assert(documents.receipt(workspace, 'correct'))
    documents.undo({ operationId: 'undo', workspace, documentId: corrected.id, revision: corrected.revision, usageVersion: corrected.usageVersion })
    assert.equal(documents.read(workspace, path)?.markdown, '深圳')
    assert.equal(documents.supersessions(workspace, path).length, 0)
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

test('clarification becomes resolved atomically with its resulting digest revision', t => {
  const f = fixture(t), documents = f.create()
  documents.commit(f.input)
  const before = documents.read(workspace, path)!
  documents.defer({ operationId: 'resolution', workspace, unit: { name: '位置', bucket: 'personal', summary: '地点', paths: ['daily/2026-11-16.md'] }, reason: '位置不清楚', sources: f.input.sources, reads: [before], files: [] })
  documents.answer({ operationId: 'answer', workspace, deferredId: 'resolution', source: { id: 's2', token: 'v2' }, text: '更正：我搬到上海了。' })
  documents.commit({ ...f.input, operationId: 'resolution', action: 'REFINE', expectedRevision: before.revision, markdown: '明确的新位置', sources: [...before.sources, { id: 's2', token: 'v2' }], reads: [before] })
  documents.resolve(workspace, 'resolution')
  documents.resolve(workspace, 'resolution')
  assert.equal(documents.pending(workspace).length, 0)
  assert.equal(f.db.prepare("SELECT state FROM memory_document_deferred WHERE operation='resolution'").get()?.state, 'resolved')
})

test('tag failures remain durable terminal attempts and are erased with their document', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const attempt = { operationId: 'tag', workspace, path, revision: first.revision!, state: 'attempted' as const }
  documents.recordTagAttempt(attempt)
  documents.recordTagAttempt({ ...attempt, state: 'failed', reason: 'invalid-output' })
  assert.equal(f.create().tagAttempt(workspace, 'tag')?.state, 'failed')
  assert.throws(() => documents.recordTagAttempt({ ...attempt, state: 'completed' }), /terminal/)
  f.sources.delete('s1')
  documents.withdraw('s1')
  documents.recover()
  assert.equal(documents.tagAttempt(workspace, 'tag'), null)
})

test('enabling one restriction keeps an independent overlapping restriction active', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const second = documents.commit({ ...f.input, operationId: 'clone', path: 'digest/wiki/home.md' })
  documents.setEnabled({ operationId: 'disable1', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion, enabled: false })
  documents.setEnabled({ operationId: 'disable2', workspace, documentId: second.documentId, expectedRevision: second.revision!, expectedUsageVersion: second.usageVersion, enabled: false })
  documents.setEnabled({ operationId: 'enable1', workspace, documentId: first.documentId, expectedRevision: first.revision!, expectedUsageVersion: first.usageVersion + 1, enabled: true })
  assert.equal(documents.read(workspace, path), null)
  assert(documents.read(workspace, path, { includeDisabled: true }))
})

test('a follow-up clarification consumes the prior answer atomically and preserves its provenance', t => {
  const f = fixture(t), documents = f.create()
  const original = { operationId: 'first-question', workspace, unit: { name: '位置', bucket: 'personal' as const, summary: '位置不清楚', paths: ['daily/2026-11-16.md'] }, reason: '哪里', sources: f.input.sources, reads: [], files: [] }
  documents.defer(original)
  documents.answer({ operationId: 'first-answer', workspace, deferredId: original.operationId, source: { id: 's2', token: 'v2' }, text: '更正：我搬到上海了。' })
  const followup = { ...original, operationId: 'followup', reason: '何时搬家', sources: [...original.sources, { id: 's2', token: 'v2' }] }
  assert.equal(documents.defer(followup, original.operationId).status, 'pending_clarification')
  assert.equal(documents.deferred(workspace, original.operationId), null)
  assert.deepEqual(documents.defer(followup, original.operationId), documents.deferred(workspace, followup.operationId))
  assert.equal(documents.pending(workspace).length, 1)
  assert.throws(() => documents.answer({ operationId: 'old-answer-again', workspace, deferredId: original.operationId, source: { id: 's2', token: 'v2' }, text: '更正：我搬到上海了。' }), /expired/)
})

test('Auto Tag can only change entity tags, never content or provenance', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  assert.throws(() => documents.commit({ ...f.input, operationId: 'tag-body', action: 'TAG', expectedRevision: first.revision, markdown: '---\nmemory_tags: [上海]\n---\n上海' }), /tag-content-change/)
  const tagged = documents.commit({ ...f.input, operationId: 'tag-safe', action: 'TAG', expectedRevision: first.revision, markdown: '---\nmemory_tags: [深圳]\n---\n' + f.input.markdown })
  assert.equal(documents.read(workspace, path)?.revision, tagged.revision)
})

for (const point of ['intent', 'replace'] as const) test(`forgetting an abandoned ${point} draft preserves the independently sourced committed version`, t => {
  const f = fixture(t)
  const first = f.create().commit(f.input)
  const documents = f.create(at => { if (at === point) throw new Error('crash') })
  assert.throws(() => documents.commit({ ...f.input, operationId: 'abandoned', action: 'REFINE', expectedRevision: first.revision, markdown: '新草稿上海', sources: [...f.input.sources, { id: 's2', token: 'v2' }] }), /crash/)
  f.sources.delete('s2')
  documents.withdraw('s2')
  assert(documents.hasPendingCleanup('s2'))
  assert.equal(f.db.prepare("SELECT plan FROM memory_file_intents WHERE id='documents:abandoned'").get()?.plan, null)
  const resumed = f.create()
  assert.equal(resumed.read(workspace, path)?.markdown, f.input.markdown)
  assert.equal(resumed.read(workspace, path)?.id, first.documentId)
  assert.equal(resumed.hasPendingCleanup('s2'), false)
  assert.equal(f.db.prepare('SELECT forgotten FROM memory_documents WHERE id=?').get(first.documentId)?.forgotten, 0)
})

test('withdrawing a prepared CREATE dependency preserves an external third hash and keeps cleanup pending', t => {
  const f = fixture(t), documents = f.create()
  const original = documents.commit(f.input), old = documents.read(workspace, path)!
  const pendingPath = 'digest/personal/pending.md'
  const interrupted = f.create(at => { if (at === 'intent') throw new Error('crash') })
  assert.throws(() => interrupted.commit({ ...f.input, operationId: 'pending-create', path: pendingPath, markdown: 'Prepared document',
    sources: [{ id: 's2', token: 'v2' }], reads: [old] }), /crash/)
  const foreign = join(f.root, workspace, pendingPath)
  writeFileSync(foreign, 'Independent external document')
  f.sources.delete('s1')
  interrupted.withdraw('s1')
  const reopened = f.create()
  assert.equal(reopened.receipt(workspace, original.operationId)?.documentId, original.documentId)
  assert.equal(reopened.read(workspace, pendingPath), null)
  assert.equal(readFileSync(foreign, 'utf8'), 'Independent external document')
  assert.equal(reopened.hasPendingCleanup('s1'), true)
  rmSync(foreign)
  reopened.recover()
  assert.equal(reopened.hasPendingCleanup('s1'), false)
})

test('an external conflict during abandoned-draft restoration remains pending without blocking unrelated documents', t => {
  const f = fixture(t)
  const first = f.create().commit(f.input)
  const documents = f.create(at => { if (at === 'intent') throw new Error('crash') })
  assert.throws(() => documents.commit({ ...f.input, operationId: 'abandoned', action: 'REFINE', expectedRevision: first.revision, markdown: '新草稿', sources: [...f.input.sources, { id: 's2', token: 'v2' }] }), /crash/)
  f.sources.delete('s2')
  documents.withdraw('s2')
  writeFileSync(join(f.root, workspace, path), 'external conflicting content')
  const resumed = f.create()
  assert(resumed.hasPendingCleanup('s2'))
  assert.equal(resumed.read(workspace, path), null)
  assert.equal(readFileSync(join(f.root, workspace, path), 'utf8'), 'external conflicting content')
  const another = resumed.commit({ ...f.input, operationId: 'unrelated', path: 'digest/wiki/unrelated.md' })
  assert(another)
})

test('undo after restart skips automatic tags and usage changes to revert the semantic correction', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const corrected = documents.commit({ ...f.input, operationId: 'correct', action: 'CORRECT', expectedRevision: first.revision, markdown: '上海', sources: [...f.input.sources, { id: 's2', token: 'v2' }], corrections: [{ path, revision: first.revision!, startLine: 2, endLine: 2, text: '深圳', condition: '居住地', time: '搬家后' }] })
  const current = documents.read(workspace, path)!
  const tagged = documents.commit({ operationId: 'tag', workspace, path, action: 'TAG', expectedRevision: corrected.revision, markdown: '---\nmemory_tags: [上海]\n---\n上海', sources: current.sources, reads: [current] })
  const stopped = documents.setEnabled({ operationId: 'stop', workspace, documentId: first.documentId, expectedRevision: tagged.revision!, expectedUsageVersion: tagged.usageVersion, enabled: false })
  const reopened = f.create()
  assert.deepEqual(reopened.undoCandidate(workspace, first.documentId), { changeId: 'correct', revision: stopped.revision, usageVersion: stopped.usageVersion })
  reopened.undo({ operationId: 'undo', workspace, documentId: first.documentId, revision: stopped.revision!, usageVersion: stopped.usageVersion, expectedChangeId: 'correct' })
  assert.equal(reopened.undoCandidate(workspace, first.documentId), null)
  assert.equal(reopened.read(workspace, path, { includeDisabled: true })?.markdown, f.input.markdown)
  assert.equal(reopened.read(workspace, path), null)
  assert.deepEqual(reopened.supersessions(workspace, path), [])
})

test('a locked WAL keeps replica cleanup pending until a later checkpoint succeeds', t => {
  const f = fixture(t)
  f.db.exec('PRAGMA journal_mode=WAL')
  const documents = f.create()
  documents.commit(f.input)
  const reader = new DatabaseSync(join(f.root, 'memory.db'))
  try {
    reader.exec('BEGIN')
    reader.prepare('SELECT * FROM memory_documents').all()
    f.sources.delete('s1')
    documents.withdraw('s1')
    documents.recover()
    assert.equal(existsSync(join(f.root, workspace, path)), false)
    assert(documents.hasPendingCleanup('s1'))
    assert(documents.pendingCleanup() > 0)
    reader.exec('COMMIT')
    documents.recover()
    assert.equal(documents.hasPendingCleanup('s1'), false)
    assert.equal(documents.pendingCleanup(), 0)
  } finally { reader.close() }
})

test('policy expiration needs no commit receipt, is idempotent and cannot expire another workspace or resolved work', t => {
  const f = fixture(t), documents = f.create()
  documents.commit(f.input)
  const before = documents.read(workspace, path)!
  const proposal = { operationId: 'policy-question', workspace,
    unit: { name: '位置', bucket: 'personal' as const, summary: '地点', paths: ['daily/2026-11-16.md'] },
    reason: '需要确认', sources: f.input.sources, reads: [before], files: [] }
  documents.defer(proposal)
  documents.expire(memoryFileRevision('other'), proposal.operationId)
  assert.equal(documents.deferred(workspace, proposal.operationId)?.status, 'pending_clarification')
  documents.expire(workspace, proposal.operationId)
  documents.expire(workspace, proposal.operationId)
  assert.equal(documents.deferred(workspace, proposal.operationId), null)
  assert.equal(documents.receipt(workspace, proposal.operationId), null)
  assert.equal(f.db.prepare('SELECT state,payload FROM memory_document_deferred WHERE operation=?').get(proposal.operationId)?.state, 'expired')

  documents.defer({ ...proposal, operationId: 'ready-question' })
  documents.answer({ operationId: 'ready-answer', workspace, deferredId: 'ready-question', source: { id: 's2', token: 'v2' }, text: '更正：我搬到上海了。' })
  documents.expire(workspace, 'ready-question')
  assert.equal(documents.deferred(workspace, 'ready-question'), null)
  assert.throws(() => documents.resolve(workspace, 'ready-question'), /expired/)

  documents.defer({ ...proposal, operationId: 'completed-question' })
  documents.answer({ operationId: 'completed-answer', workspace, deferredId: 'completed-question', source: { id: 's2', token: 'v2' }, text: '更正：我搬到上海了。' })
  documents.commit({ ...f.input, operationId: 'completed-question', action: 'REFINE', expectedRevision: before.revision,
    markdown: '明确的新位置', sources: [...before.sources, { id: 's2', token: 'v2' }], reads: [before] })
  documents.expire(workspace, 'completed-question')
  assert.equal(f.db.prepare("SELECT state FROM memory_document_deferred WHERE operation='completed-question'").get()?.state, 'resolved')
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

test('undo candidates disappear for foreign workspaces, stale sources, quarantined files and forgotten history', t => {
  const f = fixture(t), documents = f.create()
  const first = documents.commit(f.input)
  const edit = documents.commit({ ...f.input, operationId: 'edit', action: 'REFINE', expectedRevision: first.revision, markdown: '深圳市' })
  assert(documents.undoCandidate(workspace, first.documentId))
  assert.equal(documents.undoCandidate(memoryFileRevision('foreign'), first.documentId), null)
  const source = f.sources.get('s1')!
  f.sources.set('s1', { ...source, token: 'new-version' })
  assert.equal(documents.undoCandidate(workspace, first.documentId), null)
  f.sources.set('s1', source)
  writeFileSync(join(f.root, workspace, path), 'unverified')
  assert.equal(documents.undoCandidate(workspace, first.documentId), null)
  writeFileSync(join(f.root, workspace, path), '深圳市')
  assert.equal(documents.undoCandidate(workspace, first.documentId)?.revision, edit.revision)
  f.sources.delete('s1')
  documents.withdraw('s1')
  documents.recover()
  assert.equal(f.create().undoCandidate(workspace, first.documentId), null)
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
