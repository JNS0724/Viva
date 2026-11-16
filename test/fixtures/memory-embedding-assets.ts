import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { createMemoryEmbedder } from '../../src/memory/node/memory-embedder.ts'
import { writeMemoryEmbeddingManifest } from '../../src/memory/node/memory-embedding-assets.ts'

export async function embeddingFixture(t: TestContext, options: {
  dimensions?: number, maxTokens?: number, prefixes?: 'e5' | 'none', runtimeLimit?: number, behavior?: string,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'viva-memory-embedding-'))
  const modelRoot = path.join(root, 'model'), runtimeRoot = path.join(root, 'runtime')
  mkdirSync(path.join(modelRoot, 'onnx'), { recursive: true })
  writeFileSync(path.join(modelRoot, 'onnx/model_quantized.onnx'), 'test weights')
  writeFileSync(path.join(modelRoot, 'config.json'), JSON.stringify({ hidden_size: options.dimensions ?? 384,
    fixture_behavior: options.behavior, fixture_token_limit: options.runtimeLimit }))
  writeFileSync(path.join(modelRoot, 'tokenizer.json'), '{}')
  writeFileSync(path.join(modelRoot, 'tokenizer_config.json'), JSON.stringify({ model_max_length: options.runtimeLimit ?? 512 }))
  const dependency = path.join(runtimeRoot, 'node_modules', '@huggingface', 'transformers')
  mkdirSync(dependency, { recursive: true })
  // Node intentionally refuses TypeScript stripping inside node_modules. This package entry
  // points to the test-owned TS fixture outside it, rather than generating untyped JavaScript.
  writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ type: 'module', main: '../../../../fake-runtime.ts' }))
  copyFileSync(new URL('./memory-embedding-runtime.ts', import.meta.url), path.join(root, 'fake-runtime.ts'))
  const encoding = { dimensions: options.dimensions ?? 384, maxTokens: options.maxTokens ?? 512,
    queryPrefix: options.prefixes === 'none' ? '' as const : 'query: ' as const,
    passagePrefix: options.prefixes === 'none' ? '' as const : 'passage: ' as const }
  const descriptor = await writeMemoryEmbeddingManifest(modelRoot, encoding)
  const embedders: ReturnType<typeof createMemoryEmbedder>[] = []
  const open = () => { const embedder = createMemoryEmbedder({ modelRoot, runtimeRoot }); embedders.push(embedder); return embedder }
  t.after(() => { for (const embedder of embedders) embedder.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, modelRoot, runtimeRoot, encoding, descriptor, open, embedder: open() }
}
