import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDailySemanticSearch, markdownSearchChunks, rankDailyMemory } from '../src/memory/core/memory-daily-search.ts'
import { createHash } from 'node:crypto'

test('daily Markdown chunks cover the full document and keep the original line boundaries', () => {
  const intro = ['# 前言', ...Array.from({ length: 16 }, () => '汉字'.repeat(100)), ''].join('\n')
  const ending = '# Decisions\n' + 'Here is the final decision. '.repeat(16).trim()
  const text = intro + '\n' + ending
  const chunks = markdownSearchChunks(text)
  assert.equal(chunks.length, 2)
  assert.equal(chunks.at(-1)?.text, ending)
  const lines = text.split('\n')
  for (const chunk of chunks) {
    assert.equal(chunk.text, lines.slice(chunk.startLine - 1, chunk.endLine).join('\n'))
    assert(Buffer.byteLength(chunk.text) <= 10_000)
  }
})

test('semantic search embeds the tail, reuses current vectors and fuses over BM25', async () => {
  const seen: string[] = []
  const search = createDailySemanticSearch({
    fingerprint: 'test', dimensions: 2,
    close() {},
    async embedBatch(inputs) {
      seen.push(...inputs.map(input => input.text))
      return inputs.map(({ text }) => Float32Array.from(text.includes('synonym') || text === 'original' ? [1, 0] : [0, 1]))
    },
  }, text => createHash('sha256').update(text).digest('hex'))
  const lexical = { key: 'lexical', text: 'original' }
  const semantic = { key: 'semantic', text: 'preface '.repeat(400) + 'synonym' }
  const combined = { key: 'combined', text: 'original synonym' }
  const unrelated = { key: 'unrelated', text: 'something else' }
  const docs = [lexical, semantic, combined, unrelated]
  const signal = new AbortController().signal
  const first = await search.rank(docs, 'original', signal)
  assert.equal(first.incomplete, false)
  assert(seen.some(text => text.endsWith('synonym') && text !== combined.text))
  assert.equal(first.scores.get(semantic.key), 1)
  const fused = rankDailyMemory(docs, 'original', 3, 0, first.scores)
  assert(fused.hits.some(hit => hit.document.key === semantic.key))
  assert(fused.hits.some(hit => hit.document.key === lexical.key))
  const calls = seen.length
  await search.rank(docs, 'original', signal)
  assert.equal(seen.length, calls + 1)
  search.clear()
  await search.rank(docs, 'original', signal)
  assert(seen.length > calls + 2)
})


test('indexed-only file chunks never fall back to cached or new embeddings while legacy facts still do', async () => {
  const calls: Array<{ kind: string, text: string }> = []
  const search = createDailySemanticSearch({ fingerprint: 'test', dimensions: 2, close() {}, async embedBatch(inputs) {
    calls.push(...inputs); return inputs.map(() => Float32Array.of(1, 0))
  } }, text => text)
  const file = { key: 'file:accepted-v1', text: 'file body' }, legacy = { key: 'memory:1', text: 'legacy body' }
  const signal = new AbortController().signal
  // A stale in-process vector must not satisfy an explicitly index-only file lookup.
  await search.rank([file], 'question', signal)
  calls.length = 0
  const result = await search.rank([file, legacy], 'question', signal, {
    indexed: () => new Map(), indexedOnly: new Set([file.key]), scores: new Map([[file.key, 0.9]]),
  })
  assert.equal(result.incomplete, true)
  assert.equal(result.scores.has(file.key), false)
  assert.equal(result.scores.get(legacy.key), 1)
  assert.deepEqual(calls.filter(input => input.kind === 'passage').map(input => input.text), ['legacy body'])
})

test('indexed-only scores reuse the persisted lane without invoking passage embedding', async () => {
  const calls: string[] = []
  const search = createDailySemanticSearch({ fingerprint: 'test', dimensions: 2, close() {}, async embedBatch(inputs) {
    calls.push(...inputs.map(input => input.kind)); return inputs.map(() => Float32Array.of(1, 0))
  } }, text => text)
  const file = { key: 'file:accepted-v2', text: 'safe body' }
  const result = await search.rank([file], 'question', new AbortController().signal, {
    indexed: () => new Map([[file.key, 0.81]]), indexedOnly: new Set([file.key]),
  })
  assert.deepEqual(calls, ['query'])
  assert.equal(result.incomplete, false)
  assert.equal(result.scores.get(file.key), 0.81)
})
