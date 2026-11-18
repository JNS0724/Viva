import type { ActionHandlers } from './action-types.ts'
import type { DiagnosticNotice, DiagnosticControl, DiagnosticsState } from './diagnostics-types.ts'
export const initialDiagnostics: DiagnosticsState = Object.freeze({
  status: null,
  loading: false,
  busy: null as DiagnosticControl | null,
  notice: null as DiagnosticNotice | null,
  failed: false,
})

export const DIAGNOSTICS_ACTIONS: ActionHandlers = {
  diagnostics_loading: state => ({ ...state, diagnostics: { ...state.diagnostics, loading: true, failed: false } }),
  diagnostics_loaded: (state, { status }) => ({ ...state, diagnostics: { ...state.diagnostics, status: { ...status }, loading: false, failed: false } }),
  diagnostics_load_failed: state => ({ ...state, diagnostics: { ...state.diagnostics, loading: false, failed: true } }),
  diagnostics_busy: (state, { kind }) => ({ ...state, diagnostics: { ...state.diagnostics, busy: kind, notice: null } }),
  diagnostics_done: (state, { notice }) => ({ ...state, diagnostics: { ...state.diagnostics, busy: null, notice,
    status: notice === 'cleared' ? null : state.diagnostics.status && (notice === 'debug_enabled' || notice === 'debug_disabled')
      ? { ...state.diagnostics.status, debugRemainingMs: notice === 'debug_enabled' ? 15 * 60_000 : 0 } : state.diagnostics.status,
  } }),
  diagnostics_debug_expired: state => !state.diagnostics.status ? state : ({ ...state, diagnostics: {
    ...state.diagnostics, status: { ...state.diagnostics.status, debugRemainingMs: 0 },
  } }),
}
