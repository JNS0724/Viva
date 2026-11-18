import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { bindDiagnosticPort, DIAGNOSTIC_VERSION, NO_DIAGNOSTICS, parseDiagnosticContext, safeDiagnosticReason } from '../contracts.ts'
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
function localContext(value: DiagnosticContext, runId = binding): DiagnosticContext {
  if (!runId) return value
  const cached = rebound.get(value)
  if (cached?.runId === runId) return cached.context
  if (!cached && value.diagnosticRunId === runId) return value
  const next = value.diagnosticRunId || cached
    ? immutable({ version: DIAGNOSTIC_VERSION, traceId: randomId(16), spanId: randomId(8), diagnosticRunId: runId })
    : immutable({ ...value, diagnosticRunId: runId })
  const lineage = cached ?? { runId, context: next }
  lineage.runId = runId; lineage.context = next
  rebound.set(value, lineage); rebound.set(next, lineage)
  if (value.diagnosticRunId || cached) {
    try { port.emit({ event: 'state.changed', operation: 'diagnostics', reason: 'continued_after_clear' }, next) } catch { failures++ }
  }
  return next
}
/** Local bound continuations can follow an acknowledged writer replacement before the hub callback runs. */
export function continueDiagnosticContext(value: DiagnosticContext, runId?: string) {
  const snapshot = snapshotDiagnosticContext(value)
  if (!snapshot || runId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)) return newDiagnosticContext()
  return localContext(snapshot, runId)
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
export const diagnosticPort: DiagnosticPort = Object.freeze({ emit: emitDiagnostic,
  bind(operation: DiagnosticOperation, fields: DiagnosticFields, supplied?: DiagnosticContext) { return bindDiagnosticPort(port, operation, fields, supplied) },
})
/** Classify once at an existing failure boundary; never serialize an Error or its message. */
export function emitDiagnosticFailure(operation: DiagnosticOperation, error: unknown, fields: DiagnosticFields = {}): undefined {
  if (port === NO_DIAGNOSTICS) return undefined
  try {
    const { stage, outcome, identities, metrics } = fields
    return emitDiagnostic({ event: 'operation.progress', operation, stage: stage ?? 'failed', outcome, identities, metrics, reason: safeDiagnosticReason(error) })
  } catch { failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1); return undefined }
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
export function withDetachedOperation<T>(operation: DiagnosticOperation, work: () => T, fields: DiagnosticFields = {}): T {
  if (port === NO_DIAGNOSTICS) return work()
  return runOperation(operation, work, fields, undefined, true)
}
/** Receiving a remote parent needs one child scope, rather than two nested ALS scopes. */
export function withRemoteOperation<T>(incoming: DiagnosticContext | undefined, operation: DiagnosticOperation, work: () => T, fields: DiagnosticFields = {}): T {
  incoming = remoteParent(incoming)
  if (port === NO_DIAGNOSTICS) return inDiagnosticContext(incoming, work)
  return runOperation(operation, work, fields, incoming)
}
function runOperation<T>(operation: DiagnosticOperation, work: () => T, fields: DiagnosticFields, parent: DiagnosticContext | undefined, detached = false): T {
  let current: DiagnosticContext
  try {
    current = newDiagnosticContext(parent)
    const trigger = detached ? diagnosticContext() : undefined
    if (trigger) {
      const links = Object.freeze([Object.freeze({ traceId: trigger.traceId, spanId: trigger.spanId })])
      current = immutable({ ...current, links })
    }
  } catch { failures++; return work() }
  let scoped = bindDiagnosticPort(port, operation, fields, current)
  fields = {}
  if (scoped === NO_DIAGNOSTICS) return context.run(current, work)
  const started = performance.now()
  return context.run(current, () => {
    scoped.emit({ event: 'operation.start', operation })
    const end = (error?: unknown, failed = false) => {
      const reason = failed ? safeDiagnosticReason(error) : undefined
      scoped.emit({ event: 'operation.end', operation,
        outcome: failed ? reason === 'aborted' ? 'cancelled' : reason === 'timeout' ? 'timed_out' : 'failed' : 'completed',
        ...(reason ? { reason } : {}), metrics: { durationMs: performance.now() - started } })
      scoped = NO_DIAGNOSTICS
    }
    try {
      const result = work()
      if (result instanceof Promise || types.isPromise(result)) return result.then(value => { end(); return value }, (error: unknown) => { end(error, true); throw error }) as T
      end()
      return result
    } catch (error) { end(error, true); throw error }
  })
}
