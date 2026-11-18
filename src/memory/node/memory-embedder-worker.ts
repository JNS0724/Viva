import { createRequire } from 'node:module'
import path from 'node:path'
import { parseDiagnosticContext } from '../../diagnostics/contracts.ts'
import { pathToFileURL } from 'node:url'
import { objectOf } from '../contracts/unknown-value.ts'
import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_MAX_CHARS } from '../contracts/embedding.ts'
import type { MemoryEmbeddingInput } from '../contracts/embedding.ts'
import { readMemoryEmbeddingDescriptor, verifyMemoryEmbeddingAssets } from './memory-embedding-assets.ts'
import type { MemoryEmbeddingDescriptor, MemoryEmbeddingPooling } from './memory-embedding-assets.ts'

type FeatureExtraction = {
  (prompts: string[], options: { pooling: MemoryEmbeddingPooling, normalize: true }): Promise<{ dims: number[], data: Float32Array }>
  tokenizer: { encode(prompt: string): number[], model_max_length: number }
}
type Transformers = {
  env: { allowRemoteModels: boolean, useFSCache: boolean, useBrowserCache: boolean },
  pipeline(task: 'feature-extraction', model: string, options: {
    dtype: 'q8', device: 'cpu', local_files_only: true, session_options: { intraOpNumThreads: number, interOpNumThreads: number },
  }): Promise<FeatureExtraction>,
}

async function load(modelRoot: string, runtimeRoot: string | undefined) {
  const require = createRequire(runtimeRoot ? path.join(runtimeRoot, 'package.json') : import.meta.url)
  const entry = require.resolve('@huggingface/transformers')
  const library = await import(pathToFileURL(entry).href) as Transformers
  library.env.allowRemoteModels = false
  library.env.useFSCache = false
  library.env.useBrowserCache = false
  return library.pipeline('feature-extraction', modelRoot, {
    dtype: 'q8', device: 'cpu', local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  })
}

function checkedInput(raw: unknown): MemoryEmbeddingInput[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > MEMORY_EMBEDDING_BATCH + 1) return null
  const inputs: MemoryEmbeddingInput[] = []
  for (const item of raw) {
    const input = objectOf(item)
    if ((input?.kind !== 'query' && input?.kind !== 'passage') || typeof input.text !== 'string'
      || !input.text.trim() || input.text.length > MEMORY_EMBEDDING_MAX_CHARS) return null
    inputs.push({ kind: input.kind, text: input.text })
  }
  return inputs
}

const [, , modelRoot, runtimeRoot] = process.argv
let extractor: FeatureExtraction | undefined
let descriptor: MemoryEmbeddingDescriptor | undefined
let running = false
process.on('message', async raw => {
  const message = objectOf(raw)
  if (!message || !Number.isSafeInteger(message.id) || running) return
  const id = message.id
  const diagnostics = parseDiagnosticContext(message.diagnostics)
  const observe = (stage: 'connecting' | 'ready' | 'vector') => {
    try { process.send?.({ type: 'diagnostic-worker', version: 1, id, stage, ...(diagnostics ? { diagnostics } : {}) }) } catch { /* Independent of model loading/inference. */ }
  }
  const inputs = checkedInput(message.inputs)
  if (!inputs || !modelRoot) { process.send?.({ type: 'result', id, rows: null }); return }
  running = true
  try {
    if (!extractor) {
      observe('connecting')
      const identity = readMemoryEmbeddingDescriptor(modelRoot)
      if (identity.fingerprint !== message.fingerprint || identity.manifest.dimensions !== message.dimensions) throw new Error('Embedding descriptor differs from the parent identity')
      await verifyMemoryEmbeddingAssets(modelRoot, identity)
      const loaded = await load(modelRoot, runtimeRoot)
      if (!Number.isSafeInteger(loaded.tokenizer.model_max_length) || loaded.tokenizer.model_max_length < identity.manifest.maxTokens) {
        throw new Error('Embedding token budget exceeds the runtime tokenizer limit')
      }
      // Reject a replacement during runtime initialization before advertising or using its identity.
      await verifyMemoryEmbeddingAssets(modelRoot, identity)
      descriptor = identity
      extractor = loaded
      observe('ready')
      process.send?.({ type: 'ready', fingerprint: identity.fingerprint, dimensions: identity.manifest.dimensions })
    }
    if (!descriptor || descriptor.fingerprint !== message.fingerprint || descriptor.manifest.dimensions !== message.dimensions) throw new Error('Embedding request changed identity')
    const { dimensions, maxTokens, queryPrefix, passagePrefix, pooling } = descriptor.manifest
    const identity = { fingerprint: descriptor.fingerprint, dimensions }
    const model = extractor
    const prompts = inputs.flatMap(({ kind, text }, index) => {
      const prompt = `${kind === 'query' ? queryPrefix : passagePrefix}${text}`
      // Transformers.js truncates in the feature pipeline. Preflight whole inputs so we never
      // index an assertion with its trailing condition or exception silently chopped off.
      return model.tokenizer.encode(prompt).length <= maxTokens ? [{ prompt, index }] : []
    })
    const rows = Array.from<number[] | null>({ length: inputs.length }).fill(null)
    if (prompts.length) {
      observe('vector')
      const { dims, data } = await model(prompts.map(({ prompt }) => prompt), { pooling, normalize: true })
      if (dims.length !== 2 || dims[0] !== prompts.length || dims[1] !== dimensions
        || !(data instanceof Float32Array) || data.length !== prompts.length * dimensions) {
        process.send?.({ type: 'result', id, ...identity, rows: null })
        return
      }
      for (const [position, { index }] of prompts.entries()) {
        const offset = position * dimensions
        rows[index] = Array.from(data.subarray(offset, offset + dimensions))
      }
    }
    process.send?.({ type: 'result', id, ...identity, rows })
  } catch {
    process.send?.({ type: 'result', id, rows: null })
  } finally {
    running = false
  }
})
process.on('disconnect', () => process.exit())
