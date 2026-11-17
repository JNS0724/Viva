import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { DIAGNOSTIC_VERSION, NO_DIAGNOSTICS, parseDiagnosticContext, safeDiagnosticReason } from '../contracts.ts'
import type { DiagnosticContext, DiagnosticEvent, DiagnosticFields, DiagnosticOperation, DiagnosticPort } from '../contracts.ts'

const context = new AsyncLocalStorage<DiagnosticContext>()
let port: DiagnosticPort = NO_DIAGNOSTICS
let failures = 0
let binding: string | undefined
const rebound = new WeakMap<DiagnosticContext, { runId: string, context: DiagnosticContext }>()
const trusted = new WeakSet<object>()
const snapshots = new WeakMap<object, DiagnosticContext>()
function immutable(value: DiagnosticContext): DiagnosticContext { trusted.add(value); return Object.freeze(value) }
/** Weak keys never keep an arbitrary caller object alive; retained values contain opaque scalars only. */
export function snapshotDiagnosticContext(value: unknown): DiagnosticContext | undefined {
  if (!value || typeof value !== 'object') return
  if (trusted.has(value)) return value as DiagnosticContext
  let snapshot = snapshots.get(value)
  if (!snapshot) {
    snapshot = parseDiagnosticContext(value)
    if (!snapshot) return
    trusted.add(snapshot); snapshots.set(value, snapshot)
  }
  return snapshot
}
export function setDiagnosticBinding(runId: string | undefined) {
  binding = runId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId) ? runId : undefined
}
export function diagnosticBinding() { return binding }
function localContext(value: DiagnosticContext): DiagnosticContext {
  if (!binding || value.diagnosticRunId === binding) return value
  const cached = rebound.get(value)
  if (cached?.runId === binding) return cached.context
  const next = value.diagnosticRunId || cached ? newDiagnosticContext() : immutable({ ...value, diagnosticRunId: binding })
  rebound.set(value, { runId: binding, context: next })
  if (value.diagnosticRunId || cached) {
    try { port.emit({ event: 'state.changed', operation: 'diagnostics', reason: 'continued_after_clear' }, next) } catch { failures++ }
  }
  return next
}
function remoteParent(incoming: DiagnosticContext | undefined) {
  const snapshot = snapshotDiagnosticContext(incoming)
  if (incoming && !snapshot) {
    emitDiagnostic({ event: 'context.dropped', operation: 'diagnostics', reason: 'invalid_context' })
    return undefined
  }
  incoming = snapshot
  if (incoming && binding && incoming.diagnosticRunId !== binding) {
    emitDiagnostic({ event: 'context.dropped', operation: 'diagnostics', reason: 'epoch_changed' })
    return undefined
  }
  return incoming
}
// Amortize the OS entropy call while retaining 128-bit traces and 64-bit spans.
// The pool is private, bounded, and each byte range is consumed only once.
let entropy = Buffer.alloc(0), entropyOffset = 0
function randomId(bytes: number): string {
  if (entropyOffset + bytes > entropy.length) { entropy = randomBytes(4096); entropyOffset = 0 }
  const start = entropyOffset
  entropyOffset += bytes
  return entropy.toString('hex', start, entropyOffset)
}
export function diagnosticContext() { const current = context.getStore(); return current ? localContext(current) : undefined }
export function newDiagnosticContext(parent?: DiagnosticContext): DiagnosticContext {
  parent = snapshotDiagnosticContext(parent)
  parent = parent ? localContext(parent) : undefined
  return immutable({ version: DIAGNOSTIC_VERSION, traceId: parent?.traceId ?? randomId(16),
    spanId: randomId(8), ...(parent ? { parentSpanId: parent.spanId } : {}), ...(binding ? { diagnosticRunId: binding } : {}) })
}
export function installDiagnosticPort(next: DiagnosticPort) {
  const previous = port
  port = next
  return () => { if (port === next) port = previous }
}
export function diagnosticFailures() { return failures }
export function emitDiagnostic(event: DiagnosticEvent, current?: DiagnosticContext): undefined {
  try { const snapshot = snapshotDiagnosticContext(current); port.emit(event, snapshot ? localContext(snapshot) : undefined) } catch { failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1) }
  return undefined
}
export const diagnosticPort: DiagnosticPort = Object.freeze({ emit: emitDiagnostic })
/** Classify once at an existing failure boundary; never serialize an Error or its message. */
export function emitDiagnosticFailure(operation: DiagnosticOperation, error: unknown, fields: DiagnosticFields = {}): undefined {
  return emitDiagnostic({ ...fields, event: 'operation.progress', operation, stage: fields.stage ?? 'failed', reason: safeDiagnosticReason(error) })
}
export function inDiagnosticContext<T>(incoming: DiagnosticContext | undefined, work: () => T): T {
  incoming = remoteParent(incoming)
  if (!incoming && port === NO_DIAGNOSTICS) return work()
  let next = incoming
  try { next ??= newDiagnosticContext() } catch { failures++; return work() }
  return context.run(next, work)
}
/** Preserve synchronous returns and the business rejection. Logging is never awaited. */
export function withOperation<T>(operation: DiagnosticOperation, work: () => T, fields: DiagnosticFields = {}): T {
  if (port === NO_DIAGNOSTICS) return work()
  return runOperation(operation, work, fields, context.getStore())
}
/** Receiving a remote parent needs one child scope, rather than two nested ALS scopes. */
export function withRemoteOperation<T>(incoming: DiagnosticContext | undefined, operation: DiagnosticOperation, work: () => T, fields: DiagnosticFields = {}): T {
  incoming = remoteParent(incoming)
  if (port === NO_DIAGNOSTICS) return inDiagnosticContext(incoming, work)
  return runOperation(operation, work, fields, incoming)
}
function runOperation<T>(operation: DiagnosticOperation, work: () => T, fields: DiagnosticFields, parent: DiagnosticContext | undefined): T {
  let current: DiagnosticContext
  try { current = newDiagnosticContext(parent) } catch { failures++; return work() }
  const started = performance.now()
  return context.run(current, () => {
    emitDiagnostic({ ...fields, event: 'operation.start', operation }, current)
    const end = (error?: unknown, failed = false) => emitDiagnostic({ ...fields, event: 'operation.end', operation,
      outcome: failed ? safeDiagnosticReason(error) === 'aborted' ? 'cancelled' : safeDiagnosticReason(error) === 'timeout' ? 'timed_out' : 'failed' : 'completed',
      ...(failed ? { reason: safeDiagnosticReason(error) } : {}), metrics: { ...fields.metrics, durationMs: performance.now() - started } }, current)
    try {
      const result = work()
      if (result instanceof Promise || types.isPromise(result)) return result.then(value => { end(); return value }, (error: unknown) => { end(error, true); throw error }) as T
      end()
      return result
    } catch (error) { end(error, true); throw error }
  })
}
