/** Portable, content-free diagnostics. These identities never authorize business work. */
export const DIAGNOSTIC_VERSION = 1
export const DIAGNOSTIC_LIMITS = Object.freeze({
  eventBytes: 8 * 1024, queueBytes: 4 * 1024 * 1024, writeBytes: 64 * 1024,
  directoryBytes: 100 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, writers: 8,
  retentionMs: 7 * 86_400_000, activeSpans: 2048, previousSpans: 16, slowMs: 2000, slowRepeatMs: 30_000,
  shutdownMs: 2000, exportMs: 30_000, snapshotMs: 2000,
  exportSourceBytes: 32 * 1024 * 1024, exportOutputBytes: 40 * 1024 * 1024,
})
export const COMPONENTS = ['shell', 'renderer', 'backend', 'dsh', 'memory', 'worker'] as const
export type DiagnosticComponent = typeof COMPONENTS[number]
export const OPERATIONS = [
  'startup', 'shutdown', 'process', 'ipc', 'http', 'sse', 'host.catchup',
  'conversation', 'conversation.send', 'conversation.cancel', 'conversation.resume',
  'task', 'task.route', 'task.report', 'schedule', 'memory.get', 'memory.owner',
  'memory.recover', 'memory.intake', 'memory.daily', 'memory.dream', 'memory.recall',
  'memory.write', 'memory.forget', 'memory.undo', 'memory.clarify', 'memory.index',
  'memory.fence', 'memory.transport', 'effects', 'storage', 'embedding', 'model',
  'tool', 'mcp', 'plugin', 'window', 'island', 'diagnostics', 'diagnostics.export', 'diagnostics.clear',
] as const
export type DiagnosticOperation = typeof OPERATIONS[number]
export const EVENTS = ['operation.start', 'operation.end', 'operation.progress', 'operation.slow',
  'wait.begin', 'wait.end', 'retry.scheduled', 'state.changed', 'process.start', 'process.exit',
  'context.dropped', 'sink.status', 'diagnostics.cleared', 'health'] as const
export type DiagnosticEventName = typeof EVENTS[number]
export const STAGES = ['start', 'ready', 'connecting', 'recovering', 'unavailable', 'closed',
  'profile', 'onboarding', 'cleanup', 'revision', 'file-profile', 'extract', 'integrate', 'verify', 'tag',
  'queued', 'running', 'deferred', 'waiting', 'draining', 'sending', 'settled', 'injected',
  'received', 'responded', 'applied', 'first-response', 'complete', 'failed', 'paused',
  'claim', 'dispatch', 'report', 'checkpoint', 'lexical', 'vector', 'fusion', 'relations', 'rebuild'] as const
export type DiagnosticStage = typeof STAGES[number]
export const REASONS = ['unknown_error', 'aborted', 'timeout', 'unavailable', 'not_ready',
  'invalid_context', 'unknown_version', 'transport_budget', 'invalid_record', 'partial_trailing_record',
  'queue_full', 'quota_full', 'sink_stalled', 'sink_error', 'serialization_failed', 'oversized',
  'busy', 'stale', 'denied', 'model_failed', 'validation_failed', 'source_changed',
  'deferred', 'retry', 'external_wake', 'closed', 'epoch_changed', 'process_exited', 'late',
  'ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EAGAIN', 'EIO', 'ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EMFILE', 'ENFILE', 'cleanup_pending',
  'continued_after_clear', 'normal', 'gap', 'buffer_limit', 'idempotent', 'incomplete'] as const
export type DiagnosticReason = typeof REASONS[number]
export const ID_KEYS = ['requestId', 'operationId', 'sessionId', 'conversationId', 'taskId', 'taskRunId',
  'jobId', 'ownerEpoch', 'generation', 'methodId', 'resourceId', 'blockingSpanId', 'readBatchId'] as const
export type DiagnosticId = typeof ID_KEYS[number]
export const METRIC_KEYS = ['count', 'attempt', 'retryDelayMs', 'durationMs', 'pendingCount', 'queueDepth',
  'oldestMs', 'completedCount', 'remainingCount', 'statusCode', 'eventCursor', 'mark', 'bytes',
  'businessBytes', 'diagnosticBytes', 'droppedCount', 'activeCount', 'eventLoopDelayMs',
  'ok', 'blocked', 'late', 'stale', 'partial'] as const
