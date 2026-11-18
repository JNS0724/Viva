import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relevantMemoryFileLanes, fuseMemoryFileHits, selectMemoryFileHits, memoryFileChunkKey } from '../src/memory/core/memory-file-ranking.ts'
import type { MemoryFileHit } from '../src/memory/core/ports/file-index.ts'

function hit(id: string, ordinal = 0, workspace = 'one', score = 100): MemoryFileHit {
  const version = { revision: 'r1', usageVersion: 1, policyToken: 'policy' }
  return { ref: { workspace, fileId: id, ordinal, ...version }, file: { workspace, id, path: `digest/${id}.md`, kind: 'digest', updatedAt: 1, sources: [], ...version },
    text: `${id}:${ordinal}`, searchText: `${id}:${ordinal}`, headingPath: [], startLine: ordinal + 1, endLine: ordinal + 1, startOffset: ordinal, endOffset: ordinal + 1, score }
}
const keys = (hits: readonly MemoryFileHit[]) => hits.map(item => memoryFileChunkKey(item.ref))

test('single-lane and fused scores use the same fixed weighted reciprocal-rank units', () => {
  const first = hit('a', 0, 'one', 999), second = hit('b', 0, 'one', -99)
  const lexical = fuseMemoryFileHits([first, second], [])
  const vector = fuseMemoryFileHits([], [first, second])
  assert.ok(Math.abs(lexical[0]!.score - 0.3 / 61) < 1e-15)
  assert.equal(vector[0]!.score, 0.7 / 61)
  assert.equal(vector[1]!.score, 0.7 / 62)
  assert.equal(fuseMemoryFileHits([first], [first])[0]!.score, lexical[0]!.score + vector[0]!.score)
  assert.deepEqual(lexical.map(item => item.ranks), [{ lexical: 1 }, { lexical: 2 }])
  assert.deepEqual(vector.map(item => item.ranks), [{ vector: 1 }, { vector: 2 }])
})

test('same-lane duplicates neither gain weight nor consume rank and full references include workspace and versions', () => {
  const a = hit('a'), b = hit('b'), scope = hit('a', 0, 'two')
  const version = { ...a, ref: { ...a.ref, revision: 'r2' } }
  const ranked = fuseMemoryFileHits([a, a, b, scope, version, b], [a, a])
  assert.equal(ranked.length, 4)
  assert.deepEqual(ranked.find(item => item.ref.fileId === 'b')!.ranks, { lexical: 2 })
  assert.deepEqual(ranked.find(item => item.ref.workspace === 'two')!.ranks, { lexical: 3 })
  assert.deepEqual(ranked.find(item => item.ref.revision === 'r2')!.ranks, { lexical: 4 })
  assert.deepEqual(ranked[0]!.ranks, { vector: 1, lexical: 1 })
})

test('appending shared tail noise cannot displace either surviving lane leader from a multi-result selection', () => {
  const lexical = hit('lexical-leader'), vector = hit('vector-leader')
  const noise = Array.from({ length: 24 }, (_, index) => hit(`noise-${index}`))
  const ranked = fuseMemoryFileHits([lexical, ...noise], [vector, ...noise])
  assert.ok(ranked.findIndex(item => item.ref.fileId === 'lexical-leader') > 1, 'the regression must exercise a low RRF lexical-only leader')
  const selected = selectMemoryFileHits(ranked, { limit: 2 })
  assert.deepEqual(new Set(selected.map(item => item.ref.fileId)), new Set(['lexical-leader', 'vector-leader']))
  assert.deepEqual(selectMemoryFileHits(ranked, { limit: 1 }), [ranked[0]])
  assert.ok(selected[0]!.score >= selected[1]!.score, 'anchors retain their original RRF order')
})

test('a shared lane leader occupies one slot and remaining slots favor distinct scoped files', () => {
  const shared = hit('long', 0), more = Array.from({ length: 8 }, (_, index) => hit('long', index + 1))
  const other = hit('other'), sameIdOtherScope = hit('long', 0, 'two')
  const ranked = fuseMemoryFileHits([shared, ...more, other, sameIdOtherScope], [shared, ...more, other, sameIdOtherScope])
  const selected = selectMemoryFileHits(ranked, { limit: 4 })
  assert.deepEqual(keys(selected), keys([shared, other, sameIdOtherScope, more[0]!]))
})

test('lane coverage takes priority over document diversity when the leaders are different chunks of one file', () => {
  const first = hit('long', 0), second = hit('long', 1), other = hit('other')
  const ranked = fuseMemoryFileHits([first, other, second], [second, other, first])
  const selected = selectMemoryFileHits(ranked, { limit: 2 })
  assert.deepEqual(new Set(keys(selected)), new Set(keys([first, second])))
})

test('threshold and seen filtering happen before each lane chooses its next eligible leader', () => {
  const lexical = hit('lexical'), vector = hit('vector'), shared = hit('shared'), next = hit('next')
  const ranked = fuseMemoryFileHits([lexical, shared, next], [vector, shared, next])
  const minScore = 0.01
  const seen = new Set([memoryFileChunkKey(shared.ref)])
  const selected = selectMemoryFileHits(ranked, { limit: 2, minScore, seen })
  assert.deepEqual(new Set(selected.map(item => item.ref.fileId)), new Set(['vector', 'next']))
  assert.ok(selected.every(item => item.score >= minScore))
  assert.deepEqual(selectMemoryFileHits(ranked, { limit: 5, minScore: 1 }), [])
})

test('selection is deterministic, immutable and fills spare slots with remaining chunks only after unique files', () => {
  const lane = [hit('b'), hit('b', 1), hit('a'), hit('a', 1)]
  const ranked = fuseMemoryFileHits(lane, [])
  const before = JSON.stringify(ranked)
  const selected = selectMemoryFileHits(ranked, { limit: 10 })
  assert.deepEqual(keys(selected), keys([lane[0]!, lane[2]!, lane[1]!, lane[3]!]))
  assert.deepEqual(selectMemoryFileHits(ranked, { limit: 10 }), selected)
  assert.equal(JSON.stringify(ranked), before)
})

test('semantic contrast admits a distinct near-threshold match only with a reference and an absolute floor', () => {
  const eligible = (...scores: number[]) => relevantMemoryFileLanes('query', [], scores.map((score, i) => hit(String(i), 0, 'one', score))).vector.map(hit => hit.score)
  assert.deepEqual(eligible(0.81), [])
  assert.deepEqual(eligible(0.82, 0.81, 0.81, 0.80, 0.80, 0.799, 0.798, 0.797, 0.796, 0.795), [])
  assert.deepEqual(eligible(0.82, 0.805, 0.79, 0.78, 0.775, 0.77, 0.76, 0.755, 0.75, 0.747), [0.82, 0.805])
  assert.deepEqual(eligible(0.76, 0.72, 0.70, 0.68, 0.61, 0.60, 0.59, 0.58, 0.57, 0.56), [])
})
