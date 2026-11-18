import { randomUUID } from 'node:crypto'
import { COMPONENTS, DIAGNOSTIC_LIMITS, OPERATIONS, REASONS, STAGES, safeDiagnosticReason } from '../contracts.ts'
import type { DiagnosticComponent, DiagnosticEvent } from '../contracts.ts'
import { createDiagnosticHeartbeat, createDiagnosticHealthMonitor } from './health.ts'
import type { DiagnosticHealthSource } from './health.ts'
import type { NodeDiagnostics } from './logger.ts'
import { safeDiagnosticRecovery } from './recovery.ts'

export type DiagnosticSnapshot = ReturnType<NodeDiagnostics['snapshot']> & { activeOmitted?: number }
export type ComponentDiagnosticSnapshot = DiagnosticSnapshot & { component: DiagnosticComponent }
export type DiagnosticControl = 'snapshot' | 'clear.prepare' | 'clear.resume' | 'debug'
export type DiagnosticControlResult = { ok: true, snapshots?: ComponentDiagnosticSnapshot[], closed?: boolean } | { ok: false, reason: 'busy' | 'timeout' | 'closed' | 'cleanup_pending' | 'invalid_context' | 'unknown_error' }
type Send = (message: object, settled: (error?: Error | null) => void) => void
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const member = (values: readonly string[], value: unknown): value is string => typeof value === 'string' && values.includes(value)

/** Reply snapshots carry counts and fixed labels only. Bodies and even arbitrary error names are excluded. */
export function safeDiagnosticSnapshot(raw: unknown): DiagnosticSnapshot | undefined {
  try {
  if (!object(raw) || !object(raw.stats) || !Array.isArray(raw.active)) return
  const stats = raw.stats
  if (!member(['initializing', 'ready', 'stalled', 'unavailable', 'closed'], stats.state)) return
  for (const key of ['queuedBytes', 'peakQueuedBytes', 'maxWriteDelayMs', 'droppedCount', 'writtenBytes', 'activeCount', 'untrackedCount']) if (!number(stats[key])) return
  const active = raw.active.slice(0, 32).flatMap(value => object(value) && member(OPERATIONS, value.operation) && number(value.ageMs)
    ? [{ operation: value.operation, ageMs: value.ageMs, ...(member(STAGES, value.stage) ? { stage: value.stage } : {}) }] : [])
  const previous = safeDiagnosticRecovery(raw.previous)
  return { stats: { state: stats.state as DiagnosticSnapshot['stats']['state'], queuedBytes: Number(stats.queuedBytes), peakQueuedBytes: Number(stats.peakQueuedBytes),
    maxWriteDelayMs: Number(stats.maxWriteDelayMs), droppedCount: Number(stats.droppedCount), writtenBytes: Number(stats.writtenBytes), activeCount: Number(stats.activeCount), untrackedCount: Number(stats.untrackedCount),
    ...(member(REASONS, stats.reason) ? { reason: stats.reason } : {}) }, active,
    activeOmitted: Math.max(0, Number(stats.activeCount) - active.length), ...(previous ? { previous } : {}) }
  } catch { return undefined }
}
function safeComponents(raw: unknown): ComponentDiagnosticSnapshot[] | undefined {
  if (!Array.isArray(raw) || raw.length > 8) return
  const snapshots: ComponentDiagnosticSnapshot[] = []
  for (const item of raw) {
    if (!object(item) || !member(COMPONENTS, item.component)) return
    const snapshot = safeDiagnosticSnapshot(item)
    if (!snapshot || snapshots.some(prior => prior.component === item.component)) return
    snapshots.push({ component: item.component as DiagnosticComponent, ...snapshot })
  }
  return snapshots
}
interface ControlMessage { type: 'diagnostic-control', version: 1, requestId: string, operation: DiagnosticControl, clearId?: string, runId?: string, durationMs?: number }
function control(raw: unknown): ControlMessage | undefined {
  if (!object(raw) || raw.type !== 'diagnostic-control' || raw.version !== 1 || !id(raw.requestId)
    || !member(['snapshot', 'clear.prepare', 'clear.resume', 'debug'], raw.operation)
    || Object.keys(raw).some(key => !['type', 'version', 'requestId', 'operation', 'clearId', 'runId', 'durationMs'].includes(key))) return
  if (raw.operation === 'clear.prepare' && !id(raw.clearId) || raw.operation === 'clear.resume' && (!id(raw.clearId) || !id(raw.runId))) return
  if (raw.operation === 'debug' && (!number(raw.durationMs) || raw.durationMs > 15 * 60_000)) return
  if (raw.operation === 'snapshot' && raw.durationMs !== undefined && (!number(raw.durationMs) || raw.durationMs > DIAGNOSTIC_LIMITS.snapshotMs)) return
  return raw as unknown as ControlMessage
}

