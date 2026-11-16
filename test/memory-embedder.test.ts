import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_EMBEDDING_DIMENSIONS } from '../src/memory/node/memory-embedder.ts'
import { embeddingFixture } from './fixtures/memory-embedding-assets.ts'

test('local worker keeps each prefix and rejects overlong rows without losing the rest of the batch', async t => {
  const { embedder } = await embeddingFixture(t)
  assert.equal(embedder.dimensions, MEMORY_EMBEDDING_DIMENSIONS)
  const result = await embedder.embedBatch([{ kind: 'query', text: 'look up a fact' },
    { kind: 'passage', text: 'too long to embed completely' }, { kind: 'passage', text: 'available fact' }])
  assert.ok(result)
  assert.equal(result.length, 3)
  assert.equal(result[0]?.length, MEMORY_EMBEDDING_DIMENSIONS)
  assert.equal(result[0]?.[0], 1)
  assert.equal(result[1], null)
  assert.equal(result[2]?.length, MEMORY_EMBEDDING_DIMENSIONS)
  assert.equal(result[2]?.[1], 1)
})

test('closing a failed local worker leaves the caller alive and further requests fall back', async t => {
  const { embedder } = await embeddingFixture(t)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'stop worker' }]), null)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'fall back during the cooldown' }]), null)
  embedder.close()
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'closed' }]), null)
})

test('aborting a pending embedding retires that worker and lets a new request run', async t => {
  const { embedder } = await embeddingFixture(t)
  const controller = new AbortController()
  const pending = embedder.embedBatch([{ kind: 'query', text: 'hang worker' }], controller.signal)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'busy' }]), null)
  controller.abort()
  assert.equal(await pending, null)
  const result = await embedder.embedBatch([{ kind: 'query', text: 'retry after abort' }])
  assert.equal(result?.[0]?.[0], 1)
})
