import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { memoryEmbeddingRecipe } from '../scripts/memory-embedding-recipe.ts'

test('release embedding recipe pins the validated multilingual MiniLM encoding and complete asset identity', () => {
  const recipe = memoryEmbeddingRecipe
  assert.equal(recipe.modelId, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2')
  assert.equal(recipe.revision, '2c4055b12046f11709e9df2c122e59ffbdc2f900')
  assert.equal(recipe.modelUrl, `https://huggingface.co/${recipe.modelId}/resolve/${recipe.revision}/`)
  assert.deepEqual(recipe.encoding, { dimensions: 384, maxTokens: 128, queryPrefix: '', passagePrefix: '' })
  assert.equal(recipe.descriptor.manifest.files.length, 4)
  const weights = recipe.descriptor.manifest.files.find(file => file.path === 'onnx/model_quantized.onnx')
  assert.deepEqual(weights, { path: 'onnx/model_quantized.onnx', size: 118308126,
    sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc' })
})

test('bundled model attribution includes the full official Apache 2.0 license and pinned upstream', () => {
  const license = readFileSync(new URL('../build/memory-embedding/model-license.txt', import.meta.url), 'utf8')
  const official = readFileSync(new URL('../scripts/licenses/Apache-2.0.txt', import.meta.url), 'utf8')
  assert.ok(license.endsWith(official))
  assert.ok(license.includes(memoryEmbeddingRecipe.modelId))
  assert.ok(license.includes(memoryEmbeddingRecipe.revision))
  assert.ok(license.includes('sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'))
  assert.ok(!license.includes('MIT License'))
})
