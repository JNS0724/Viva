import pino from 'pino'
import SonicBoomModule from 'sonic-boom'
import type { SonicBoom as SonicBoomStream } from 'sonic-boom'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, close } from 'node:fs'
import { DIAGNOSTIC_LIMITS, safeDiagnosticReason } from '../contracts.ts'
import type { DiagnosticComponent, DiagnosticContext, DiagnosticEvent, DiagnosticPort } from '../contracts.ts'
import { diagnosticContext, newDiagnosticContext } from './context.ts'
import { loadDiagnosticIdentity } from './identity.ts'
import type { DiagnosticIdentity } from './identity.ts'
import { diagnosticRecordFormatter, safeDiagnosticEvent } from './record.ts'
import { DiagnosticQuota } from './quota.ts'
import type { DiagnosticSlot } from './quota.ts'

type State = 'initializing' | 'ready' | 'stalled' | 'unavailable' | 'closed'
const SonicBoom = SonicBoomModule.default
interface Pending { event: DiagnosticEvent; context: DiagnosticContext; time: string; sequence: number; admittedAt: number }
interface Encoded { line: string; admittedAt: number }
interface Active { event: DiagnosticEvent; context: DiagnosticContext; started: number; warnedAt: number }
// Before encoding, cover UTF-16 identity storage, field containers and the transient JSON string.
// After encoding, only the actual UTF-8 destination bytes remain charged.
const PENDING_CHARGE = DIAGNOSTIC_LIMITS.eventBytes * 4
export interface DiagnosticStats { state: State; queuedBytes: number; peakQueuedBytes: number; maxWriteDelayMs: number; droppedCount: number; writtenBytes: number; activeCount: number; reason?: string }
export interface NodeDiagnostics extends DiagnosticPort {
  readonly ready: Promise<void>
  readonly quota: DiagnosticQuota
  readonly directory: string
  snapshot(): { stats: DiagnosticStats; active: Array<{ operation: string; stage?: string; ageMs: number }> }
  close(): Promise<boolean>
}

