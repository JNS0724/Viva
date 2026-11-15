import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDailySemanticSearch, markdownSearchChunks, rankDailyMemory } from '../src/backend/memory-daily-search.ts'
import { createMemoryChannel } from '../src/backend/memory-channel.ts'
import { MEMORY_CONTRACT } from '../src/shared/memory-contract.ts'
import { randomUUID } from 'node:crypto'

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
    fingerprint: 'test',
    close() {},
    async embedBatch(inputs) {
      seen.push(...inputs.map(input => input.text))
      return inputs.map(({ text }) => Float32Array.from(text.includes('synonym') || text === 'original' ? [1, 0] : [0, 1]))
    },
  })
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

test('the DSH channel accepts complete daily replies above the legacy response guard', async () => {
  const channel = createMemoryChannel({ send: () => {}, handle: () => '' })
  channel.receive({ type: 'memory_ready', version: MEMORY_CONTRACT })
  const id = randomUUID()
  const request = { id, sourceId: randomUUID(), stage: 'note' as const, generation: 1,
    provider: 'test', model: 'test', system: '', input: '' }
  const text = 'note body '.repeat(2_005)
  const result = channel.compute(request)
  assert(result)
  channel.receive({ type: 'memory_computed', id, generation: 1, text })
  assert.equal(await result, text)
  const legacy = channel.compute({ ...request, stage: 'review' })
  assert(legacy)
  channel.receive({ type: 'memory_computed', id, generation: 1, text })
  await assert.rejects(legacy, { reason: 'oversize-reply' })
})
