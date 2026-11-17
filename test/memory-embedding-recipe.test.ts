import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { memoryEmbeddingRecipe } from '../scripts/memory-embedding-recipe.ts'

test('release embedding recipe pins the validated multilingual Granite encoding and complete asset identity', () => {
  const recipe = memoryEmbeddingRecipe
  assert.equal(recipe.modelId, 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX')
  assert.equal(recipe.revision, '536a9f241cb3f02a9c5995a1e708c784bd274859')
  assert.equal(recipe.modelUrl, `https://huggingface.co/${recipe.modelId}/resolve/${recipe.revision}/`)
  assert.deepEqual(recipe.encoding, { dimensions: 384, maxTokens: 128, pooling: 'cls', queryPrefix: '', passagePrefix: '' })
  assert.equal(recipe.descriptor.manifest.files.length, 4)
  const weights = recipe.descriptor.manifest.files.find(file => file.path === 'onnx/model_quantized.onnx')
  assert.deepEqual(weights, { path: 'onnx/model_quantized.onnx', size: 97858099,
    sha256: '704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22' })
})

test('bundled model attribution includes the full official Apache 2.0 license and pinned upstream', () => {
  const license = readFileSync(new URL('../build/memory-embedding/model-license.txt', import.meta.url), 'utf8')
  const official = readFileSync(new URL('../scripts/licenses/Apache-2.0.txt', import.meta.url), 'utf8')
  assert.ok(license.endsWith(official))
  assert.ok(license.includes(memoryEmbeddingRecipe.modelId))
  assert.ok(license.includes(memoryEmbeddingRecipe.revision))
  assert.ok(license.includes('ibm-granite/granite-embedding-97m-multilingual-r2'))
  assert.ok(!license.includes('MIT License'))
})
