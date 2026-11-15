import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_DIMENSIONS } from '../src/backend/memory-embedder.ts'
import type { MemoryEmbeddingResult, MemoryEmbedder } from '../src/backend/memory-embedder.ts'
import { openMemorySemanticIndex } from '../src/backend/memory-semantic.ts'
import { createMemorySemanticMaintenance } from '../src/backend/memory-semantic-maintenance.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'

const fingerprint = 'maintenance-test'
const unitVector = new Float32Array(MEMORY_EMBEDDING_DIMENSIONS)
unitVector[0] = 1

async function until(condition: () => boolean) {
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
    if (condition()) return
    await setTimeout(1)
  }
  assert.fail('semantic maintenance did not reach the expected state')
}

function fixture(t: TestContext, embedBatch: MemoryEmbedder['embedBatch']) {
  const store = openMemoryStore(':memory:')
  const index = openMemorySemanticIndex(store.db)!
  const held = new Set<number>()
  const validated = new Set<number>()
  let busy = false
  const maintenance = createMemorySemanticMaintenance({
    index: () => index, embedder: { fingerprint, embedBatch }, delayMs: 0,
    busy: () => busy,
    page(after, limit) {
      const refs = index.missingAfter(fingerprint, after, limit)
      return { entries: refs.flatMap(ref => {
        const row = store.get(ref.id)!
        return held.has(ref.id) ? [] : [{ ...ref, text: row.text === 'unindexed' ? null : row.text }]
      }), nextId: refs.length === limit ? refs.at(-1)!.id : null }
    },
    current: ref => {
      validated.add(ref.id)
      return !held.has(ref.id) && store.get(ref.id)?.revision === ref.revision
    },
  })
  t.after(() => { maintenance.close(); store.close() })
  return { index, maintenance, store, held, validated, focus() { busy = true }, idle() { busy = false },
    add(text: string) {
      const revision = store.nextRevision()
      const id = store.insert({ text, kind: 'fact', scope: { kind: 'user' }, modality: 'asserted',
        conditional: false, keywords: [], source: 'user', conversationId: null }, revision, Date.now(), { from: null, to: null })
      return { id, revision }
    } }
}

test('idle indexing drains multiple batches and rebuilds without a recall request', async t => {
  const calls: string[][] = []
  const { index, maintenance, add, validated, focus, idle } = fixture(t, async inputs => {
    calls.push(inputs.map(({ text }) => text))
    return inputs.map(() => unitVector)
  })
  const first = add('unindexed')
  for (let number = 0; number < 2 * MEMORY_EMBEDDING_BATCH; number++) add(`saved passage ${number}`)
  focus()
  maintenance.schedule()
  await setTimeout(10)
  assert.equal(calls.length, 0)
  idle()
  await until(() => validated.size === 2 * MEMORY_EMBEDDING_BATCH + 1)
  assert.ok(calls.every(batch => batch.length <= MEMORY_EMBEDDING_BATCH && !batch.includes('unindexed')))
  assert.deepEqual(index.missing(fingerprint, [first]), [])
  maintenance.reset()
  index.clear()
  validated.clear()
  maintenance.schedule()
  await until(() => validated.size === 2 * MEMORY_EMBEDDING_BATCH + 1)
  assert.deepEqual(index.missingAfter(fingerprint, 0), [])
})

test('background indexing drops stale or aborted work and rescans an earlier revision after concurrent changes', async t => {
  const pending: Array<{ signal: AbortSignal, finish: (value: MemoryEmbeddingResult) => void }> = []
  const { index, maintenance, store, add, held } = fixture(t, (_inputs, signal) => new Promise(resolve => {
    assert.ok(signal)
    pending.push({ signal, finish: resolve })
  }))
  const first = add('earliest')
  for (let number = 1; number < MEMORY_EMBEDDING_BATCH; number++) add(`saved passage ${number}`)
  const last = add('last')
  maintenance.schedule()
  await until(() => pending.length === 1)
  maintenance.pause()
  assert.equal(pending[0].signal.aborted, true)
  maintenance.schedule()
  await until(() => pending.length === 2)
  pending[0].finish(Array.from({ length: MEMORY_EMBEDDING_BATCH }, () => unitVector))
  assert.deepEqual(index.missing(fingerprint, [first]), [first])
  pending[1].finish(Array.from({ length: MEMORY_EMBEDDING_BATCH }, () => unitVector))
  await until(() => pending.length === 3)
  const revised = { id: first.id, revision: store.nextRevision() }
  store.touch(revised.id, revised.revision)
  held.add(last.id)
  maintenance.schedule(true)
  pending[2].finish([unitVector])
  await until(() => pending.length === 4)
  pending[3].finish([unitVector])
  await until(() => index.missing(fingerprint, [revised]).length === 0)
  assert.deepEqual(index.missing(fingerprint, [last]), [last])
})
