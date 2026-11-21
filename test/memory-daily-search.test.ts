import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dailySearchLimit, rankDailyMemory } from '../src/memory/core/memory-daily-search.ts'

test('dailySearchLimit clamps positive limits to configured bounds', () => {
  assert.equal(dailySearchLimit(1), 1)
  assert.equal(dailySearchLimit(999), 50)
})

test('rankDailyMemory fuses BM25 lexical rankings with semantic scores over RRF', () => {
  const lexical = { key: 'lexical', text: 'original' }
  const semantic = { key: 'semantic', text: 'preface '.repeat(20) + 'synonym' }
  const combined = { key: 'combined', text: 'original synonym' }
  const unrelated = { key: 'unrelated', text: 'something else' }
  const docs = [lexical, semantic, combined, unrelated]
  const scores = new Map<string, number>([
    [semantic.key, 1],
    [combined.key, 0.95],
    [lexical.key, 0.2],
  ])
  const fused = rankDailyMemory(docs, 'original', 3, 0, scores)
  assert.equal(fused.partial, false)
  assert.equal(fused.hits[0]?.document.key, combined.key)
  assert(fused.hits.some(hit => hit.document.key === semantic.key))
  assert(fused.hits.some(hit => hit.document.key === lexical.key))
})
