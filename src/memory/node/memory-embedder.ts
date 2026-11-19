import { fork } from 'node:child_process'
import { diagnosticBinding, diagnosticContext, emitDiagnostic, withOperation } from '../../diagnostics/node/context.ts'
import { parseDiagnosticContext } from '../../diagnostics/contracts.ts'
import type { DiagnosticReason } from '../../diagnostics/contracts.ts'
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
  let retiring = false
  let authenticated = false
  let pending: { id: number, finish: (vectors: MemoryEmbeddingResult | null, reason?: DiagnosticReason) => void } | undefined
  let requestId = 0
  let retryAfter = 0
  let closed = false
  let descriptor: MemoryEmbeddingDescriptor | undefined
  try { descriptor = readMemoryEmbeddingDescriptor(modelRoot) } catch { /* Unknown assets cannot claim the default vector space. */ }
  const fingerprint = descriptor?.fingerprint ?? 'memory-embedding-assets:unavailable'
  const dimensions = descriptor?.manifest.dimensions ?? 0

  function cooldown(reason: DiagnosticReason) {
    retryAfter = Date.now() + RETRY_AFTER_MS
    emitDiagnostic({ event: 'retry.scheduled', operation: 'embedding', stage: 'unavailable', reason,
      identities: { generation: fingerprint }, metrics: { retryDelayMs: RETRY_AFTER_MS } }, diagnosticContext())
  }

  function retire(worker: ChildProcess, reason: DiagnosticReason, exited = false) {
    if (child !== worker || retiring) return
    retiring = true
    if (reason !== 'aborted' && reason !== 'closed') cooldown(reason)
    pending?.finish(null, reason)
    // Inference has no durable writes. Keep the slot reserved until the operating system
    // has reaped the worker, even if it had an outstanding native inference when killed.
    if (!exited && worker.pid !== undefined) worker.kill('SIGKILL')
  }

  function skip(reason: DiagnosticReason) {
    emitDiagnostic({ event: 'operation.progress', operation: 'embedding', stage: retiring ? 'draining' : 'unavailable', reason,
      identities: { generation: fingerprint }, metrics: { activeCount: child ? 1 : 0 } }, diagnosticContext())
    return null
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
    emitDiagnostic({ event: 'process.start', operation: 'embedding', stage: retryAfter ? 'recovering' : 'connecting',
      identities: { generation: fingerprint } }, diagnosticContext())
    worker.on('error', () => retire(worker, 'model_failed'))
    const release = () => {
      if (child !== worker) return
      emitDiagnostic({ event: 'process.exit', operation: 'embedding', reason: 'process_exited', identities: { generation: fingerprint } })
      retire(worker, 'process_exited', true)
      child = undefined
      authenticated = false
      retiring = false
    }
    worker.once('exit', release)
    // A failed spawn emits close without exit.
    worker.once('close', release)
    return worker
  }

  async function embedBatch(inputs: readonly MemoryEmbeddingInput[], signal?: AbortSignal): Promise<MemoryEmbeddingResult | null> {
    if (closed) return skip('closed')
    if (signal?.aborted) return skip('aborted')
    if (!descriptor) return skip('not_ready')
    if (pending || retiring) return skip('busy')
    if (Date.now() < retryAfter) return skip('retry')
    if (!inputs.length) return []
    if (inputs.length > MEMORY_EMBEDDING_BATCH + 1 || inputs.some(({ kind, text }) =>
      (kind !== 'query' && kind !== 'passage') || !text.trim())) return skip('validation_failed')
    if (inputs.some(({ text }) => text.length > MEMORY_EMBEDDING_MAX_CHARS)) return skip('oversized')
    let worker: ChildProcess
    try { worker = child ?? spawn() } catch {
      cooldown('model_failed')
      return null
    }
    return new Promise(resolve => {
      const id = ++requestId
      const context = diagnosticContext()
      const observedStages = new Set<string>()
      let droppedContext = false
      const finish = (vectors: MemoryEmbeddingResult | null, reason: DiagnosticReason = 'normal') => {
        const oversized = vectors?.filter(vector => vector === null).length ?? 0
        emitDiagnostic({ event: 'operation.progress', operation: 'embedding', stage: vectors ? 'complete' : 'unavailable',
          reason: oversized ? 'oversized' : reason, identities: { requestId: id },
          metrics: { ok: Boolean(vectors), ...(oversized ? { droppedCount: oversized } : {}) } }, context)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        worker.off('message', receive)
        if (pending?.id === id) pending = undefined
        resolve(vectors)
      }
      const abort = () => retire(worker, 'aborted')
      const receive = (raw: unknown) => {
        const message = objectOf(raw)
        if (child !== worker || retiring) return
        if (message?.type === 'diagnostic-worker') {
          const incoming = parseDiagnosticContext(message.diagnostics)
          const stage = message.stage
          const validStage = stage === 'connecting' || stage === 'ready' || stage === 'vector'
          if (message.id === id && message.version === 1 && validStage
            && (message.diagnostics === undefined || incoming && (!diagnosticBinding() || incoming.diagnosticRunId === diagnosticBinding()))) {
            if (observedStages.has(stage)) return
            observedStages.add(stage)
            emitDiagnostic({ event: 'operation.progress', operation: 'embedding',
              stage, identities: { requestId: id } }, context)
          } else if (!droppedContext) {
            droppedContext = true
            emitDiagnostic({ event: 'context.dropped', operation: 'embedding', reason: 'invalid_context' })
          }
          return
        }
        if (message?.type === 'ready') {
          if (message.fingerprint !== fingerprint || message.dimensions !== dimensions) retire(worker, 'validation_failed')
          else { authenticated = true; emitDiagnostic({ event: 'state.changed', operation: 'embedding', stage: 'ready', identities: { generation: fingerprint } }) }
          return
        }
        if (message?.id !== id) return
        if (message.type === 'failure' && message.reason === 'model_failed') {
          retire(worker, 'model_failed')
          return
        }
        if (message.type !== 'result' || !authenticated || message.fingerprint !== fingerprint || message.dimensions !== dimensions) {
          retire(worker, 'validation_failed')
          return
        }
        const vectors = vectorsFrom(message.rows, inputs.length, dimensions)
        if (!vectors) {
          retire(worker, 'validation_failed')
          return
        }
        retryAfter = 0
        finish(vectors)
      }
      const timer = setTimeout(() => retire(worker, 'timeout'), timeoutMs)
      timer.unref()
      pending = { id, finish }
      worker.on('message', receive)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else {
        try { worker.send({ id, inputs, fingerprint, dimensions, ...(context ? { diagnostics: context } : {}) }, error => { if (error && pending?.id === id) retire(worker, 'model_failed') }) }
        catch { retire(worker, 'model_failed') }
      }
    })
  }

  return Object.freeze({
    fingerprint,
    dimensions,
    embedBatch: (inputs: readonly MemoryEmbeddingInput[], signal?: AbortSignal) => withOperation('embedding', () => embedBatch(inputs, signal), { stage: 'vector', metrics: { count: inputs.length } }),
    close() {
      closed = true
      if (child) retire(child, 'closed')
    },
  })
}
