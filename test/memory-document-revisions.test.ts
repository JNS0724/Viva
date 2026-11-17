import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as shared from './fixtures/memory-document-store.ts'
import type { FileCheckpoint, DocumentCommit, DocumentSourceRef } from './fixtures/memory-document-store.ts'

const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, join, tmpdir, openMemoryDocuments, openMemoryFileJournal, memoryFileRevision, runToCrash, workspace, path, fixture } = shared

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
