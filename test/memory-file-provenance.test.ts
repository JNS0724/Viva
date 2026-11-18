import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryDispatch, needsMemoryTransport, MemoryDispatchConflict } from '../src/memory/core/memory-dispatch.ts'
import { createMemoryCoordination } from '../src/memory/core/coordination.ts'
import { combineMemoryProvenance, memoryErasureEvidence, intersectsMemoryErasure, memoryProvenanceSchema } from '../src/memory/contracts/provenance.ts'
import { parseHostMemoryCommand } from '../src/memory/contracts/host.ts'
import type { MemoryFileDependency, MemoryProvenance } from '../src/memory/contracts/records.ts'

const file: MemoryFileDependency = { workspace: 'a'.repeat(64), id: 'node', path: 'digest/wiki/report.md',
  revision: 'body-v1', usageVersion: 1, policyToken: 'policy-v1', sourceRanges: [{ sourceId: 'file-source' }] }
const evidence = (files?: MemoryFileDependency[]): MemoryProvenance => ({ sources: [], turnOnly: false, epoch: 0,
  ...(files ? { files } : {}) })

test('file provenance merges exact scope, content and policy snapshots without erasing stale reads', () => {
  const sameOtherScope = { ...file, workspace: 'b'.repeat(64) }
  const changedPolicy = { ...file, policyToken: 'policy-v2' }
  const reordered: MemoryFileDependency = { policyToken: file.policyToken, usageVersion: file.usageVersion,
    revision: file.revision, path: file.path, id: file.id, workspace: file.workspace, sourceRanges: file.sourceRanges }
  assert.deepEqual(combineMemoryProvenance(evidence([file]), evidence([reordered, sameOtherScope, changedPolicy])).files,
    [reordered, sameOtherScope, changedPolicy])
  assert.deepEqual(combineMemoryProvenance(evidence(), evidence()), evidence())
  assert.equal(Object.hasOwn(memoryProvenanceSchema.parse(evidence()), 'files'), false)
  assert.throws(() => memoryProvenanceSchema.parse({ ...evidence(), dependencies: [] }), 'the removed fact payload is rejected even when empty')
  assert.equal(needsMemoryTransport(evidence([file])), true)
  assert.equal(needsMemoryTransport(evidence()), false)
})

test('trusted IPC preserves file dependencies and strictly rejects malformed or unknown file fields', () => {
  const input = { args: ['target', evidence([file]), null, true] }
  assert.deepEqual(parseHostMemoryCommand('transfer', input).input, { args: ['target', evidence([file]), undefined, true] })
  const alias = { operationId: 'op', sourceId: 'source', session: 'session', conversation: 'conversation',
    text: 'Derived summary', origin: 'derived', dependencies: evidence([file]) }
  assert.deepEqual(parseHostMemoryCommand('sourceAlias', alias).input, alias)
  const invalid: unknown[] = [null, { ...file, workspace: '../other' }, { ...file, path: '../secret' },
    { ...file, path: '/absolute.md' }, { ...file, id: '' }, { ...file, revision: '' },
    { ...file, usageVersion: -1 }, { ...file, usageVersion: 0.5 }, { ...file, usageVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...file, policyToken: '' }, { ...file, markdown: 'untrusted content' }]
  for (const ref of invalid) assert.throws(() => parseHostMemoryCommand('transfer', { args: ['target', { ...evidence(), files: [ref] }, null, true] }))
})

test('persistent dispatch keeps file reads across attach, forks and restart without adding empty fields', t => {
  const { dir } = scratch(t, 'memory-file-dispatch-'), database = join(dir, 'memory.db')
  let store = openMemoryStore(database)
  try {
    const dispatch = createMemoryDispatch(store, () => true, () => true)
    assert.equal(Object.hasOwn(dispatch.snapshot('empty'), 'files'), false)
    const refs = [file, { ...file, workspace: 'b'.repeat(64) }, { ...file, usageVersion: 2 }]
    dispatch.recordFiles('parent', [...refs, file])
    dispatch.inherit('parent', 'fork')
    dispatch.attach('derived', JSON.parse(JSON.stringify(dispatch.snapshot('fork'))) as MemoryProvenance)
    store.close(); store = openMemoryStore(database)
    const restored = createMemoryDispatch(store, () => true)
    for (const session of ['parent', 'fork', 'derived']) {
      assert.deepEqual(restored.snapshot(session).files, refs)
      assert.equal(restored.admission(session).allowed, false, 'missing file validator must fail closed after recovery')
      assert.equal(restored.transferable(restored.snapshot(session)), false)
    }
    assert.equal(restored.admission('empty').allowed, true)
  } finally { store.close() }
})

