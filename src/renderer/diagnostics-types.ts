import type { IpcResults } from '../shared/ipc-results.ts'

export type DiagnosticNotice = 'saved' | 'failed' | 'busy' | 'cleared' | 'cleanup_pending' | 'debug_enabled' | 'debug_disabled'
export type DiagnosticControl = 'export' | 'clear' | 'debug' | 'folder'
export interface DiagnosticsState {
  readonly status: Readonly<IpcResults['diagnostics:status']> | null
  readonly loading: boolean
  readonly busy: DiagnosticControl | null
  readonly notice: DiagnosticNotice | null
  readonly failed: boolean
}
