import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { DIAGNOSTIC_LIMITS, OPERATIONS, REASONS, STAGES, safeDiagnosticReason } from '../contracts.ts'
import type { DiagnosticComponent, DiagnosticReason } from '../contracts.ts'
import { diagnosticJsonl } from './jsonl.ts'
import { storedDiagnosticReference } from './record.ts'
import type { StoredDiagnosticReference } from './record.ts'
import type { DiagnosticQuota } from './quota.ts'
import { DIAGNOSTIC_FILE } from './quota.ts'

export type PreviousDiagnosticSpan = Omit<StoredDiagnosticReference, 'event'> & { status: 'incomplete' }
export interface DiagnosticRecoverySnapshot {
  status: 'pending' | 'complete' | 'partial' | 'unavailable'
  incompleteCount: number
  omittedCount: number
  spans: PreviousDiagnosticSpan[]
  reason?: DiagnosticReason
}

const object = (raw: unknown): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** Only pre-existing opaque aliases cross the snapshot channel; exports re-alias them exactly once. */
export function safeDiagnosticRecovery(raw: unknown): DiagnosticRecoverySnapshot | undefined {
  try {
  if (!object(raw)) return
  const { status, incompleteCount, omittedCount, spans: rawSpans, reason } = raw
  if (typeof status !== 'string' || !['pending', 'complete', 'partial', 'unavailable'].includes(status)
    || !count(incompleteCount) || !count(omittedCount) || !Array.isArray(rawSpans)) return
  const spans: PreviousDiagnosticSpan[] = []
  for (const item of rawSpans.slice(0, DIAGNOSTIC_LIMITS.previousSpans)) {
    if (!object(item)) continue
    const operation = item.operation, stage = item.stage
    if (item.status !== 'incomplete' || !(OPERATIONS as readonly unknown[]).includes(operation)) continue
    const { traceId, spanId, processInstanceId, diagnosticRunId } = item
    if (![traceId, spanId, processInstanceId, diagnosticRunId].every(value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value))) continue
    spans.push({ status: 'incomplete', operation: operation as PreviousDiagnosticSpan['operation'],
      ...((STAGES as readonly unknown[]).includes(stage) ? { stage: stage as PreviousDiagnosticSpan['stage'] } : {}),
      traceId: traceId as string, spanId: spanId as string, processInstanceId: processInstanceId as string, diagnosticRunId: diagnosticRunId as string })
  }
  return { status: status as DiagnosticRecoverySnapshot['status'], incompleteCount: Math.max(spans.length, incompleteCount),
    omittedCount, spans, ...((REASONS as readonly unknown[]).includes(reason) ? { reason: reason as DiagnosticReason } : {}) }
  } catch { return undefined }
}

