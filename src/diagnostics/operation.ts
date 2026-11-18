import { bindDiagnosticPort, NO_DIAGNOSTICS, safeDiagnosticReason } from './contracts.ts'
import type { DiagnosticFields, DiagnosticOperation, DiagnosticOutcome, DiagnosticPort } from './contracts.ts'
interface Observation {
  progress(details: DiagnosticFields): void
  end(outcome?: DiagnosticOutcome, details?: DiagnosticFields): void
  fail(error: unknown): void
}
const SILENT: Observation = Object.freeze({ progress() {}, end() {}, fail() {} })

/** Portable lifecycle recorder. It owns no business work, cancellation, Promise or admission. */
export function beginDiagnosticOperation(provided: DiagnosticPort | undefined, operation: DiagnosticOperation, fields: DiagnosticFields = {}): Observation {
  if (!provided || provided === NO_DIAGNOSTICS) return SILENT
  let port = bindDiagnosticPort(provided, operation, fields)
  fields = {}
  if (port === NO_DIAGNOSTICS) return SILENT
  const started = performance.now()
  let ended = false
  port.emit({ event: 'operation.start', operation })
  function end(outcome: DiagnosticOutcome = 'completed', details: DiagnosticFields = {}) {
    if (ended) return
    ended = true
    try {
      const { stage, reason, identities, metrics } = details
      port.emit({ event: 'operation.end', operation, outcome, stage, reason, identities,
        metrics: { ...metrics, durationMs: Math.max(0, performance.now() - started) } })
    } catch {
      port.emit({ event: 'operation.end', operation, outcome, reason: 'invalid_record',
        metrics: { durationMs: Math.max(0, performance.now() - started) } })
    }
    finally { port = NO_DIAGNOSTICS }
  }
  return {
    progress(details: DiagnosticFields) {
      if (!ended) try {
        const { stage, reason, outcome, identities, metrics } = details
        port.emit({ event: 'operation.progress', operation, stage, reason, outcome, identities, metrics })
      } catch { /* Optional metadata must remain non-throwing. */ }
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
  fields = {}
  if (observation === SILENT) return work(SILENT)
  try { return work(observation).then(value => { observation.end(); return value }, error => { observation.fail(error); throw error }) }
  catch (error) { observation.fail(error); throw error }
}

/** Synchronous boundaries retain their exact return value and thrown object. */
export function observeDiagnosticSync<T>(port: DiagnosticPort | undefined, operation: DiagnosticOperation,
  work: (observation: Observation) => T, fields: DiagnosticFields = {}): T {
  if (!port || port === NO_DIAGNOSTICS) return work(SILENT)
  const observation = beginDiagnosticOperation(port, operation, fields)
  fields = {}
  try { const value = work(observation); observation.end(); return value }
  catch (error) { observation.fail(error); throw error }
}
