import { randomUUID } from 'node:crypto'
import { HEALTH_INTERVAL_MS, HEALTH_SUSPECT_MS, parseDiagnosticHealth } from '../health.ts'
import type { DiagnosticHealth } from '../health.ts'
import type { DiagnosticComponent, DiagnosticEvent, DiagnosticStage } from '../contracts.ts'
import type { NodeDiagnostics } from './logger.ts'

export interface DiagnosticHealthSource {
  snapshot(): ReturnType<NodeDiagnostics['snapshot']>
  identity?(): { processInstanceId: string, diagnosticRunId: string } | undefined
}
/** At most one metadata message waits for IPC confirmation. A stuck IPC path never accumulates heartbeats. */
export function createDiagnosticHeartbeat({ component, source, send, instanceId = randomUUID(), intervalMs = HEALTH_INTERVAL_MS, now = performance.now.bind(performance) }: {
  component: DiagnosticComponent, source: DiagnosticHealthSource,
  send: (message: DiagnosticHealth, settled: (error?: Error | null) => void) => void,
  instanceId?: string, intervalMs?: number, now?: () => number,
}) {
  let last = now(), inFlight = false, closed = false, droppedCount = 0
  function pulse() {
    if (closed) return
    const at = now(), eventLoopDelayMs = Math.max(0, at - last - intervalMs); last = at
    if (inFlight) { droppedCount++; return }
    try {
      const snapshot = source.snapshot(), identity = source.identity?.()
      const oldest = snapshot.active.reduce<ReturnType<NodeDiagnostics['snapshot']>['active'][number] | undefined>((prior, value) => !prior || value.ageMs > prior.ageMs ? value : prior, undefined)
      const message: DiagnosticHealth = { type: 'diagnostic-health', version: 1, component,
        processInstanceId: instanceId,
        ...(identity ? { diagnosticRunId: identity.diagnosticRunId } : {}), eventLoopDelayMs,
        activeCount: snapshot.stats.activeCount, oldestMs: Math.max(0, oldest?.ageMs ?? 0),
        ...(oldest?.stage ? { oldestStage: oldest.stage as DiagnosticStage } : {}),
        sinkState: snapshot.stats.state, droppedCount: snapshot.stats.droppedCount + droppedCount }
      if (!parseDiagnosticHealth(message)) { droppedCount++; return }
      inFlight = true
      send(message, error => { inFlight = false; if (error) droppedCount++ })
    } catch { inFlight = false; droppedCount++ }
  }
  const timer = setInterval(pulse, intervalMs); timer.unref()
  pulse()
  return { pulse, state: () => ({ inFlight, droppedCount }), close() { closed = true; clearInterval(timer) } }
}

/** A supervisor's clock detects unresponsive children independently of the child's file sink. */
export function createDiagnosticHealthMonitor({ component, observe, now = performance.now.bind(performance), suspectMs = HEALTH_SUSPECT_MS }: {
  component: DiagnosticComponent, observe: (event: DiagnosticEvent) => void, now?: () => number, suspectMs?: number,
}) {
  let receivedAt = now(), current: DiagnosticHealth | undefined, suspect = false, closed = false
  const record = (event: DiagnosticEvent) => { try { observe(event) } catch { /* Supervision never changes business lifecycle. */ } }
  return {
    receive(raw: unknown): boolean {
      const value = parseDiagnosticHealth(raw)
      if (!value || value.component !== component || closed) return false
      if (current?.sinkState !== value.sinkState && ['stalled', 'unavailable'].includes(value.sinkState)) record({
        event: 'sink.status', operation: 'diagnostics', stage: 'unavailable', reason: value.sinkState === 'stalled' ? 'sink_stalled' : 'sink_error',
        identities: { resourceId: value.processInstanceId }, metrics: { droppedCount: value.droppedCount },
      })
      receivedAt = now(); current = value
      if (suspect) record({ event: 'health', operation: 'process', stage: 'ready', reason: 'normal', identities: { resourceId: value.processInstanceId } })
      suspect = false; return true
    },
    check() {
      if (!closed && !suspect && now() - receivedAt >= suspectMs) {
        suspect = true
        record({ event: 'health', operation: 'process', stage: 'unavailable', reason: 'timeout',
          identities: { resourceId: current?.processInstanceId ?? component }, metrics: { oldestMs: now() - receivedAt } })
      }
    },
    snapshot: () => ({ component, status: closed ? 'exited' as const : suspect ? 'suspect' as const : current ? 'responsive' as const : 'awaiting' as const,
      ageMs: Math.max(0, now() - receivedAt), ...(current ? { health: current } : {}) }),
    close() { closed = true },
  }
}
