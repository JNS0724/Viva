import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { objectOf } from '../shared/unknown-value.ts'
import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_DIMENSIONS, MEMORY_EMBEDDING_MAX_CHARS } from './memory-embedder.ts'
import type { MemoryEmbeddingInput } from './memory-embedder.ts'

type FeatureExtraction = {
  (prompts: string[], options: { pooling: 'mean', normalize: true }): Promise<{ dims: number[], data: Float32Array }>
  tokenizer: { encode(prompt: string): number[] }
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
const MAX_TOKENS = 512
let extractor: FeatureExtraction | undefined
let running = false
process.on('message', async raw => {
  const message = objectOf(raw)
  if (!message || !Number.isSafeInteger(message.id) || running) return
  const id = message.id
  const inputs = checkedInput(message.inputs)
  if (!inputs || !modelRoot) { process.send?.({ id, rows: null }); return }
  running = true
  try {
    extractor ??= await load(modelRoot, runtimeRoot)
    const model = extractor
    const prompts = inputs.flatMap(({ kind, text }, index) => {
      const prompt = `${kind}: ${text}`
      // Transformers.js truncates in the feature pipeline. Preflight whole inputs so we never
      // index an assertion with its trailing condition or exception silently chopped off.
      return model.tokenizer.encode(prompt).length <= MAX_TOKENS ? [{ prompt, index }] : []
    })
    const rows = Array.from<number[] | null>({ length: inputs.length }).fill(null)
    if (prompts.length) {
      const { dims, data } = await model(prompts.map(({ prompt }) => prompt), { pooling: 'mean', normalize: true })
      if (dims.length !== 2 || dims[0] !== prompts.length || dims[1] !== MEMORY_EMBEDDING_DIMENSIONS
        || !(data instanceof Float32Array) || data.length !== prompts.length * MEMORY_EMBEDDING_DIMENSIONS) {
        process.send?.({ id, rows: null })
        return
      }
      for (const [position, { index }] of prompts.entries()) {
        const offset = position * MEMORY_EMBEDDING_DIMENSIONS
        rows[index] = Array.from(data.subarray(offset, offset + MEMORY_EMBEDDING_DIMENSIONS))
      }
    }
    process.send?.({ id, rows })
  } catch {
    process.send?.({ id, rows: null })
  } finally {
    running = false
  }
})
process.on('disconnect', () => process.exit())