test('file policy changes invalidate admissions, inherited contexts and active leases independently of fact/source/epoch checks', () => {
  const store = openMemoryStore(':memory:')
  try {
    let policy = file.policyToken
    const dispatch = createMemoryDispatch(store, () => true, refs => refs.every(ref => ref.policyToken === policy))
    dispatch.recordFiles('read', [file]); dispatch.inherit('read', 'child')
    const admitted = dispatch.admission('read'), clean = dispatch.admission('clean')
    assert(admitted.allowed && clean.allowed)
    dispatch.acquireSession('affected', 'read', admitted, () => true)
    dispatch.acquireSession('unrelated', 'clean', clean, () => true)
    policy = 'disabled-or-superseded'
    assert.equal(dispatch.stale('read'), true)
    assert.equal(dispatch.stale('child'), true)
    assert.equal(dispatch.transferable(dispatch.snapshot('read')), false)
    assert.throws(dispatch.validateCommit, error => error instanceof MemoryDispatchConflict && error.requests.join() === 'affected')
    dispatch.release('affected'); assert.doesNotThrow(dispatch.validateCommit)
    assert.deepEqual(dispatch.snapshot('read').files, [file], 'invalid dependencies must remain, never silently become empty')
  } finally { store.close() }
})

test('file-bearing foreground and background contexts both require a physical memory transport', () => {
  const store = openMemoryStore(':memory:')
  try {
    const dispatch = createMemoryDispatch(store, () => true, () => true)
    dispatch.recordFiles('file-only', [file])
    const coordinator = createMemoryCoordination({ dispatch: () => dispatch, runtime: () => ({
      busy: () => false, sourceCurrent: () => true, allowedHistory: () => true, staleSession: () => false,
      sessionProject: () => undefined, recordSessionProject() {}, projectAllows: () => true,
      computeAdmission: () => null,
    }) })
    assert.equal(coordinator.allowsTransport('file-only', undefined, false, false), false)
    assert.equal(coordinator.allowsTransport('file-only', undefined, false, true), false)
    assert.equal(coordinator.allowsTransport('file-only', undefined, true, false), true)
    assert.equal(coordinator.transferStatus(dispatch.snapshot('file-only'), undefined, false), 'memory-unavailable')
  } finally { store.close() }
})


test('raw use wins when file-only provenance joins a context that also saw the whole source', () => {
  const raw = { ...evidence(), sources: ['mixed'] }
  const proved = { ...file, sourceRanges: [{ sourceId: 'mixed' }, { sourceId: 'only-file' }] }
  const bound = { ...evidence([proved]), sources: ['mixed', 'only-file'], fileSources: ['mixed', 'only-file'] }
  for (const result of [combineMemoryProvenance(raw, bound), combineMemoryProvenance(bound, raw)]) {
    assert.deepEqual(result.fileSources, ['only-file'])
    assert.deepEqual(result.files, [proved])
    assert.deepEqual(result.sources, ['mixed', 'only-file'])
  }
  assert.throws(() => memoryProvenanceSchema.parse({ ...bound, files: [] }))
  assert.throws(() => memoryProvenanceSchema.parse({ ...bound, sources: ['other'] }))
})


test('incomplete file proof retains whole-source erasure dependencies and is rejected before dispatch storage', () => {
  const id = 'shared-source'
  const complete = { ...file, sourceRanges: [{ sourceId: id, spans: [{ start: 20, end: 30 }] }] }
  const disjoint = { ...evidence([complete]), sources: [id], fileSources: [id] }
  const cut = [{ sourceId: id, spans: [{ start: 0, end: 10 }] }]
  assert.equal(intersectsMemoryErasure(memoryErasureEvidence(disjoint), cut), false)
  const store = openMemoryStore(':memory:')
  try {
    const { sourceRanges: _ranges, ...missing } = file
    for (const files of [[missing], [{ ...file, sourceRanges: [] }], [missing, complete], [{ ...file, sourceRanges: [{ sourceId: 'unrelated' }] }]]) {
      const incomplete = { ...disjoint, files } as MemoryProvenance
      assert.throws(() => memoryProvenanceSchema.parse(incomplete))
      assert.equal(intersectsMemoryErasure(memoryErasureEvidence(incomplete), cut), true)
      assert.throws(() => store.dispatch.files('rejected', incomplete.files!, [id]))
      assert.deepEqual(store.dispatch.snapshot('rejected').sources, [])
    }
    store.dispatch.files('accepted', [complete], [id])
    assert.deepEqual(store.dispatch.snapshot('accepted').fileSources, [id])
  } finally { store.close() }
})