/** Child-side control and heartbeat share a tiny bounded IPC path, never business HTTP/effects. */
export function createDiagnosticPeer({ component, source, send, prepare, resume, debug, collect, intervalMs }: {
  component: DiagnosticComponent, source: DiagnosticHealthSource, send: Send, intervalMs?: number,
  prepare?: (clearId: string) => Promise<boolean>, resume?: (clearId: string, runId: string) => Promise<boolean>, debug?: (durationMs: number) => void,
  collect?: (durationMs: number) => Promise<ComponentDiagnosticSnapshot[]>,
}) {
  const instanceId = randomUUID()
  let active = false, closed = false, sending = false
  let queued: { message: object, settled: (error?: Error | null) => void } | undefined
  const deliver: Send = (message, settled) => {
    if (closed || sending) { settled(new Error('Diagnostic IPC is busy')); return }
    try { if (Buffer.byteLength(JSON.stringify(message)) > 64 * 1024) { settled(new Error('Diagnostic IPC is oversized')); return } }
    catch { settled(new Error('Diagnostic IPC cannot be encoded')); return }
    sending = true
    let completed = false
    const done = (error?: Error | null) => {
      if (completed) return
      completed = true; sending = false; settled(error)
      if (queued && !closed) { const next = queued; queued = undefined; deliver(next.message, next.settled) }
    }
    try { send(message, done) } catch (error) { done(error instanceof Error ? error : new Error('Diagnostic IPC failed')) }
  }
  const heartbeat = createDiagnosticHeartbeat({ component, source, instanceId, intervalMs, send: deliver })
  function receive(raw: unknown): boolean {
    if (!object(raw) || raw.type !== 'diagnostic-control') return false
    const message = control(raw)
    if (!message || closed || active) return true
    active = true
    void (async (): Promise<DiagnosticControlResult> => {
      switch (message.operation) {
        case 'snapshot': {
          if (collect) {
            const snapshots = safeComponents(await collect(message.durationMs ?? DIAGNOSTIC_LIMITS.snapshotMs))
            return snapshots ? { ok: true, snapshots } : { ok: false, reason: 'invalid_context' }
          }
          const snapshot = safeDiagnosticSnapshot(source.snapshot())
          return snapshot ? { ok: true, snapshots: [{ component, ...snapshot }] } : { ok: false, reason: 'invalid_context' }
        }
        case 'clear.prepare': return prepare ? { ok: true, closed: await prepare(message.clearId!) } : { ok: false, reason: 'invalid_context' }
        case 'clear.resume': return resume && await resume(message.clearId!, message.runId!) ? { ok: true } : { ok: false, reason: 'cleanup_pending' }
        case 'debug': debug?.(message.durationMs!); return { ok: true }
      }
    })().catch((): DiagnosticControlResult => ({ ok: false, reason: 'unknown_error' })).then(result => {
      const reply = { message: { type: 'diagnostic-control-result', version: 1, requestId: message.requestId, processInstanceId: instanceId, ...result }, settled: () => { active = false } }
      if (sending) queued = reply
      else deliver(reply.message, reply.settled)
    })
    return true
  }
  return { receive(raw: unknown) { try { return receive(raw) } catch { return false } }, close() { closed = true; heartbeat.close(); queued?.settled(); queued = undefined }, instanceId }
}

