import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { scratch } from './scratch.js'
import { createMemoryEmbedder } from '../../src/memory/node/memory-embedder.ts'
import { writeMemoryEmbeddingManifest, type MemoryEmbeddingEncoding, type MemoryEmbeddingPooling } from '../../src/memory/node/memory-embedding-assets.ts'

type EmbeddingFixtureOptions = {
  dimensions?: number, maxTokens?: number, prefixes?: 'e5' | 'none', runtimeLimit?: number, behavior?: string, pooling?: MemoryEmbeddingPooling,
}

export async function prepareEmbeddingFixture(root: string, options: EmbeddingFixtureOptions = {}) {
  const modelRoot = path.join(root, 'model'), runtimeRoot = path.join(root, 'runtime')
  mkdirSync(path.join(modelRoot, 'onnx'), { recursive: true })
  writeFileSync(path.join(modelRoot, 'onnx/model_quantized.onnx'), 'test weights')
  writeFileSync(path.join(modelRoot, 'config.json'), JSON.stringify({ hidden_size: options.dimensions ?? 384,
    fixture_behavior: options.behavior, fixture_token_limit: options.runtimeLimit, fixture_pooling: options.pooling }))
  writeFileSync(path.join(modelRoot, 'tokenizer.json'), '{}')
  writeFileSync(path.join(modelRoot, 'tokenizer_config.json'), JSON.stringify({ model_max_length: options.runtimeLimit ?? 512 }))
  const dependency = path.join(runtimeRoot, 'node_modules', '@huggingface', 'transformers')
  mkdirSync(dependency, { recursive: true })
  // Node intentionally refuses TypeScript stripping inside node_modules. This package entry
  // points to the test-owned TS fixture outside it, rather than generating untyped JavaScript.
  writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ type: 'module', main: '../../../../fake-runtime.ts' }))
  copyFileSync(new URL('./memory-embedding-runtime.ts', import.meta.url), path.join(root, 'fake-runtime.ts'))
  const encoding: MemoryEmbeddingEncoding = { dimensions: options.dimensions ?? 384, maxTokens: options.maxTokens ?? 512, pooling: options.pooling ?? 'mean',
    queryPrefix: options.prefixes === 'none' ? '' : 'query: ',
    passagePrefix: options.prefixes === 'none' ? '' : 'passage: ' }
  const descriptor = await writeMemoryEmbeddingManifest(modelRoot, encoding)
  return { modelRoot, runtimeRoot, encoding, descriptor }
}

export async function embeddingFixture(t: TestContext, options: EmbeddingFixtureOptions = {}) {
  const { dir: root, defer } = scratch(t, 'viva-memory-embedding-')
  const { modelRoot, runtimeRoot, encoding, descriptor } = await prepareEmbeddingFixture(root, options)
  const open = (selectedModelRoot = modelRoot) => {
    const embedder = createMemoryEmbedder({ modelRoot: selectedModelRoot, runtimeRoot })
    defer(() => embedder.close())
    return embedder
  }
  return { root, modelRoot, runtimeRoot, encoding, descriptor, defer, open, embedder: open() }
}
