import { createNodeDiagnostics } from './logger.ts'
import type { NodeDiagnostics } from './logger.ts'
import { continueDiagnosticContext, diagnosticContext, newDiagnosticContext, snapshotDiagnosticContext } from './context.ts'
import { loadDiagnosticIdentity } from './identity.ts'

/** Stable local port: clear replaces only diagnostic writers and their caches, never business resources. */
export function createManagedDiagnostics(options: Parameters<typeof createNodeDiagnostics>[0]) {
  let current = createNodeDiagnostics(options)
  let paused = false, closed = false, clearId: string | undefined
  let expectedRunId: string | undefined
  let pausedDrops = 0
  let replacement: NodeDiagnostics | undefined
  let resuming: { token: string, runId: string, work: Promise<boolean> } | undefined
  const writable = (runId: string) => current.identity()?.diagnosticRunId === runId && current.snapshot().stats.state === 'ready'
  async function resumeWriter(token: string, runId: string) {
    if (closed || paused && clearId !== token) return false
    if (!paused) return writable(runId)
    if (replacement && !writable(runId)) {
      await replacement.close()
      if (!replacement.released()) return false
      replacement = undefined
    }
    if (!replacement) {
      if (!current.released()) return false
      const identity = await loadDiagnosticIdentity(options.directory)
      if (closed || clearId !== token || identity.runId !== runId) return false
      expectedRunId = runId
      replacement = current = createNodeDiagnostics({ ...options, quota: current.quota })
      await replacement.ready
    }
    if (closed || !writable(runId)) return false
    replacement = undefined; pausedDrops = 0; clearId = undefined; paused = false
    return true
  }
  const stats = () => {
    const value = current.snapshot()
    return { ...value, stats: { ...value.stats, droppedCount: Math.min(Number.MAX_SAFE_INTEGER, value.stats.droppedCount + pausedDrops) } }
  }
  function contextFor(supplied: Parameters<NodeDiagnostics['emit']>[1]) {
    if (paused || closed) { pausedDrops++; return }
    const runId = expectedRunId ?? current.identity()?.diagnosticRunId
    const received = snapshotDiagnosticContext(supplied)
    if (supplied && !received || received && runId && received.diagnosticRunId !== runId) { pausedDrops++; return }
    let context = received ?? diagnosticContext() ?? newDiagnosticContext()
    if (runId && !context.diagnosticRunId) context = { ...context, diagnosticRunId: runId }
    return context
  }
  const managed: NodeDiagnostics & {
    prepare(clearId: string): Promise<boolean>, resume(clearId: string, runId: string): Promise<boolean>,
  } = {
    get ready() { return current.ready }, get quota() { return current.quota }, directory: current.directory,
    bind(operation, fields, supplied) {
      try {
        const context = contextFor(supplied)
        if (!context) return
        const initial = current.bind(operation, fields, context)
        if (!initial) return
        return managedBinding(operation, initial)
      } catch { pausedDrops++; return }
    },
    emit(event, supplied) {
      try {
        const context = contextFor(supplied)
        if (context) current.emit(event, context)
      } catch { pausedDrops++ }
      return undefined
    },
    snapshot: stats, identity: () => current.identity(), released: () => current.released(),
    setDebug: duration => { if (!paused && !closed) current.setDebug(duration) }, debugRemainingMs: () => current.debugRemainingMs(),
    close: () => { closed = true; paused = true; return current.close() },
    async prepare(token) {
      if (closed || clearId && clearId !== token) return false
      clearId = token; paused = true
      await current.close()
      return current.released()
    },
    resume(token, runId) {
      if (resuming) return resuming.token === token && resuming.runId === runId ? resuming.work : Promise.resolve(false)
      const work = resumeWriter(token, runId).finally(() => { resuming = undefined })
      resuming = { token, runId, work }
      return work
    },
  }
  function managedBinding(operation: Parameters<NodeDiagnostics['bind']>[0], initial: NonNullable<ReturnType<NodeDiagnostics['bind']>>) {
    let writer = current, scoped: ReturnType<NodeDiagnostics['bind']> = initial
    const context = initial.context, continuation = initial.continuation
    let endedWhilePaused = false
    const ended = () => endedWhilePaused || scoped?.ended === true
    return Object.freeze({ context, continuation, get ended() { return ended() },
      emit(event: Parameters<NodeDiagnostics['emit']>[0]) {
        try {
          if (closed || ended()) { pausedDrops++; return undefined }
          if (paused) {
            if (event.operation === operation && event.event === 'operation.end') endedWhilePaused = true
            pausedDrops++
            return undefined
          }
          if (writer !== current) {
            writer = current
            scoped = current.bind(operation, continuation,
              continueDiagnosticContext(context, expectedRunId ?? current.identity()?.diagnosticRunId))
            if (event.event !== 'operation.start') scoped?.emit({ event: 'operation.start', operation, reason: 'continued_after_clear', metrics: { partial: true } })
          }
          if (scoped) scoped.emit(event)
          else pausedDrops++
        } catch { pausedDrops++ }
        return undefined
      },
    })
  }
  return managed
}
export type ManagedDiagnostics = ReturnType<typeof createManagedDiagnostics>