/** One actual outstanding control per child, retained after caller timeout until a terminal reply or exit. */
export function createDiagnosticChild({ component, send, observe, timeoutMs = DIAGNOSTIC_LIMITS.snapshotMs, suspectMs, intervalMs = 5_000 }: {
  component: DiagnosticComponent, send: Send, observe: (event: DiagnosticEvent) => void, timeoutMs?: number, suspectMs?: number, intervalMs?: number,
}) {
  const health = createDiagnosticHealthMonitor({ component, observe, suspectMs })
  let closed = false
  let pending: { requestId: string, key: string, operation: DiagnosticControl, expired: boolean, promise: Promise<DiagnosticControlResult>, finish(value: DiagnosticControlResult): void } | undefined
  const monitor = setInterval(health.check, intervalMs); monitor.unref()
  function request(operation: DiagnosticControl, options: Pick<ControlMessage, 'clearId' | 'runId' | 'durationMs'> = {}): Promise<DiagnosticControlResult> {
    if (closed) return Promise.resolve({ ok: false, reason: 'closed' })
    const requestId = randomUUID()
    const message = { type: 'diagnostic-control', version: 1, requestId, operation, ...options }
    if (!control(message)) return Promise.resolve({ ok: false, reason: 'invalid_context' })
    const key = JSON.stringify({ operation, ...options })
    if (pending) return !pending.expired && pending.key === key ? pending.promise : Promise.resolve({ ok: false, reason: 'busy' })
    let finish!: (value: DiagnosticControlResult) => void
    const promise = new Promise<DiagnosticControlResult>(resolve => {
      const timer = setTimeout(() => {
        if (pending?.requestId === requestId) pending.expired = true
        resolve({ ok: false, reason: 'timeout' })
      }, operation === 'snapshot' ? Math.min(timeoutMs, options.durationMs ?? timeoutMs) : timeoutMs)
      finish = value => { clearTimeout(timer); resolve(value) }
    })
    pending = { requestId, key, operation, promise, finish, expired: false }
    try { send(message, error => {
      if (error && pending?.requestId === requestId) { pending.expired = true; finish({ ok: false, reason: 'closed' }) }
    }) } catch { pending.expired = true; finish({ ok: false, reason: 'closed' }) }
    return promise
  }
  function receive(raw: unknown): boolean {
    if (health.receive(raw)) return true
    if (!object(raw) || raw.type !== 'diagnostic-control-result') return false
    if (raw.version !== 1 || !id(raw.requestId) || !id(raw.processInstanceId) || !pending || pending.requestId !== raw.requestId) return true
    let result: DiagnosticControlResult
    if (raw.ok === true) {
      let snapshots: ComponentDiagnosticSnapshot[] | undefined
      if (pending.operation === 'snapshot') {
        snapshots = safeComponents(raw.snapshots)
        if (!snapshots) return true
      }
      result = { ok: true, ...(snapshots ? { snapshots } : {}), ...(typeof raw.closed === 'boolean' ? { closed: raw.closed } : {}) }
    } else {
      const reason = safeDiagnosticReason({ code: raw.reason })
      result = { ok: false, reason: member(['busy', 'timeout', 'closed', 'cleanup_pending', 'invalid_context'], reason) ? reason as 'busy' | 'timeout' | 'closed' | 'cleanup_pending' | 'invalid_context' : 'unknown_error' }
    }
    const completed = pending; pending = undefined; completed.finish(result)
    return true
  }
  return { component, request, receive(raw: unknown) { try { return receive(raw) } catch { return false } }, health: health.snapshot,
    close() { closed = true; clearInterval(monitor); health.close(); pending?.finish({ ok: false, reason: 'closed' }); pending = undefined } }
}
export type DiagnosticChild = ReturnType<typeof createDiagnosticChild>