export type DiagnosticMetric = typeof METRIC_KEYS[number]
export type DiagnosticOutcome = 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'late_completed'
export interface DiagnosticContext {
  version: typeof DIAGNOSTIC_VERSION
  traceId: string
  spanId: string
  parentSpanId?: string
  diagnosticRunId?: string
}
export interface DiagnosticFields {
  stage?: DiagnosticStage
  reason?: DiagnosticReason
  outcome?: DiagnosticOutcome
  identities?: Partial<Record<DiagnosticId, string | number | null>>
  metrics?: Partial<Record<DiagnosticMetric, number | boolean>>
}
export interface DiagnosticEvent extends DiagnosticFields {
  event: DiagnosticEventName
  operation: DiagnosticOperation
  debug?: true
}
export interface DiagnosticPort { emit(event: DiagnosticEvent, context?: DiagnosticContext): undefined }
export const NO_DIAGNOSTICS: DiagnosticPort = Object.freeze({ emit: (_event: DiagnosticEvent) => undefined })
export function guardDiagnosticPort(port: DiagnosticPort = NO_DIAGNOSTICS): DiagnosticPort {
  if (port === NO_DIAGNOSTICS) return port
  return { emit(event, context) { try { port.emit(event, context) } catch { /* Diagnostics cannot change a business outcome. */ }; return undefined } }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** No parser error or rejected value may escape into either business or logs. */
export function parseDiagnosticContext(value: unknown): DiagnosticContext | undefined {
  try {
    if (!record(value) || Object.keys(value).some(key => !['version', 'traceId', 'spanId', 'parentSpanId', 'diagnosticRunId'].includes(key))) return
    if (value.version !== DIAGNOSTIC_VERSION || typeof value.traceId !== 'string' || !/^[a-f0-9]{32}$/.test(value.traceId)
      || typeof value.spanId !== 'string' || !/^[a-f0-9]{16}$/.test(value.spanId)
      || value.parentSpanId !== undefined && (typeof value.parentSpanId !== 'string' || !/^[a-f0-9]{16}$/.test(value.parentSpanId))
      || value.diagnosticRunId !== undefined && (typeof value.diagnosticRunId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.diagnosticRunId))) return
    return { version: DIAGNOSTIC_VERSION, traceId: value.traceId, spanId: value.spanId,
      ...(typeof value.parentSpanId === 'string' ? { parentSpanId: value.parentSpanId } : {}),
      ...(typeof value.diagnosticRunId === 'string' ? { diagnosticRunId: value.diagnosticRunId } : {}) }
  } catch { return undefined }
}
/** The sole removable field. Unknown business fields remain available to their strict decoder. */
export function separateDiagnosticEnvelope(value: Record<string, unknown>) {
  const { diagnostics, ...business } = value
  const context = parseDiagnosticContext(diagnostics)
  return { business, context, dropped: diagnostics !== undefined && !context }
}
const nativeExceptionName = typeof DOMException === 'function' ? Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get : undefined
const ownData = (value: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(value, key)
  return property && 'value' in property ? property.value : undefined
}
export function safeDiagnosticReason(error: unknown): DiagnosticReason {
  try {
    if (!record(error)) return 'unknown_error'
    const code = ownData(error, 'code'), reason = ownData(error, 'reason')
    const sqliteCode = ownData(error, 'errcode')
    if (code === 'ERR_SQLITE_ERROR' && typeof sqliteCode === 'number' && Number.isSafeInteger(sqliteCode) && [5, 6].includes(sqliteCode & 255)) return 'busy'
    let name = ownData(error, 'name')
    if (typeof code === 'string' && (REASONS as readonly string[]).includes(code)) return code as DiagnosticReason
    if (name === 'AbortError') return 'aborted'
    if (name === 'TimeoutError') return 'timeout'
    // Fixed classifications only: never copy a provider's free-form reason.
    if (reason === 'dispatch-denied') return 'denied'
    if (reason === 'aborted') return 'aborted'
    if (reason === 'timeout') return 'timeout'
    if (reason === 'oversize-reply') return 'oversized'
    if (typeof reason === 'string' && ['max-tokens', 'tool-calls', 'error', 'missing-finish', 'call-failed', 'missing-reply'].includes(reason)) return 'model_failed'
    if (name === undefined && nativeExceptionName) { try { name = nativeExceptionName.call(error) } catch { /* Not a native DOMException. */ } }
    if (name === 'AbortError') return 'aborted'
    if (name === 'TimeoutError') return 'timeout'
  } catch { /* An error can have throwing accessors. */ }
  return 'unknown_error'
}
