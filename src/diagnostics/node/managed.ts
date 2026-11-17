import { createNodeDiagnostics } from './logger.ts'
import type { NodeDiagnostics } from './logger.ts'
import { diagnosticContext, newDiagnosticContext, snapshotDiagnosticContext } from './context.ts'
import { loadDiagnosticIdentity } from './identity.ts'

/** Stable local port: clear replaces only diagnostic writers and their caches, never business resources. */
export function createManagedDiagnostics(options: Parameters<typeof createNodeDiagnostics>[0]) {
  let current = createNodeDiagnostics(options)
  let paused = false, closed = false, clearId: string | undefined, resumed = ''
  let expectedRunId: string | undefined
  let pausedDrops = 0
  let preparing: Promise<boolean> | undefined
  const stats = () => {
    const value = current.snapshot()
    return { ...value, stats: { ...value.stats, droppedCount: Math.min(Number.MAX_SAFE_INTEGER, value.stats.droppedCount + pausedDrops) } }
  }
  const managed: NodeDiagnostics & {
    prepare(clearId: string): Promise<boolean>, resume(clearId: string, runId: string): Promise<boolean>,
  } = {
    get ready() { return current.ready }, get quota() { return current.quota }, directory: current.directory,
    emit(event, supplied) {
      try {
        if (paused || closed) { pausedDrops++; return undefined }
        const runId = expectedRunId ?? current.identity()?.diagnosticRunId
        const received = snapshotDiagnosticContext(supplied)
        if (supplied && !received) { pausedDrops++; return undefined }
        // Explicit remote contexts from a retired writer binding are dropped, not rebound.
        if (received && runId && received.diagnosticRunId !== runId) { pausedDrops++; return undefined }
        let context = received ?? diagnosticContext() ?? newDiagnosticContext()
        if (runId && !context.diagnosticRunId) context = { ...context, diagnosticRunId: runId }
        current.emit(event, context)
      } catch { pausedDrops++ }
      return undefined
    },
    snapshot: stats, identity: () => current.identity(), released: () => current.released(),
    setDebug: duration => { if (!paused && !closed) current.setDebug(duration) }, debugRemainingMs: () => current.debugRemainingMs(),
    close: () => { closed = true; paused = true; return current.close() },
    async prepare(token) {
      if (closed || clearId && clearId !== token) return false
      clearId = token; paused = true
      preparing ??= current.close()
      await preparing
      return current.released()
    },
    async resume(token, runId) {
      if (closed) return false
      if (!paused && current.identity()?.diagnosticRunId === runId) return true
      if (resumed === `${token}:${runId}`) return true
      if (clearId !== token || !paused || !current.released()) return false
      const identity = await loadDiagnosticIdentity(options.directory)
      if (identity.runId !== runId) return false
      expectedRunId = runId
      current = createNodeDiagnostics({ ...options, quota: current.quota })
      pausedDrops = 0; preparing = undefined; clearId = undefined; resumed = `${token}:${runId}`; paused = false
      return true
    },
  }
  return managed
}
export type ManagedDiagnostics = ReturnType<typeof createManagedDiagnostics>