/** Pino encodes; SonicBoom writes. This adapter owns only policy and bounded accounting. */
export function createNodeDiagnostics({ directory, component, version = 'unknown', componentVersion, fileBytes = DIAGNOSTIC_LIMITS.fileBytes,
  queueBytes = DIAGNOSTIC_LIMITS.queueBytes, quota = new DiagnosticQuota(directory, { fileBytes }),
}: { directory: string; component: DiagnosticComponent; version?: string; componentVersion?: string; fileBytes?: number; queueBytes?: number; quota?: DiagnosticQuota }): NodeDiagnostics {
  const instance = randomUUID()
  let state: State = 'initializing', closing = false, draining = false, closePromise: Promise<boolean> | undefined
  let droppedCount = 0, reserved = 0, writtenBytes = 0, sequence = 0
  let peakQueuedBytes = 0, maxWriteDelayMs = 0, encodingAt = 0
  let wallMillis = -1, wallTime = ''
  let identity: DiagnosticIdentity | undefined, current: { stream: SonicBoomStream; slot: DiagnosticSlot; accepted: number; outstanding: number; writes: Array<{ bytes: number; admittedAt: number }> } | undefined
  let format: ReturnType<typeof diagnosticRecordFormatter> | undefined
  let creating = false, scheduled: ReturnType<typeof setTimeout> | undefined, encodingReserve = 0, reason: string | undefined
  let retry: ReturnType<typeof setTimeout> | undefined, failureCount = 0
  let cleanupUncertain = false
  const pending: Pending[] = [], encoded: Encoded[] = []
  const active = new Map<string, Active>()
  const explicit = new Map<string, DiagnosticContext>()
  const cleanup = new Set<Promise<void>>()
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const release = (bytes: number) => { reserved = Math.max(0, reserved - bytes) }
  const discardQueues = () => {
    droppedCount += pending.length + encoded.length
    release(pending.length * PENDING_CHARGE + encoded.reduce((sum, value) => sum + Buffer.byteLength(value.line), 0))
    pending.length = 0; encoded.length = 0
  }
  const fail = (error: unknown) => {
    reason = safeDiagnosticReason(error); state = closing ? 'closed' : 'unavailable'
    discardQueues()
    resolveReady()
    retryWhenClosed()
  }
  function retryWhenClosed() {
    if (closing || current || retry || cleanupUncertain) return
    retry = setTimeout(() => {
      retry = undefined
      if (closing) return
      void (async () => { identity ??= await loadDiagnosticIdentity(directory); await openNext() })().catch(fail)
    }, Math.min(60_000, 1000 * 2 ** Math.min(failureCount++, 6)))
    retry.unref()
  }
  const logger = pino({ base: null, timestamp: false, level: 'info', serializers: { err: () => undefined },
    redact: ['msg', 'message', 'stack', 'err', 'authorization', 'apiKey', 'token', 'password'] }, {
    write(line: string) {
      const bytes = Buffer.byteLength(line)
      const charge = encodingReserve
      encodingReserve = 0
      if (bytes > charge || bytes > DIAGNOSTIC_LIMITS.eventBytes || closing && !draining) { release(charge); droppedCount++; return }
      release(charge - bytes)
      encoded.push({ line, admittedAt: encodingAt })
    },
  }).child({ component })
  function schedule() {
    if (scheduled || state !== 'ready' || closing && !draining) return
    scheduled = setTimeout(() => { scheduled = undefined; pump() }, 5)
    scheduled.unref()
  }
  function pump() {
    if (state !== 'ready' || !current || !identity || !format || closing && !draining) return
    const oldest = pending[0]?.admittedAt ?? encoded[0]?.admittedAt
    // Prefer the gap after short business work. Hung work cannot hold its start record indefinitely.
    if (!draining && active.size && oldest !== undefined && performance.now() - oldest < 25 && reserved < queueBytes / 2) { schedule(); return }
    let batch = 0
    while (pending.length && batch++ < 64) {
      const item = pending.shift()!
      encodingReserve = PENDING_CHARGE
      encodingAt = item.admittedAt
      try {
        const record = format(item.event, item.context, item.sequence, item.time, item.admittedAt)
        if (item.event.outcome === 'failed') logger.error(record)
        else if (item.event.event === 'operation.slow' || item.event.event === 'retry.scheduled' || item.event.event === 'context.dropped') logger.warn(record)
        else logger.info(record)
      }
      catch { droppedCount++ }
      finally { if (encodingReserve) release(encodingReserve); encodingReserve = 0 }
    }
    while (encoded.length && current && state === 'ready') {
      const item = encoded[0]!, line = item.line, bytes = Buffer.byteLength(line)
      if (bytes > fileBytes) { encoded.shift(); release(bytes); droppedCount++; continue }
      if (current.accepted + bytes > fileBytes) { void rotate(); break }
      encoded.shift()
      const destination = current
      if (!destination.outstanding) lastProgress = performance.now()
      destination.accepted += bytes; destination.outstanding += bytes
      destination.writes.push({ bytes, admittedAt: item.admittedAt })
      try { destination.stream.write(line) } catch (error) { fail(error); try { destination.stream.destroy() } catch { /* Keep uncertain resources charged. */ }; return }
    }
    // Flush this batch asynchronously, rather than leaving a small tail for a periodic timer that
    // can wake during the next request and contend with business file reads in libuv's pool.
    if (current?.outstanding && state === 'ready') {
      try { current.stream.flush() } catch (error) { fail(error); try { current?.stream.destroy() } catch { /* Keep the uncertain slot charged. */ } }
    }
    if (pending.length) schedule()
  }
  async function openNext() {
    if (creating || closing && !draining) return
    creating = true
    let slot: DiagnosticSlot | undefined, descriptor: number | undefined
    try {
      if (identity && !format) format = diagnosticRecordFormatter(identity, { component, instance, version, componentVersion })
      slot = await quota.reserve(component)
      if (closing && !draining) { await quota.close(slot); return }
      // SonicBoom leaves its ready/periodic-flush lifecycle pending after an asynchronous open error.
      // Acquire exclusively first, so no stream/timer exists on failure and an existing link is never followed.
      const file = path.join(directory, slot.file)
      descriptor = await new Promise<number>((resolve, reject) => open(file, 'wx', 0o600, (error, fd) => error ? reject(error) : resolve(fd)))
      const stream = new SonicBoom({ fd: descriptor, sync: false, fsync: false,
        minLength: Math.min(4096, Math.max(0, Math.floor(fileBytes / 2))), maxLength: queueBytes, maxWrite: Math.min(DIAGNOSTIC_LIMITS.writeBytes, fileBytes),
        periodicFlush: 0, retryEAGAIN: () => false })
      const destination = { stream, slot, accepted: 0, outstanding: 0, writes: [] as Array<{ bytes: number; admittedAt: number }> }
      current = destination
      descriptor = undefined // Ownership moved to SonicBoom; only its close event can release this slot.
      const assignedSlot = slot
      stream.on('write', (bytes: number) => {
        const confirmed = Math.min(bytes, destination.outstanding)
        destination.outstanding -= confirmed; release(confirmed); writtenBytes += confirmed
        if (confirmed) failureCount = 0
        let remaining = confirmed
        while (remaining && destination.writes.length) {
          const write = destination.writes[0]!, settled = Math.min(remaining, write.bytes)
          remaining -= settled; write.bytes -= settled
          if (!write.bytes) { maxWriteDelayMs = Math.max(maxWriteDelayMs, performance.now() - write.admittedAt); destination.writes.shift() }
        }
        lastProgress = performance.now()
        if (state === 'stalled' && !closing) { state = 'ready'; reason = undefined }
        if (pending.length || encoded.length) schedule()
      })
      stream.on('drop', (data: string | Buffer) => {
        const bytes = Buffer.byteLength(data)
        destination.outstanding = Math.max(0, destination.outstanding - bytes)
        destination.accepted = Math.max(0, destination.accepted - bytes)
        release(bytes); droppedCount++
        destination.writes.pop()
      })
      stream.on('drain', () => {
        if (!destination.outstanding || current !== destination || state !== 'ready') return
        try { stream.flush() } catch (error) { fail(error); try { stream.destroy() } catch { /* Keep the uncertain slot charged. */ } }
      })
      stream.on('error', (error: unknown) => { fail(error); try { stream.destroy() } catch { /* Closure remains uncertain. */ } })
      stream.once('ready', () => { if (closing && !draining) { stream.end(); return }; state = 'ready'; reason = undefined; resolveReady(); schedule() })
      stream.once('close', () => {
        release(destination.outstanding); destination.outstanding = 0
        destination.writes.length = 0
        if (current === destination) current = undefined
        const task = quota.close(assignedSlot).then(() => { if (state === 'unavailable') retryWhenClosed() }, () => { reason = 'cleanup_pending' })
        cleanup.add(task)
        void task.finally(() => cleanup.delete(task))
      })
    } catch (error) {
      if (descriptor !== undefined) {
        const fd = descriptor
        await new Promise<void>(resolve => close(fd, error => { if (error) cleanupUncertain = true; resolve() }))
      }
      if (slot && !cleanupUncertain) await quota.close(slot).catch(() => { cleanupUncertain = true })
      fail(error)
      if (cleanupUncertain) reason = 'cleanup_pending'
    }
    finally { creating = false }
  }
  let rotating = false
  async function rotate() {
    if (rotating || !current || closing && !draining) return
    rotating = true; state = 'initializing'
    const previous = current
    try {
      await new Promise<void>(resolve => { previous.stream.once('close', resolve); previous.stream.end() })
      await Promise.all([...cleanup])
      if (!closing || draining) await openNext()
    } catch (error) { fail(error) }
    finally { rotating = false }
  }
  const timer = setInterval(() => {
    const now = performance.now()
    for (const entry of active.values()) if (now - entry.started >= DIAGNOSTIC_LIMITS.slowMs
      && (!entry.warnedAt || now - entry.warnedAt >= DIAGNOSTIC_LIMITS.slowRepeatMs)) {
      entry.warnedAt = now
      enqueue({ ...entry.event, event: 'operation.slow', metrics: { ...entry.event.metrics, durationMs: now - entry.started } }, entry.context)
    }
    if (current?.outstanding && now - lastProgress >= DIAGNOSTIC_LIMITS.slowRepeatMs) { state = 'stalled'; reason = 'sink_stalled'; discardQueues() }
  }, 1000)
  timer.unref()
  let lastProgress = performance.now()
  function enqueue(event: DiagnosticEvent, context: DiagnosticContext) {
    const critical = event.event === 'operation.start' || event.event === 'operation.end' || event.outcome === 'failed' || event.event === 'process.exit'
    const ceiling = critical ? queueBytes : Math.floor(queueBytes * 7 / 8)
    if (closing || state === 'unavailable' || state === 'stalled' || reserved + PENDING_CHARGE > ceiling) { droppedCount++; return }
    reserved += PENDING_CHARGE
    peakQueuedBytes = Math.max(peakQueuedBytes, reserved)
    const millis = Date.now()
    if (millis !== wallMillis) { wallMillis = millis; wallTime = new Date(millis).toISOString() }
    pending.push({ event, context, time: wallTime, sequence: ++sequence, admittedAt: performance.now() })
    schedule()
  }
  const runtime: NodeDiagnostics = {
    ready, quota, directory,
    emit(raw, suppliedContext) {
      try {
      if (closing) { droppedCount++; return undefined }
      let event = safeDiagnosticEvent(raw)
      if (!event) { droppedCount++; return undefined }
      let context = suppliedContext ?? diagnosticContext() ?? newDiagnosticContext()
      const key = event.identities?.operationId === undefined ? undefined : `${event.operation}:${event.identities.operationId}`
      if (key && explicit.has(key)) context = explicit.get(key)!
      else if (key && event.event === 'operation.start' && active.has(context.spanId) && active.size < DIAGNOSTIC_LIMITS.activeSpans) {
        context = newDiagnosticContext(context); explicit.set(key, context)
      }
      if (key && event.event === 'operation.start' && active.size < DIAGNOSTIC_LIMITS.activeSpans) explicit.set(key, context)
      if (event.event === 'operation.start' && active.size < DIAGNOSTIC_LIMITS.activeSpans) active.set(context.spanId, { event, context, started: performance.now(), warnedAt: 0 })
      if (event.event === 'operation.progress' || event.event === 'wait.begin') {
        const entry = active.get(context.spanId)
        if (entry) entry.event = { ...entry.event, ...(event.stage ? { stage: event.stage } : {}),
          ...(event.reason ? { reason: event.reason } : {}), identities: { ...entry.event.identities, ...event.identities }, metrics: { ...entry.event.metrics, ...event.metrics } }
      }
      if (event.event === 'operation.end') {
        const entry = active.get(context.spanId)
        if (entry?.event.stage && !event.stage) event = { ...event, stage: entry.event.stage }
        if (entry && event.metrics?.durationMs === undefined) event = { ...event, metrics: { ...event.metrics, durationMs: performance.now() - entry.started } }
        active.delete(context.spanId); if (key) explicit.delete(key)
      }
      enqueue(event, context)
      } catch { droppedCount++ }
      return undefined
    },
    snapshot: () => ({ stats: { state, queuedBytes: reserved, peakQueuedBytes, maxWriteDelayMs, droppedCount, writtenBytes, activeCount: active.size, ...(reason ? { reason } : {}) },
      active: [...active.values()].map(entry => ({ operation: entry.event.operation, ...(entry.event.stage ? { stage: entry.event.stage } : {}), ageMs: performance.now() - entry.started })) }),
    close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        clearInterval(timer); clearTimeout(retry); clearTimeout(scheduled); scheduled = undefined; retry = undefined; resolveReady()
        // Stop admission, then drain across rotations under the same total shutdown deadline.
        closing = true; draining = true
        const completed = (async () => {
          await initialization
          while (draining && (pending.length || encoded.length || creating || rotating)) {
            if (state === 'ready') pump()
            if (state === 'unavailable' || state === 'stalled' || state === 'closed') break
            if (pending.length || encoded.length || creating || rotating) await new Promise(resolve => setTimeout(resolve, 1))
          }
          draining = false
          const destination = current
          if (destination) await new Promise<void>((resolve, reject) => {
            destination.stream.once('close', resolve)
            try { destination.stream.end() } catch (error) { reject(error) }
          })
          await Promise.all([...cleanup])
          return !creating && !rotating && reason !== 'cleanup_pending'
        })().catch(() => false)
        let timeout: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([completed, new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), DIAGNOSTIC_LIMITS.shutdownMs) })])
        clearTimeout(timeout)
        draining = false; clearTimeout(scheduled); scheduled = undefined
        discardQueues(); active.clear(); explicit.clear(); state = 'closed'
        if (!result) { reason = 'cleanup_pending'; try { current?.stream.destroy() } catch { /* Quota remains charged. */ } }
        return result
      })()
      return closePromise
    },
  }
  // Neither directory I/O nor sink readiness is a business prerequisite.
  const initialization = loadDiagnosticIdentity(directory).then(value => { identity = value; lastProgress = performance.now(); return openNext() }).catch(fail)
  return runtime
}
