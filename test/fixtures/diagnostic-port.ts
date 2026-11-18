import type { DiagnosticEvent, DiagnosticPort } from '../../src/diagnostics/contracts.ts'
import { diagnosticContext } from '../../src/diagnostics/node/context.ts'

/** Test-owned recorder explicitly implements scoped metadata; production uses the Node alias policy. */
export function recordingDiagnosticPort(emit: DiagnosticPort['emit']): DiagnosticPort {
  return { emit,
    bind(_operation, fields, context) {
      const base = { ...fields, identities: { ...fields.identities }, metrics: { ...fields.metrics } }
      return { emit(event, supplied) {
        const delta = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as DiagnosticEvent
        return emit({ ...base, ...delta, identities: { ...base.identities, ...delta.identities },
          metrics: { ...base.metrics, ...delta.metrics } }, diagnosticContext() ?? supplied ?? context)
      } }
    },
  }
}
