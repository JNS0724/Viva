import { guardDiagnosticPort, NO_DIAGNOSTICS, safeDiagnosticReason } from './contracts.ts'
import type { DiagnosticFields, DiagnosticOperation, DiagnosticOutcome, DiagnosticPort } from './contracts.ts'
let nextOperation = 0
interface Observation {
  progress(details: DiagnosticFields): void
  end(outcome?: DiagnosticOutcome, details?: DiagnosticFields): void
  fail(error: unknown): void
}
const SILENT: Observation = Object.freeze({ progress() {}, end() {}, fail() {} })

/** Portable lifecycle recorder. It owns no business work, cancellation, Promise or admission. */
export function beginDiagnosticOperation(provided: DiagnosticPort | undefined, operation: DiagnosticOperation, fields: DiagnosticFields = {}): Observation {
  if (!provided || provided === NO_DIAGNOSTICS) return SILENT
  const port = guardDiagnosticPort(provided)
  // This identifier is diagnostic only; it cannot become a job, receipt, read batch or send permit.
  fields = { ...fields, identities: { ...fields.identities, operationId: fields.identities?.operationId ?? `local:${++nextOperation}` } }
  const started = performance.now()
  let ended = false
  port.emit({ ...fields, event: 'operation.start', operation })
  function end(outcome: DiagnosticOutcome = 'completed', details: DiagnosticFields = {}) {
    if (ended) return
    ended = true
    port.emit({ ...fields, ...details, event: 'operation.end', operation, outcome,
      identities: { ...fields.identities, ...details.identities },
      metrics: { ...fields.metrics, ...details.metrics, durationMs: Math.max(0, performance.now() - started) } })
  }
  return {
    progress(details: DiagnosticFields) {
      if (!ended) port.emit({ ...fields, ...details, event: 'operation.progress', operation,
        identities: { ...fields.identities, ...details.identities }, metrics: { ...fields.metrics, ...details.metrics } })
    },
    end,
    fail(error: unknown) {
      const reason = safeDiagnosticReason(error)
      end(reason === 'aborted' ? 'cancelled' : reason === 'timeout' ? 'timed_out' : 'failed', { reason })
    },
  }
}

/** For already asynchronous business boundaries; neither outcomes nor errors are translated. */
export function observeDiagnosticAsync<T>(port: DiagnosticPort | undefined, operation: DiagnosticOperation,
  work: (observation: Observation) => Promise<T>, fields: DiagnosticFields = {}): Promise<T> {
  if (!port || port === NO_DIAGNOSTICS) return work(SILENT)
  const observation = beginDiagnosticOperation(port, operation, fields)
  try { return work(observation).then(value => { observation.end(); return value }, error => { observation.fail(error); throw error }) }
  catch (error) { observation.fail(error); throw error }
}

/** Synchronous boundaries retain their exact return value and thrown object. */
export function observeDiagnosticSync<T>(port: DiagnosticPort | undefined, operation: DiagnosticOperation,
  work: (observation: Observation) => T, fields: DiagnosticFields = {}): T {
  if (!port || port === NO_DIAGNOSTICS) return work(SILENT)
  const observation = beginDiagnosticOperation(port, operation, fields)
  try { const value = work(observation); observation.end(); return value }
  catch (error) { observation.fail(error); throw error }
}
