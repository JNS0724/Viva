import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { traceLineHistory } from '../src/memory/core/memory-line-history.ts'
import { formatMemoryDocument } from '../src/memory/core/memory-document.ts'
import { createMemoryDocumentEvidence, createMemoryDocumentReadPolicy } from '../src/memory/core/memory-document-read-policy.ts'
import { createMemoryFileRetrieval } from '../src/memory/core/memory-file-retrieval.ts'
import { openMemoryStore, memoryHash } from '../src/memory/node/memory-store.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryFileIndex } from '../src/memory/node/memory-file-index.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { noteSource } from './fixtures/memory-note-fixture.ts'

test('traceLineHistory locates the exact revision that edited a section across unrelated later edits', () => {
  const v1 = [
    '---',
    'name: Project Alpha',
    'description: Release and testing rules',
    '---',
    '## Deploy',
    'Run manual deploy script.',
    '',
    '## Test',
    'Run unit tests only.',
  ].join('\n')

  const v2 = [
    '---',
    'name: Project Alpha',
    'description: Release and testing rules',
    '---',
    '## Deploy',
    'Deploy automatically via CI pipeline.',
    '',
    '## Test',
    'Run unit tests only.',
  ].join('\n')

  const v3 = [
    '---',
    'name: Project Alpha',
    'description: Release and testing rules',
    '---',
    '## Deploy',
    'Deploy automatically via CI pipeline.',
    '',
    '## Test',
    'Run unit and integration tests.',
    '',
    '## Sources',
    '- [[daily/2026-11-18.md]]',
  ].join('\n')

  const v4 = [
    '---',
    'name: Project Alpha',
    'description: Updated rules',
    '---',
    '## Deploy',
    'Deploy automatically via CI pipeline.',
    '',
    '## Test',
    'Run unit, integration, and smoke tests.',
    '',
    '## Sources',
    '- [[daily/2026-11-18.md]]',
    '- [[daily/2026-11-19.md]]',
  ].join('\n')

  // Newest-first revisions: v3->v4 (t=400), v2->v3 (t=300), v1->v2 (t=200).
  const revisions = [
    { at: 400, before: v3, after: v4 },
    { at: 300, before: v2, after: v3 },
    { at: 200, before: v1, after: v2 },
  ]

  // Lines 5-6 in v4 are "## Deploy\nDeploy automatically via CI pipeline."
  const deployChange = traceLineHistory(revisions, 5, 6)
  assert.deepEqual(deployChange, {
    at: 200,
    before: 'Run manual deploy script.',
    after: 'Deploy automatically via CI pipeline.',
  })

  // Lines 8-9 in v4 are "## Test\nRun unit, integration, and smoke tests."
  const testChange = traceLineHistory(revisions, 8, 9)
  assert.deepEqual(testChange, {
    at: 400,
    before: 'Run unit and integration tests.',
    after: 'Run unit, integration, and smoke tests.',
  })
})

test('traceLineHistory returns null for purely newly inserted sections and traces through appended bullets', () => {
  const v1 = '## Meeting\nRoom A on Friday.'
  const v2 = '## Meeting\nRoom B on Friday.'
  const v3 = '## Meeting\nRoom B on Friday.\nBring laptop.\n\n## Lunch\nOrder ramen.'

  const revisions = [
    { at: 300, before: v2, after: v3 },
    { at: 200, before: v1, after: v2 },
  ]

  // Newly inserted section "## Lunch\nOrder ramen." (lines 5-6) has no prior replaced text.
  assert.equal(traceLineHistory(revisions, 5, 6), null)

  // Appending "Bring laptop." to "## Meeting" (lines 1-3) still maps surviving lines back to v1->v2.
  assert.deepEqual(traceLineHistory(revisions, 1, 3), {
    at: 200,
    before: 'Room A on Friday.',
    after: 'Room B on Friday.',
  })
})

