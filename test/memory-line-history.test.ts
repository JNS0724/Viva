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
