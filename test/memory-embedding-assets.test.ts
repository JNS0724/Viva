import assert from 'node:assert/strict'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createMemoryEmbedder } from '../src/memory/node/memory-embedder.ts'
import { MEMORY_EMBEDDING_MANIFEST, parseMemoryEmbeddingManifest, readMemoryEmbeddingDescriptor,
  verifyMemoryEmbeddingAssets, writeMemoryEmbeddingManifest } from '../src/memory/node/memory-embedding-assets.ts'
import { embeddingFixture } from './fixtures/memory-embedding-assets.ts'

const query = [{ kind: 'query', text: 'available fact' }] as const

test('asset identity follows weights and tokenizer contents, not installation paths', async t => {
  const fixture = await embeddingFixture(t)
  const copy = path.join(fixture.root, 'packaged-model')
  cpSync(fixture.modelRoot, copy, { recursive: true })
  assert.equal(readMemoryEmbeddingDescriptor(copy).fingerprint, fixture.descriptor.fingerprint)
  await verifyMemoryEmbeddingAssets(copy, fixture.descriptor)
  const packaged = createMemoryEmbedder({ modelRoot: copy, runtimeRoot: fixture.runtimeRoot })
  t.after(() => packaged.close())
  assert.ok(await packaged.embedBatch(query))
  writeFileSync(path.join(fixture.modelRoot, 'onnx/model_quantized.onnx'), 'new weights!')
  const weights = await writeMemoryEmbeddingManifest(fixture.modelRoot, fixture.encoding)
  assert.notEqual(weights.fingerprint, fixture.descriptor.fingerprint)
  assert.equal(weights.manifest.dimensions, fixture.descriptor.manifest.dimensions)
  writeFileSync(path.join(fixture.modelRoot, 'tokenizer.json'), '{"changed":true}')
  const tokenizer = await writeMemoryEmbeddingManifest(fixture.modelRoot, fixture.encoding)
  assert.notEqual(tokenizer.fingerprint, weights.fingerprint)
  assert.equal(fixture.embedder.fingerprint, fixture.descriptor.fingerprint)
  assert.equal(await fixture.embedder.embedBatch(query), null)
  assert.ok(await fixture.open().embedBatch(query))
})

test('manifest encoding parameters are part of the immutable vector identity', async t => {
  const { descriptor } = await embeddingFixture(t)
  const changes = [{ dimensions: 3 }, { maxTokens: 128 }, { pooling: 'cls' }, { queryPrefix: '', passagePrefix: '' }]
  for (const change of changes) assert.notEqual(parseMemoryEmbeddingManifest({ ...descriptor.manifest, ...change }).fingerprint, descriptor.fingerprint)
  assert.ok(Object.isFrozen(descriptor.manifest.files[0]))
  assert.ok(Object.isFrozen(descriptor.manifest))
})

test('strict manifests reject unknown fields, unsupported recipes and ambiguous asset paths', async t => {
  const { descriptor } = await embeddingFixture(t)
  const manifest = descriptor.manifest
  const bad = [{ ...manifest, extra: true }, { ...manifest, dimensions: 0 }, { ...manifest, maxTokens: 1.5 },
    { ...manifest, queryPrefix: '' }, { ...manifest, dtype: 'fp32' }, { ...manifest, pooling: 'last_token' },
    { ...manifest, files: [manifest.files[0], manifest.files[0], ...manifest.files.slice(2)] },
    { ...manifest, files: manifest.files.map((file, index) => index ? file : { ...file, path: '../config.json' }) }]
  for (const value of bad) assert.throws(() => parseMemoryEmbeddingManifest(value))
})

test('missing or malformed descriptor never claims the default model space', async t => {
  const fixture = await embeddingFixture(t)
  const file = path.join(fixture.modelRoot, MEMORY_EMBEDDING_MANIFEST)
  for (const value of [undefined, '{}', '{broken']) {
    if (value === undefined) rmSync(file)
    else writeFileSync(file, value)
    const embedder = fixture.open()
    assert.equal(embedder.dimensions, 0)
    assert.equal(embedder.fingerprint, 'memory-embedding-assets:unavailable')
    assert.equal(await embedder.embedBatch(query), null)
  }
})

test('worker rejects changed files and manifest hashes without authenticating vectors', async t => {
  for (const change of ['weights', 'manifest'] as const) await t.test(change, async t => {
    const fixture = await embeddingFixture(t)
    if (change === 'weights') writeFileSync(path.join(fixture.modelRoot, 'onnx/model_quantized.onnx'), 'wrong weights')
    else {
      const manifest = fixture.descriptor.manifest
      writeFileSync(path.join(fixture.modelRoot, MEMORY_EMBEDDING_MANIFEST), JSON.stringify({ ...manifest,
        files: manifest.files.map((file, index) => index ? file : { ...file, sha256: '0'.repeat(64) }) }))
    }
    await assert.rejects(verifyMemoryEmbeddingAssets(fixture.modelRoot, fixture.descriptor))
    assert.equal(await fixture.open().embedBatch(query), null)
  })
})

test('worker uses manifest pooling, dimensions, empty prefixes and conservative token budgets', async t => {
  const { embedder } = await embeddingFixture(t, { dimensions: 3, maxTokens: 2, runtimeLimit: 4, prefixes: 'none', pooling: 'cls' })
  const result = await embedder.embedBatch([...query, { kind: 'passage', text: 'supporting fact' }])
  assert.equal(embedder.dimensions, 3)
  assert.deepEqual(result?.map(row => row && [...row]), [[0, 0, 1], [0, 0, 1]])
})

test('worker refuses a declared token budget beyond the runtime truncation limit', async t => {
  const { embedder } = await embeddingFixture(t, { maxTokens: 4, runtimeLimit: 2 })
  assert.equal(await embedder.embedBatch(query), null)
})

test('worker authentication fails closed for load-time swaps and unauthenticated replies', async t => {
  for (const behavior of ['replace-on-load', 'wrong-ready', 'result-before-ready', 'wrong-width']) await t.test(behavior, async t => {
    const { embedder } = await embeddingFixture(t, { behavior })
    assert.equal(await embedder.embedBatch(query), null)
  })
})

test('parent refuses a mismatching result identity after successful worker authentication', async t => {
  const { embedder } = await embeddingFixture(t)
  assert.ok(await embedder.embedBatch(query))
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'wrong result identity' }]), null)
})

test('cache verification rejects undeclared runtime inputs and detects removed packaged descriptors', async t => {
  const fixture = await embeddingFixture(t)
  const extra = path.join(fixture.modelRoot, 'unexpected_config.json')
  writeFileSync(extra, '{}')
  await assert.rejects(verifyMemoryEmbeddingAssets(fixture.modelRoot, fixture.descriptor))
  rmSync(extra)
  const original = readFileSync(path.join(fixture.modelRoot, MEMORY_EMBEDDING_MANIFEST))
  rmSync(path.join(fixture.modelRoot, MEMORY_EMBEDDING_MANIFEST))
  await assert.rejects(verifyMemoryEmbeddingAssets(fixture.modelRoot, fixture.descriptor))
  writeFileSync(path.join(fixture.modelRoot, MEMORY_EMBEDDING_MANIFEST), original)
  await verifyMemoryEmbeddingAssets(fixture.modelRoot, fixture.descriptor)
})
