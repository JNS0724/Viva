import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { auditEvaluationResult, checkEvaluationFreeze, checkValidationFreeze, dataPolicy } from '../scripts/memory-file-evaluation.ts'
import { memoryDocumentLines } from '../src/memory/core/memory-document.ts'
import type { FileSearchResult } from '../src/memory/core/memory-file-retrieval.ts'
import type { EvaluationDocument } from './fixtures/memory-file-evaluation.ts'

test('retrieval evaluation datasets remain frozen without running or scoring a model', () => {
  assert.equal(checkEvaluationFreeze(), '6ecd696d0a55bcce97bf7a84ba0ef7273b79c44810b3d99a5adf0a2e15ce7ba6')
  assert.equal(checkValidationFreeze().dataHash, '3b13352e07f49e59328c40f662701209f704dc4bcb61c4b89fcc80ba3623d402')
})

test('evaluation admission resolves daily supersession by logical identity rather than fixture ID', () => {
  const documents: EvaluationDocument[] = [
    { id: 'old-daily', name: 'Old instruction', body: 'The meeting starts at nine.', kind: 'daily', day: '2026-11-16', scope: 'public', state: 'active' },
    { id: 'new-digest', name: 'Current instruction', body: 'The meeting now starts at ten.', kind: 'digest', scope: 'public', state: 'active',
      supersedes: { id: 'old-daily', quote: 'The meeting starts at nine.' } },
  ]
  const workspace = createHash('sha256').update('holdout-workspace:public').digest('hex')
  const { policy } = dataPolicy(documents)
  const old = policy.read(workspace, 'daily/2026-11-16/old-daily.md')
  assert.ok(old)
  assert.equal(old.applicability.supersessions[0]?.documentId, 'new-digest')
  assert.ok(!old.currentMarkdown?.includes('The meeting starts at nine.'))
  assert.match(policy.read(workspace, 'digest/wiki/new-digest.md')!.currentMarkdown!, /starts at ten/)
})

test('evaluation audits service text and every exposed identity even without forbidden query labels', () => {
  const { policy } = dataPolicy([{ id: 'public', name: 'Public', body: 'An authorized observation.', kind: 'digest', scope: 'public', state: 'active' }])
  const workspace = createHash('sha256').update('holdout-workspace:public').digest('hex')
  const views = policy.list(workspace), view = views[0]!
  const result: FileSearchResult = { status: 'ok', hits: [{
    id: view.id, workspace, path: view.path, revision: view.revision,
    text: view.currentMarkdown!, startLine: 1, endLine: memoryDocumentLines(view.currentMarkdown!).length,
    score: 0.01, applicability: { state: 'current', supersessions: [] },
  }], files: [{ id: view.id, workspace, path: view.path, revision: view.revision, usageVersion: view.usageVersion, policyToken: view.policyToken, sourceRanges: view.sourceTokens.map(({ id: sourceId, spans }) => ({ sourceId, ...(spans ? { spans } : {}) })) }],
    sourceIds: view.sourceTokens.map(item => item.id), reasons: [], partial: false }
  assert.deepEqual(auditEvaluationResult(result, views), { unauthorized: [], invalidSlices: [] })
  assert.deepEqual(auditEvaluationResult({ ...result, hits: [{ ...result.hits[0]!, text: 'Invented evidence at the same valid locator.' }] }, views).invalidSlices, [view.id])
  const corrupted: FileSearchResult = { ...result,
    files: [{ ...result.files[0]!, id: 'secret', workspace: 'private' }], sourceIds: ['secret-source'],
  }
  const problems = auditEvaluationResult(corrupted, views).unauthorized
  for (const issue of ['dependency:secret', 'source:secret-source']) assert.ok(problems.includes(issue))
  assert.deepEqual(auditEvaluationResult({ ...result, files: [], sourceIds: [] }, views).unauthorized,
    ['missing-dependency:public', 'missing-source:source:public'])
  const forgedProjection: FileSearchResult = { ...result, hits: [{ ...result.hits[0]!,
    applicability: { state: 'current', supersessions: [{ startLine: 1, endLine: 1, condition: 'Injected condition',
      replacement: { id: 'secret', path: 'digest/private.md', revision: 'secret', state: 'current' } }] },
  }] }
  assert.deepEqual(auditEvaluationResult(forgedProjection, views).unauthorized, ['applicability:public'])
})
