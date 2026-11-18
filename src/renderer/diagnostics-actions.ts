import { createRequestBudget } from '../shared/request-budget.ts'
import type { DiagnosticControl, DiagnosticNotice } from './diagnostics-types.ts'

/** Shell-owned controls stay available independently of the business Backend and memory owner. */
export function createDiagnosticsActions({ api, getState, dispatch }: Pick<ActionDeps, 'getState' | 'dispatch'> & {
  api: Pick<AgentApi, 'diagnosticsStatus' | 'exportDiagnostics' | 'clearDiagnostics' | 'debugDiagnostics' | 'openDiagnosticsFolder'>,
}) {
  let generation = 0
  let expiry: ReturnType<typeof setTimeout> | undefined
  let loading: Promise<void> | undefined
  let controlling = false
  function setExpiry(remainingMs: number) {
    clearTimeout(expiry)
    if (remainingMs > 0) expiry = setTimeout(() => dispatch({ type: 'diagnostics_debug_expired' }), remainingMs)
  }
  function refresh(): Promise<void> {
    if (loading) return loading
    const request = ++generation
    dispatch({ type: 'diagnostics_loading' })
    const lifetime = createRequestBudget(2000)
    const pending = lifetime.run(() => api.diagnosticsStatus()).then(status => {
      if (generation !== request) return
      dispatch({ type: 'diagnostics_loaded', status })
      setExpiry(status.debugRemainingMs)
    }, () => {
      if (generation === request) dispatch({ type: 'diagnostics_load_failed' })
    }).finally(() => { lifetime.close(); if (loading === pending) loading = undefined })
    loading = pending
    return pending
  }
  async function control(kind: DiagnosticControl, work: () => Promise<DiagnosticNotice | null>) {
    if (controlling || getState().diagnostics.busy) return
    controlling = true
    generation++; loading = undefined
    dispatch({ type: 'diagnostics_busy', kind })
    try {
      const notice = await work()
      dispatch({ type: 'diagnostics_done', notice })
      if (notice === 'debug_enabled') setExpiry(15 * 60_000)
      if (notice === 'debug_disabled' || notice === 'cleared') setExpiry(0)
    }
    catch { dispatch({ type: 'diagnostics_done', notice: 'failed' }) }
    finally { controlling = false; await refresh() }
  }
  return {
    refresh,
    export: () => control('export', async () => { const result = await api.exportDiagnostics(); return result.status === 'cancelled' ? null : result.status }),
    clear: () => control('clear', async () => (await api.clearDiagnostics()).status),
    debug: (enabled: boolean) => control('debug', async () => { await api.debugDiagnostics(enabled); return enabled ? 'debug_enabled' : 'debug_disabled' }),
    openFolder: () => control('folder', async () => { await api.openDiagnosticsFolder(); return null }),
  }
}
