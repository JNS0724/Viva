/** Exposes Viva's local Granite-97M q8 embedder as an OpenAI-compatible /v1/embeddings server
 * so ReMe can run hybrid vector+BM25 evaluation on the exact same embedding space with zero external API keys. */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { MEMORY_EMBEDDING_BATCH } from '../../src/memory/contracts/embedding.ts'
import { createMemoryEmbedder } from '../../src/memory/node/memory-embedder.ts'

export interface LocalEmbeddingServer {
  url: string
  dimensions: number
  fingerprint: string
  close(): Promise<void>
}

function normalize(vector: Float32Array): number[] {
  let sum = 0
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!
  const norm = Math.sqrt(sum) || 1
  return Array.from(vector, v => v / norm)
}

function splitText(text: string, maxChars: number): string[] {
  const clean = text.trim()
  if (!clean) return [' ']
  const parts: string[] = []
  for (let i = 0; i < clean.length; i += maxChars) {
    const slice = clean.slice(i, i + maxChars).trim()
    if (slice) parts.push(slice)
  }
  return parts.length ? parts : [' ']
}

export async function startLocalEmbeddingServer(modelRoot: string, runtimeRoot: string): Promise<LocalEmbeddingServer> {
  const embedder = createMemoryEmbedder({ modelRoot, runtimeRoot })
  const warm = await embedder.embedBatch([{ kind: 'query', text: 'warmup' }])
  if (!warm?.[0] || !embedder.dimensions) {
    await embedder.close()
    throw new Error('Failed to initialize local Granite-97M embedder for ReMe proxy')
  }
  const dimensions = embedder.dimensions

  async function encodeSingle(text: string): Promise<number[]> {
    const trimmed = text.trim() || ' '
    if (trimmed.length <= 160) {
      const direct = await embedder.embedBatch([{ kind: 'passage', text: trimmed }])
      if (direct?.[0]) return normalize(direct[0])
    }
    // Granite-97M maxTokens=128 (symmetric: queryPrefix="", passagePrefix="").
    // Encode ALL bounded 140-char windows across the full chunk in vectorized batches so ReMe suffers zero middle truncation.
    const rawSlices = splitText(trimmed, 140)
    const vectors: Float32Array[] = []
    for (let offset = 0; offset < rawSlices.length; offset += MEMORY_EMBEDDING_BATCH) {
      const chunk = rawSlices.slice(offset, offset + MEMORY_EMBEDDING_BATCH)
      const batch = await embedder.embedBatch(chunk.map(s => ({ kind: 'passage' as const, text: s })))
      if (batch) {
        for (const vec of batch) if (vec) vectors.push(vec)
      }
    }
    if (!vectors.length) {
      const fallback = await embedder.embedBatch([{ kind: 'passage', text: trimmed.slice(0, 80) || ' ' }])
      return fallback?.[0] ? normalize(fallback[0]) : new Array<number>(dimensions).fill(0)
    }
    const mean = new Float32Array(dimensions)
    for (const vec of vectors) {
      for (let i = 0; i < dimensions; i++) mean[i] = mean[i]! + vec[i]!
    }
    return normalize(mean)
  }

  let queue: Promise<void> = Promise.resolve()
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/embeddings')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not-found' }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      void serialized(async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string | string[], model?: string }
        const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')]
        const data: Array<{ object: 'embedding', index: number, embedding: number[] }> = []
        for (let index = 0; index < inputs.length; index++) {
          data.push({ object: 'embedding', index, embedding: await encodeSingle(inputs[index]!) })
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          model: body.model ?? 'granite-embedding-97m-multilingual-r2',
          data,
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        }))
      }).catch(error => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    dimensions,
    fingerprint: embedder.fingerprint,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await embedder.close()
    },
  }
}
