import { COMPONENTS, STAGES } from './contracts.ts'
import type { DiagnosticComponent, DiagnosticStage } from './contracts.ts'

export const HEALTH_INTERVAL_MS = 5_000
export const HEALTH_SUSPECT_MS = 15_000
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
export interface DiagnosticHealth {
  type: 'diagnostic-health'
  version: 1
  component: DiagnosticComponent
  processInstanceId: string
  diagnosticRunId?: string
  eventLoopDelayMs: number
  activeCount: number
  oldestMs: number
  oldestStage?: DiagnosticStage
  sinkState: 'initializing' | 'ready' | 'stalled' | 'unavailable' | 'closed'
  droppedCount: number
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const bounded = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
/** Reject unknown fields and bodies; this control protocol carries metadata only. */
export function parseDiagnosticHealth(raw: unknown): DiagnosticHealth | undefined {
  try {
  if (!object(raw) || raw.type !== 'diagnostic-health' || raw.version !== 1
    || Object.keys(raw).some(key => !['type', 'version', 'component', 'processInstanceId', 'diagnosticRunId', 'eventLoopDelayMs', 'activeCount', 'oldestMs', 'oldestStage', 'sinkState', 'droppedCount'].includes(key))
    || !(COMPONENTS as readonly unknown[]).includes(raw.component)
    || typeof raw.processInstanceId !== 'string' || !UUID.test(raw.processInstanceId)
    || raw.diagnosticRunId !== undefined && (typeof raw.diagnosticRunId !== 'string' || !UUID.test(raw.diagnosticRunId))
    || !bounded(raw.eventLoopDelayMs) || !bounded(raw.activeCount) || !bounded(raw.oldestMs) || !bounded(raw.droppedCount)
    || !['initializing', 'ready', 'stalled', 'unavailable', 'closed'].includes(String(raw.sinkState))
    || raw.oldestStage !== undefined && !(STAGES as readonly unknown[]).includes(raw.oldestStage)) return
  return { type: 'diagnostic-health', version: 1, component: raw.component as DiagnosticComponent,
    processInstanceId: raw.processInstanceId, ...(typeof raw.diagnosticRunId === 'string' ? { diagnosticRunId: raw.diagnosticRunId } : {}),
    eventLoopDelayMs: Number(raw.eventLoopDelayMs), activeCount: Number(raw.activeCount), oldestMs: Number(raw.oldestMs),
    ...(raw.oldestStage ? { oldestStage: raw.oldestStage as DiagnosticStage } : {}),
    sinkState: raw.sinkState as DiagnosticHealth['sinkState'], droppedCount: Number(raw.droppedCount) }
  } catch { return undefined }
}
