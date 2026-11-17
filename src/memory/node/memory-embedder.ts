import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { objectOf } from '../contracts/unknown-value.ts'

import { MEMORY_EMBEDDING_BATCH, MEMORY_EMBEDDING_MAX_CHARS } from '../contracts/embedding.ts'
import type { MemoryEmbeddingInput, MemoryEmbeddingResult, MemoryEmbedder } from '../contracts/embedding.ts'
import { readMemoryEmbeddingDescriptor } from './memory-embedding-assets.ts'
import type { MemoryEmbeddingDescriptor } from './memory-embedding-assets.ts'
export * from '../contracts/embedding.ts'
const INFERENCE_TIMEOUT_MS = 6000
const RETRY_AFTER_MS = 30_000

function vectorsFrom(message: unknown, count: number, dimensions: number): MemoryEmbeddingResult | null {
  if (!Array.isArray(message) || message.length !== count) return null
  const vectors: MemoryEmbeddingResult = []
  for (const row of message) {
    if (row === null) { vectors.push(null); continue }
    if (!Array.isArray(row) || row.length !== dimensions
      || !row.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1)) return null
    const vector = Float32Array.from(row as number[])
    const squared = vector.reduce((sum, value) => sum + value * value, 0)
    if (Math.abs(squared - 1) > 0.005) return null
    vectors.push(vector)
  }
  return vectors
}

/** ONNX runs outside the backend process, so a native crash leaves normal recall and writes available. */
export function createMemoryEmbedder({ modelRoot, runtimeRoot, timeoutMs = INFERENCE_TIMEOUT_MS }: {
  modelRoot: string, runtimeRoot?: string, timeoutMs?: number,
}): MemoryEmbedder {
  let child: ChildProcess | undefined
  let pending: { id: number, finish: (vectors: MemoryEmbeddingResult | null) => void } | undefined
  let requestId = 0
  let retryAfter = 0
  let closed = false
  let descriptor: MemoryEmbeddingDescriptor | undefined
  try { descriptor = readMemoryEmbeddingDescriptor(modelRoot) } catch { /* Unknown assets cannot claim the default vector space. */ }
  const fingerprint = descriptor?.fingerprint ?? 'memory-embedding-assets:unavailable'
  const dimensions = descriptor?.manifest.dimensions ?? 0
  const authenticated = new WeakSet<ChildProcess>()

  function retire(worker: ChildProcess, retry: boolean) {
    if (child !== worker) return
    child = undefined
    if (retry) retryAfter = Date.now() + RETRY_AFTER_MS
    pending?.finish(null)
    worker.kill()
  }

  function spawn() {
    const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
    const entry = fileURLToPath(new URL(`./memory-embedder-worker${suffix}`, import.meta.url))
    const worker = fork(entry, [path.resolve(modelRoot), ...(runtimeRoot ? [path.resolve(runtimeRoot)] : [])], {
      execPath: process.execPath, execArgv: [], windowsHide: true, serialization: 'json',
      env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    child = worker
    worker.on('error', () => retire(worker, true))
    worker.on('exit', () => retire(worker, true))
    return worker
  }

  async function embedBatch(inputs: readonly MemoryEmbeddingInput[], signal?: AbortSignal): Promise<MemoryEmbeddingResult | null> {
    if (!descriptor || closed || signal?.aborted || pending || Date.now() < retryAfter) return null
    if (!inputs.length) return []
    if (inputs.length > MEMORY_EMBEDDING_BATCH + 1 || inputs.some(({ kind, text }) =>
      (kind !== 'query' && kind !== 'passage') || !text.trim() || text.length > MEMORY_EMBEDDING_MAX_CHARS)) return null
    let worker: ChildProcess
    try { worker = child ?? spawn() } catch {
      retryAfter = Date.now() + RETRY_AFTER_MS
      return null
    }
    return new Promise(resolve => {
      const id = ++requestId
      const finish = (vectors: MemoryEmbeddingResult | null) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        worker.off('message', receive)
        if (pending?.id === id) pending = undefined
        resolve(vectors)
      }
      const abort = () => retire(worker, false)
      const receive = (raw: unknown) => {
        const message = objectOf(raw)
        if (child !== worker) return
        if (message?.type === 'ready') {
          if (message.fingerprint !== fingerprint || message.dimensions !== dimensions) retire(worker, true)
          else authenticated.add(worker)
          return
        }
        if (message?.id !== id) return
        if (message.type !== 'result' || !authenticated.has(worker) || message.fingerprint !== fingerprint || message.dimensions !== dimensions) {
          retire(worker, true)
          return
        }
        const vectors = vectorsFrom(message.rows, inputs.length, dimensions)
        if (vectors) finish(vectors)
        else retire(worker, true)
      }
      const timer = setTimeout(() => retire(worker, true), timeoutMs)
      timer.unref()
      pending = { id, finish }
      worker.on('message', receive)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else {
        try { worker.send({ id, inputs, fingerprint, dimensions }, error => { if (error) retire(worker, true) }) }
        catch { retire(worker, true) }
      }
    })
  }

  return Object.freeze({
    fingerprint,
    dimensions,
    embedBatch,
    close() {
      closed = true
      if (child) retire(child, false)
    },
  })
}
