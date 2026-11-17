import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { types } from 'node:util'
import { DIAGNOSTIC_VERSION, NO_DIAGNOSTICS, safeDiagnosticReason } from '../contracts.ts'
import type { DiagnosticContext, DiagnosticEvent, DiagnosticFields, DiagnosticOperation, DiagnosticPort } from '../contracts.ts'

const context = new AsyncLocalStorage<DiagnosticContext>()
let port: DiagnosticPort = NO_DIAGNOSTICS
let failures = 0
// Amortize the OS entropy call while retaining 128-bit traces and 64-bit spans.
// The pool is private, bounded, and each byte range is consumed only once.
let entropy = Buffer.alloc(0), entropyOffset = 0
function randomId(bytes: number): string {
  if (entropyOffset + bytes > entropy.length) { entropy = randomBytes(4096); entropyOffset = 0 }
  const start = entropyOffset
  entropyOffset += bytes
  return entropy.toString('hex', start, entropyOffset)
}
export function diagnosticContext() { return context.getStore() }
export function newDiagnosticContext(parent?: DiagnosticContext): DiagnosticContext {
  return { version: DIAGNOSTIC_VERSION, traceId: parent?.traceId ?? randomId(16),
    spanId: randomId(8), ...(parent ? { parentSpanId: parent.spanId } : {}) }
}
export function installDiagnosticPort(next: DiagnosticPort) {
  const previous = port
  port = next
  return () => { if (port === next) port = previous }
}
export function diagnosticFailures() { return failures }
export function emitDiagnostic(event: DiagnosticEvent, current?: DiagnosticContext): undefined {
  try { port.emit(event, current) } catch { failures = Math.min(Number.MAX_SAFE_INTEGER, failures + 1) }
  return undefined
}
export const diagnosticPort: DiagnosticPort = Object.freeze({ emit: emitDiagnostic })
export function inDiagnosticContext<T>(incoming: DiagnosticContext | undefined, work: () => T): T {
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
