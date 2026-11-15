import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createMemoryEmbedder, MEMORY_EMBEDDING_DIMENSIONS } from '../src/backend/memory-embedder.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'viva-memory-embedding-'))
  const modelRoot = path.join(root, 'model')
  const runtimeRoot = path.join(root, 'runtime')
  const onnx = path.join(modelRoot, 'onnx')
  mkdirSync(onnx, { recursive: true })
  writeFileSync(path.join(onnx, 'model_quantized.onnx'), '')
  const dependency = path.join(runtimeRoot, 'node_modules', '@huggingface', 'transformers')
  mkdirSync(dependency, { recursive: true })
  writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
  writeFileSync(path.join(dependency, 'index.js'), `
    export const env = { allowRemoteModels: true, useFSCache: true, useBrowserCache: true };
    export async function pipeline(task, model, settings) {
      if (task !== 'feature-extraction' || settings.device !== 'cpu' || settings.dtype !== 'q8'
        || !settings.local_files_only || env.allowRemoteModels || env.useFSCache || env.useBrowserCache) throw Error('local settings');
      const extract = async (prompts, options) => {
        if (options.pooling !== 'mean' || !options.normalize) throw Error('pooling settings');
        if (prompts.some(prompt => prompt.includes('stop worker'))) process.exit(42);
        if (prompts.some(prompt => prompt.includes('hang worker'))) await new Promise(resolve => setTimeout(resolve, 30_000));
        const data = new Float32Array(prompts.length * 384);
        for (const [i, prompt] of prompts.entries()) {
          if (prompt.startsWith('query: ')) data[384 * i] = 1;
          else if (prompt.startsWith('passage: ')) data[384 * i + 1] = 1;
          else throw Error('incorrect role prefix');
        }
        return { dims: [prompts.length, 384], data };
      };
      extract.tokenizer = { encode: input => Array(input.includes('too long') ? 513 : 512).fill(1) };
      return extract;
    }
  `)
  const embedder = createMemoryEmbedder({ modelRoot, runtimeRoot })
  t.after(() => {
    embedder.close()
    rmSync(root, { recursive: true, force: true })
  })
  return embedder
}

test('local worker keeps each prefix and rejects overlong rows without losing the rest of the batch', async t => {
  const embedder = fixture(t)
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
  const embedder = fixture(t)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'stop worker' }]), null)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'fall back during the cooldown' }]), null)
  embedder.close()
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'closed' }]), null)
})

test('aborting a pending embedding retires that worker and lets a new request run', async t => {
  const embedder = fixture(t)
  const controller = new AbortController()
  const pending = embedder.embedBatch([{ kind: 'query', text: 'hang worker' }], controller.signal)
  assert.equal(await embedder.embedBatch([{ kind: 'query', text: 'busy' }]), null)
  controller.abort()
  assert.equal(await pending, null)
  const result = await embedder.embedBatch([{ kind: 'query', text: 'retry after abort' }])
  assert.equal(result?.[0]?.[0], 1)
})