/** Bounded, read-only evidence inspection. Missing diagnostic terminals never decide business recovery. */
export function createDiagnosticRecovery({ directory, component, quota, completed, timeoutMs = DIAGNOSTIC_LIMITS.snapshotMs }: {
  directory: string; component: DiagnosticComponent; quota: Pick<DiagnosticQuota, 'previous'>
  completed: (snapshot: DiagnosticRecoverySnapshot) => void; timeoutMs?: number
}) {
  let snapshot: DiagnosticRecoverySnapshot = { status: 'pending', incompleteCount: 0, omittedCount: 0, spans: [] }
  const stop = new AbortController()
  let running: Promise<void> | undefined, settled = true, closed = false
  function start(runId: string, storedRunAlias: string): void {
    if (running || closed) return
    settled = false
    const timer = setTimeout(() => {
      snapshot = { ...snapshot, status: 'partial', reason: 'timeout' }
      stop.abort(new DOMException('Diagnostic inspection deadline', 'TimeoutError'))
    }, timeoutMs)
    timer.unref()
    running = (async () => {
      const active = new Map<string, StoredDiagnosticReference>()
      let partial = false, omitted = 0, reason: DiagnosticReason | undefined
      try {
        const ranges = await quota.previous(component, runId)
        if (ranges.files.length > 128 || ranges.files.some(range => !DIAGNOSTIC_FILE.test(range.file)
          || !Number.isSafeInteger(range.cutoff) || range.cutoff < 0 || range.cutoff > DIAGNOSTIC_LIMITS.fileBytes)
          || ranges.files.reduce((sum, range) => sum + range.cutoff, 0) > DIAGNOSTIC_LIMITS.exportSourceBytes) throw Object.assign(new Error('Invalid diagnostic history range'), { code: 'invalid_record' })
        partial = ranges.partial
        if (partial) reason = 'buffer_limit'
        stop.signal.throwIfAborted()
        for (const range of ranges.files) {
          stop.signal.throwIfAborted()
          if (!range.cutoff) continue
          const file = path.join(directory, range.file)
          const info = await lstat(file)
          if (!info.isFile()) { partial = true; reason ??= 'invalid_record'; continue }
          stop.signal.throwIfAborted()
          const stream = createReadStream(file, { start: 0, end: range.cutoff - 1,
            highWaterMark: DIAGNOSTIC_LIMITS.writeBytes, signal: stop.signal })
          const actualClose = new Promise<void>(resolve => stream.once('close', resolve))
          const framing = { sourceBytesRead: 0, exportedThroughByte: 0, trailingBytesOmitted: 0, partial_trailing_record: false, invalid_record: 0 }
          try {
            for await (const raw of diagnosticJsonl(stream, framing, { cooperate: true, signal: stop.signal })) {
              stop.signal.throwIfAborted()
              const record = storedDiagnosticReference(raw)
              if (!record || record.diagnosticRunId !== storedRunAlias) { partial = true; reason ??= 'invalid_record'; continue }
              const key = `${record.processInstanceId}:${record.spanId}`
              if (record.event === 'operation.start') {
                if (active.has(key)) { omitted++; partial = true; reason ??= 'invalid_context' }
                else if (active.size < DIAGNOSTIC_LIMITS.activeSpans) active.set(key, record)
                else { omitted++; partial = true; reason ??= 'buffer_limit' }
              } else if (record.event === 'operation.end') {
                const prior = active.get(key)
                if (prior?.operation === record.operation) active.delete(key)
                else if (prior) { partial = true; reason ??= 'invalid_context' }
              }
              else if (record.stage) {
                const prior = active.get(key)
                if (prior) active.set(key, { ...prior, stage: record.stage })
              }
            }
          } finally {
            stream.destroy()
            await actualClose // An aborted caller is not proof that a pending file read actually closed.
          }
          stop.signal.throwIfAborted()
          if (framing.invalid_record || framing.partial_trailing_record || framing.sourceBytesRead < range.cutoff) {
            partial = true
            reason ??= framing.invalid_record ? 'invalid_record' : framing.partial_trailing_record ? 'partial_trailing_record' : 'gap'
          }
        }
        snapshot = { status: partial ? 'partial' : 'complete', incompleteCount: active.size, omittedCount: omitted + Math.max(0, active.size - DIAGNOSTIC_LIMITS.previousSpans),
          spans: [...active.values()].slice(0, DIAGNOSTIC_LIMITS.previousSpans).map(({ event: _event, ...span }) => ({ ...span, status: 'incomplete' })), ...(reason ? { reason } : {}) }
      } catch (error) {
        snapshot = { status: active.size || partial || stop.signal.aborted ? 'partial' : 'unavailable', incompleteCount: active.size,
          omittedCount: omitted + Math.max(0, active.size - DIAGNOSTIC_LIMITS.previousSpans), spans: [...active.values()].slice(0, DIAGNOSTIC_LIMITS.previousSpans).map(({ event: _event, ...span }) => ({ ...span, status: 'incomplete' })),
          reason: safeDiagnosticReason(stop.signal.aborted ? stop.signal.reason : error) }
      } finally {
        clearTimeout(timer); settled = true
        if (closed) snapshot = { status: 'unavailable', incompleteCount: 0, omittedCount: 0, spans: [] }
        if (!closed) { try { completed(snapshot) } catch { /* Optional observation cannot escape. */ } }
      }
    })()
  }
  return { start, snapshot: (): DiagnosticRecoverySnapshot => ({ ...snapshot, spans: snapshot.spans.map(span => ({ ...span })) }), settled: () => settled,
    close(): Promise<void> { closed = true; stop.abort(); snapshot = { status: 'unavailable', incompleteCount: 0, omittedCount: 0, spans: [] }; return running ?? Promise.resolve() } }
}