test('traceLineHistory captures interior deletions and clips long diffs to maxChars', () => {
  const before = '## Rules\nKeep staging frozen.\nRequire two reviewers.\nDeploy before 5pm.'
  const after = '## Rules\nKeep staging frozen.\nDeploy before 5pm.'
  assert.deepEqual(traceLineHistory([{ at: 100, before, after }], 1, 3), {
    at: 100,
    before: 'Require two reviewers.',
    after: '',
  })

  const clipped = traceLineHistory(
    [{ at: 100, before: 'Old ' + 'a'.repeat(50), after: 'New ' + 'b'.repeat(50) }],
    1,
    1,
    12,
  )
  assert.ok(clipped)
  assert.equal([...clipped.before].length, 12)
  assert.ok(clipped.before.endsWith('…'))
  assert.equal([...clipped.after].length, 12)
  assert.ok(clipped.after.endsWith('…'))
})

test('recall and read attach lineHistory for refined digests, survive disable/enable, stop on undo/withdrawal, and yield to maxChars budget', async t => {
  let now = Date.parse('2026-11-16T10:00:00Z')
  const store = openMemoryStore(':memory:', () => now)
  const readable = (id: string) => Boolean(store.readSource(id)?.text && !store.readSource(id)?.withdrawn)
  const notes = openMemoryNotes(store, readable)
  const documents = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    now: () => now,
    source(id) {
      const original = store.readSource(id)
      return original?.text && readable(id)
        ? { token: memorySourceToken(original), workspace: memorySourceWorkspace(original), text: original.text }
        : undefined
    },
  })
  const index = openMemoryFileIndex({ db: store.db })
  const evidence = createMemoryDocumentEvidence({
    notes,
    documents,
    hash: memoryHash,
    source: id => store.readSource(id) ?? undefined,
    readable,
    allowsText: () => true,
  })
  const policy = createMemoryDocumentReadPolicy({
    notes,
    documents,
    hash: memoryHash,
    ...evidence,
    reference: id => {
      const original = store.readSource(id)
      return original && readable(id) ? { namespace: 'canonical', sourceId: id, revision: original.version } : null
    },
  })
  const retrieval = createMemoryFileRetrieval({
    index,
    policy,
    workspaces: () => documents.workspaces(),
    hash: memoryHash,
    resolveId: (workspace, id) => documents.indexFile(workspace, id)?.path ?? null,
  })
  t.after(() => { retrieval.close(); store.close() })

  const addSrc = (text: string) => {
    const src = noteSource(store, { text, hash: memoryHash(text), length: text.length, at: now, timezone: 'UTC' })
    return { src, ref: { id: src.id, token: memorySourceToken(src) }, workspace: memorySourceWorkspace(src) }
  }

  const s1 = addSrc('Weekly sync is in Room Alpha.')
  const workspace = s1.workspace
  const path = 'digest/wiki/weekly-sync.md'
  const r1 = documents.commit({
    operationId: randomUUID(), workspace, path, action: 'CREATE', expectedRevision: null,
    markdown: formatMemoryDocument({
      metadata: { name: 'Weekly Sync', description: 'Meeting location and notes' },
      body: '## Location\nWeekly sync is in Room Alpha.\n\n## Notes\nBring status slides.',
    }),
    sources: [s1.ref], reads: [],
  })
  retrieval.sync()

  // Initial CREATE has no prior replaced text.
  const initialSearch = await retrieval.search({ query: 'Room Alpha', allows: () => true })
  assert.equal(initialSearch.hits.length, 1)
  assert.equal(initialSearch.hits[0]!.lineHistory, undefined)
  const initialRead = retrieval.read({ id: r1.documentId, allows: () => true })
  assert.equal(initialRead?.lineHistory, undefined)

  // REFINE updates Room Alpha -> Room Beta.
  now += 60_000
  const refineAt = now
  const s2 = addSrc('Weekly sync moved to Room Beta.')
  const r2 = documents.commit({
    operationId: randomUUID(), workspace, path, action: 'REFINE', expectedRevision: r1.revision,
    markdown: formatMemoryDocument({
      metadata: { name: 'Weekly Sync', description: 'Meeting location and notes' },
      body: '## Location\nWeekly sync moved to Room Beta.\n\n## Notes\nBring status slides.',
    }),
    sources: [s1.ref, s2.ref], reads: [],
  })

  // Unrelated REFINE edits "## Notes" only.
  now += 60_000
  const s3 = addSrc('Bring both status slides and Q4 metrics.')
  const r3 = documents.commit({
    operationId: randomUUID(), workspace, path, action: 'REFINE', expectedRevision: r2.revision,
    markdown: formatMemoryDocument({
      metadata: { name: 'Weekly Sync', description: 'Meeting location and notes' },
      body: '## Location\nWeekly sync moved to Room Beta.\n\n## Notes\nBring status slides and Q4 metrics.',
    }),
    sources: [s1.ref, s2.ref, s3.ref], reads: [],
  })
  retrieval.sync()

  // Searching for Room Beta traces past the unrelated Notes edit to r2's Location change.
  const refinedSearch = await retrieval.search({ query: 'Room Beta', allows: () => true })
  assert.equal(refinedSearch.hits.length, 1)
  assert.deepEqual(refinedSearch.hits[0]!.lineHistory, {
    at: refineAt,
    before: 'Weekly sync is in Room Alpha.',
    after: 'Weekly sync moved to Room Beta.',
  })

  // Targeted read on Location lines returns the exact Location change.
  const refinedRead = retrieval.read({ id: r3.documentId, startLine: 5, endLine: 6, allows: () => true })
  assert.deepEqual(refinedRead?.lineHistory, {
    at: refineAt,
    before: 'Weekly sync is in Room Alpha.',
    after: 'Weekly sync moved to Room Beta.',
  })

  // Budget safety: a tight maxChars drops optional lineHistory rather than dropping the hit.
  const withoutHistory = { ...refinedSearch.hits[0]! }
  delete withoutHistory.lineHistory
  const exactBudgetWithoutHistory = JSON.stringify({
    status: 'ok', hits: [withoutHistory], reasons: ['output-budget'], partial: true,
  }).length + 5
  const tightSearch = await retrieval.search({ query: 'Room Beta', maxChars: exactBudgetWithoutHistory, allows: () => true })
  assert.equal(tightSearch.hits.length, 1)
  assert.equal(tightSearch.hits[0]!.lineHistory, undefined)
  assert.ok(tightSearch.hits[0]!.text.includes('Room Beta'))

  // DISABLE -> ENABLE preserves continuity so lineHistory still works.
  const disabled = documents.setEnabled({
    operationId: randomUUID(), workspace, documentId: r3.documentId,
    expectedRevision: r3.revision!, expectedUsageVersion: r3.usageVersion, enabled: false,
  })
  const reenabled = documents.setEnabled({
    operationId: randomUUID(), workspace, documentId: r3.documentId,
    expectedRevision: disabled.revision!, expectedUsageVersion: disabled.usageVersion, enabled: true,
  })
  retrieval.sync()
  const afterToggle = retrieval.read({ id: r3.documentId, startLine: 5, endLine: 6, allows: () => true })
  assert.deepEqual(afterToggle?.lineHistory, {
    at: refineAt,
    before: 'Weekly sync is in Room Alpha.',
    after: 'Weekly sync moved to Room Beta.',
  })

  // UNDO stops the revision chain so undone content is never surfaced in lineHistory.
  documents.undo({
    operationId: randomUUID(), workspace, documentId: r3.documentId,
    revision: reenabled.revision!, usageVersion: reenabled.usageVersion,
  })
  retrieval.sync()
  const afterUndo = retrieval.read({ id: r3.documentId, startLine: 5, endLine: 6, allows: () => true })
  assert.equal(afterUndo?.lineHistory, undefined)

  // Withdrawing a source scrubs revision history cleanly with zero leak.
  documents.withdraw(s1.src.id)
  retrieval.sync()
  assert.equal(documents.revisionHistory?.(workspace, r3.documentId).length, 0)
})
