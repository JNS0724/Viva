import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDiagnosticHeartbeat, createDiagnosticHealthMonitor } from '../src/diagnostics/node/health.ts'
import { parseDiagnosticHealth } from '../src/diagnostics/health.ts'
import { createDiagnosticChild, createDiagnosticPeer } from '../src/diagnostics/node/peer.ts'
import type { DiagnosticControlResult } from '../src/diagnostics/node/peer.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { beginDiagnosticOperation } from '../src/diagnostics/operation.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'
import { createManagedDiagnostics } from '../src/diagnostics/node/managed.ts'
import { createDiagnosticHub } from '../src/diagnostics/node/hub.ts'
import { createDiagnosticClearer } from '../src/diagnostics/node/clear.ts'
import { DiagnosticQuota } from '../src/diagnostics/node/quota.ts'
import { diagnosticAlias, loadDiagnosticIdentity, replaceDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'
import { continueDiagnosticContext, diagnosticBinding, diagnosticContext, emitDiagnostic, installDiagnosticPort, newDiagnosticContext, setDiagnosticBinding, withOperation } from '../src/diagnostics/node/context.ts'

const source = { snapshot: () => ({ stats: { state: 'unavailable' as const, queuedBytes: 0, peakQueuedBytes: 0, maxWriteDelayMs: 0, droppedCount: 2, writtenBytes: 0, activeCount: 1, untrackedCount: 0 },
  active: [{ operation: 'memory.dream', stage: 'recovering', ageMs: 24_000 }] }) }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const temporary = () => mkdtemp(path.join(tmpdir(), 'viva-diagnostic-health-'))

test('startup context views share one fresh continuation after a run change', t => {
  const previous = diagnosticBinding()
  t.after(() => setDiagnosticBinding(previous))
  setDiagnosticBinding(undefined)
  const original = newDiagnosticContext(), first = randomUUID(), second = randomUUID()
  const view = continueDiagnosticContext(original, first)
  const next = continueDiagnosticContext(original, second)
  assert.notEqual(next.traceId, original.traceId)
  assert.equal(continueDiagnosticContext(view, second), next)
})

test('a silent scope created before writer readiness cannot reuse its persisted trace after clear', async t => {
  const previous = diagnosticBinding()
  setDiagnosticBinding(undefined)
  const directory = await temporary(), writer = createManagedDiagnostics({ directory, component: 'backend' })
  const restore = installDiagnosticPort(writer), hub = createDiagnosticHub({ component: 'backend', writers: [{ component: 'backend', writer }] })
  t.after(async () => { hub.close(); restore(); setDiagnosticBinding(previous); await writer.close(); await rm(directory, { recursive: true, force: true }) })
  let release!: () => void, trace = ''
  const running = withOperation('memory.get', () => {
    trace = diagnosticContext()!.traceId
    return new Promise<void>(resolve => { release = resolve })
  })
  await writer.ready
  // No business continuation asks for its context between first binding and the clear.
  const before = await loadDiagnosticIdentity(directory)
  assert.equal(before.runId, diagnosticBinding())
  assert.deepEqual(await createDiagnosticClearer({ quota: writer.quota, hub, idle: () => true }).clear(), { status: 'cleared' })
  const after = await loadDiagnosticIdentity(directory)
  release(); await running
  assert.equal(await writer.close(), true)
  const text = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.ok(text.includes('continued_after_clear'))
  assert.equal(text.includes(diagnosticAlias(after, trace)), false)
})

test('a completed managed scope stays retired across clear, including an end while paused', async t => {
  const directory = await temporary()
  const writer = createManagedDiagnostics({ directory, component: 'backend' })
  t.after(async () => { await writer.close(); await rm(directory, { recursive: true, force: true }) })
  await writer.ready
  const before = writer.bind('memory.get', {})!, during = writer.bind('memory.get', {})!
  for (const scope of [before, during]) scope.emit({ event: 'operation.start', operation: 'memory.get' })
  before.emit({ event: 'operation.end', operation: 'memory.get' })
  const token = randomUUID()
  assert.equal(await writer.quota.beginClear(token), true)
  assert.equal(await writer.prepare(token), true)
  during.emit({ event: 'operation.end', operation: 'memory.get' })
  assert.equal(await writer.quota.clearClosed(), true)
  const next = await replaceDiagnosticIdentity(directory)
  assert.equal(await writer.quota.finishClear(token, next.runId), true)
  assert.equal(await writer.resume(token, next.runId), true)
  await writer.ready
  for (const scope of [before, during]) scope.emit({ event: 'operation.progress', operation: 'memory.get' })
  assert.equal(writer.snapshot().stats.activeCount, 0)
})

test('resume rejects a retired remote context before its replacement writer finishes initialization', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createManagedDiagnostics({ directory, component: 'backend' }); t.after(() => writer.close())
  await writer.ready
  const before = await loadDiagnosticIdentity(directory), token = randomUUID()
  assert.equal(await writer.quota.beginClear(token), true)
  assert.equal(await writer.prepare(token), true)
  assert.equal(await writer.quota.clearClosed(), true)
  const after = await replaceDiagnosticIdentity(directory)
  assert.equal(await writer.quota.finishClear(token, after.runId), true)
  assert.equal(await writer.resume(token, after.runId), true)
  assert.equal(writer.identity(), undefined, 'exercise the actual replacement initialization window')
  writer.emit({ event: 'operation.start', operation: 'memory.get', metrics: { count: 111 } },
    { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), diagnosticRunId: before.runId })
  assert.equal(writer.snapshot().stats.activeCount, 0, 'the known new run must reject the retired message immediately')
  await writer.ready
  writer.emit({ event: 'operation.progress', operation: 'memory.get', metrics: { count: 222 } },
    { version: 1, traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), diagnosticRunId: after.runId })
  assert.equal(await writer.close(), true)
  const output = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.doesNotMatch(output, /"count":111/)
  assert.match(output, /"count":222/)
})

test('a failed sink remains independently responsive; pending heartbeat IPC is strictly bounded', () => {
  let now = 0, settled: ((error?: Error | null) => void) | undefined
  const messages: unknown[] = []
  const heartbeat = createDiagnosticHeartbeat({ component: 'dsh', source, now: () => now, intervalMs: 1_000_000,
    send(message, done) { messages.push(message); settled = done } })
  try {
    for (let i = 0; i < 1000; i++) heartbeat.pulse()
    assert.equal(messages.length, 1)
    assert.equal(heartbeat.state().inFlight, true)
    assert.equal(parseDiagnosticHealth(messages[0])?.sinkState, 'unavailable')
    assert.equal(parseDiagnosticHealth(messages[0])?.oldestStage, 'recovering')
    assert.equal(parseDiagnosticHealth({ ...parseDiagnosticHealth(messages[0]), text: 'SECRET' }), undefined)
    settled?.(new Error('SENSITIVE'))
    now = 3_000_000; heartbeat.pulse()
    assert.equal(messages.length, 2)
    assert.equal(parseDiagnosticHealth(messages[1])?.processInstanceId, parseDiagnosticHealth(messages[0])?.processInstanceId)
    assert.ok(heartbeat.state().droppedCount >= 1001)
  } finally { heartbeat.close() }
})

test('supervisor detects silence once, records recovery, and never mutates business work', () => {
  let now = 0
  const events: DiagnosticEvent[] = []
  const monitor = createDiagnosticHealthMonitor({ component: 'dsh', observe: event => { events.push(event); throw new Error('sink failed') }, now: () => now })
  now = 14_999; monitor.check(); assert.equal(events.length, 0)
  now++; monitor.check(); monitor.check(); assert.equal(events.length, 1)
  const heartbeat = createDiagnosticHeartbeat({ component: 'dsh', source, send(message, settled) { monitor.receive(message); settled() } })
  assert.equal(monitor.snapshot().status, 'responsive')
  assert.equal(events.at(-1)?.stage, 'ready')
  heartbeat.close(); monitor.close()
  now += 1_000_000; monitor.check(); assert.equal(events.length, 3)
})

test('expired diagnostic controls retain actual execution capacity until the late terminal or exit', async () => {
  const messages: Array<Record<string, unknown>> = []
  const child = createDiagnosticChild({ component: 'dsh', timeoutMs: 15, observe() {}, send(message, settled) { messages.push(message as Record<string, unknown>); settled() } })
  try {
    const first = child.request('snapshot')
    assert.equal(child.request('snapshot'), first)
    assert.deepEqual(await first, { ok: false, reason: 'timeout' })
    assert.deepEqual(await child.request('snapshot'), { ok: false, reason: 'busy' })
    assert.equal(messages.length, 1)
    child.receive({ type: 'diagnostic-control-result', version: 1, processInstanceId: randomUUID(), requestId: messages[0]!.requestId, ok: true,
      snapshots: [{ component: 'dsh', ...source.snapshot() }] })
    const fresh = child.request('debug', { durationMs: 0 })
    assert.equal(messages.length, 2)
    child.close()
    assert.deepEqual(await fresh, { ok: false, reason: 'closed' })
  } finally { child.close() }
})

test('control responses wait behind only one heartbeat; sensitive fields are never forwarded', async () => {
  const sent: object[] = [], completions: Array<(error?: Error | null) => void> = []
  const peer = createDiagnosticPeer({ component: 'dsh', source, send(message, done) { sent.push(message); completions.push(done) } })
  try {
    peer.receive({ type: 'diagnostic-control', version: 1, requestId: randomUUID(), operation: 'snapshot' })
    await delay(1)
    assert.equal(sent.length, 1, 'reply is held while the initial health message awaits confirmation')
    completions[0]!()
    assert.equal(sent.length, 2)
    assert.ok(JSON.stringify(sent[1]).includes('memory.dream'))
    for (let i = 0; i < 100; i++) peer.receive({ type: 'diagnostic-control', version: 1, requestId: randomUUID(), operation: 'snapshot', secret: 'CANARY' })
    assert.equal(sent.length, 2)
    assert.equal(JSON.stringify(sent).includes('CANARY'), false)
  } finally { peer.close() }
})

test('clear gate excludes new and stale-generation writers, export pins and unknown active writers', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const quota = new DiagnosticQuota(directory), oldRun = randomUUID(), nextRun = randomUUID(), clearId = randomUUID()
  const slot = await quota.reserve('dsh', oldRun)
  assert.equal(await quota.beginClear(clearId), true)
  await assert.rejects(quota.reserve('worker', oldRun), { code: 'busy' })
  await assert.rejects(quota.pin(process.pid), { code: 'busy' })
  assert.equal(await quota.clearClosed(), false)
  assert.equal(await quota.finishClear(clearId, nextRun), false)
  await quota.close(slot)
  assert.equal(await quota.clearClosed(), true)
  assert.equal(await quota.finishClear(clearId, nextRun), true)
  await assert.rejects(quota.reserve('worker', oldRun), { code: 'epoch_changed' })
  await quota.close(await quota.reserve('worker', nextRun))
})

test('clear waits for every component, rotates aliases, preserves ongoing work and rebinds its continuation', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createManagedDiagnostics({ directory, component: 'backend' })
  const restore = installDiagnosticPort(writer)
  const hub = createDiagnosticHub({ component: 'backend', writers: [{ component: 'backend', writer }] })
  t.after(async () => { hub.close(); restore(); await writer.close() })
  await writer.ready
  const before = await loadDiagnosticIdentity(directory)
  let release!: () => void, completed = false
  let trace: string | undefined
  const work = withOperation('memory.get', async () => {
    trace = diagnosticContext()?.traceId
    await new Promise<void>(resolve => { release = resolve })
    completed = true
    return 42
  })
  const clearer = createDiagnosticClearer({ quota: writer.quota, hub, idle: () => true })
  assert.deepEqual(await clearer.clear(), { status: 'cleared' })
  assert.equal(completed, false)
  const after = await loadDiagnosticIdentity(directory)
  assert.notEqual(after.runId, before.runId)
  assert.notEqual(diagnosticAlias(before, 'same-business-id'), diagnosticAlias(after, 'same-business-id'))
  release(); assert.equal(await work, 42)
  await writer.close()
  const lines = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.ok(lines.includes('continued_after_clear'))
  assert.equal(lines.includes(diagnosticAlias(after, trace!)), false, 'the old trace must not be rebound through a new salt')
})

for (const kind of ['node', 'portable'] as const) test(`${kind} bound fields become an explicit partial continuation after clear without reusing aliases`, async t => {
  const directory = await temporary()
  const writer = createManagedDiagnostics({ directory, component: 'backend' })
  const restore = installDiagnosticPort(writer)
  const hub = createDiagnosticHub({ component: 'backend', writers: [{ component: 'backend', writer }] })
  t.after(async () => { hub.close(); restore(); await writer.close(); await rm(directory, { recursive: true, force: true }) })
  await writer.ready
  const before = await loadDiagnosticIdentity(directory), secret = 'PRIVATE_CLEARED_BOUND_RESOURCE'
  const fields = { stage: 'extract' as const, identities: { operationId: 'PRIVATE_CLEARED_BOUND_OPERATION', resourceId: secret } }
  let release!: () => void
  const observation = kind === 'portable' ? beginDiagnosticOperation(writer, 'memory.dream', fields) : undefined
  const running = kind === 'node' ? withOperation('memory.dream', () => new Promise<void>(resolve => { release = resolve }), fields) : undefined
  assert.equal(writer.snapshot().stats.activeCount, 1)
  const clearer = createDiagnosticClearer({ quota: writer.quota, hub, idle: () => true })
  assert.deepEqual(await clearer.clear(), { status: 'cleared' })
  const after = await loadDiagnosticIdentity(directory)
  if (observation) {
    observation.progress({ stage: 'verify' })
    assert.equal(writer.snapshot().stats.activeCount, 1)
    observation.end()
  } else { release(); await running }
  assert.equal(writer.snapshot().stats.activeCount, 0)
  await writer.ready
  withOperation('memory.dream', () => 42, fields)
  assert.equal(await writer.close(), true)
  const text = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  const records = text.trim().split('\n').map(line => JSON.parse(line) as { event: string, operation: string, reason?: string, stage?: string,
    metrics?: { partial?: boolean }, identities?: { resourceId?: string, operationId?: string } })
  const ends = records.filter(record => record.event === 'operation.end' && record.operation === 'memory.dream')
  assert.equal(ends.length, 2)
  assert.equal(ends[0]!.reason, 'continued_after_clear')
  assert.equal(ends[0]!.metrics?.partial, true)
  assert.equal(ends[0]!.identities?.resourceId, undefined)
  assert.equal(ends[0]!.identities?.operationId, undefined)
  if (observation) assert.equal(ends[0]!.stage, 'verify')
  assert.equal(ends[1]!.identities?.resourceId, diagnosticAlias(after, secret))
  assert.ok(!text.includes(diagnosticAlias(before, secret)))
  assert.ok(!text.includes(diagnosticAlias(after, diagnosticAlias(before, secret))))
  assert.ok(!text.includes('PRIVATE_'))
})

test('a hung clear remains single-flight beyond caller timeout and cannot report success early', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const quota = new DiagnosticQuota(directory)
  let prepares = 0, release!: (value: boolean) => void
  const clearer = createDiagnosticClearer({ quota, idle: () => true, timeoutMs: 15,
    hub: { prepare() { prepares++; return new Promise<boolean>(resolve => { release = resolve }) }, resume: async () => true } })
  assert.deepEqual(await clearer.clear(), { status: 'cleanup_pending' })
  assert.deepEqual(await clearer.clear(), { status: 'cleanup_pending' })
  assert.equal(prepares, 1)
  release(true)
  for (let i = 0; i < 100 && clearer.pending(); i++) await delay(5)
  assert.equal(clearer.pending(), false)
})

test('resume retry preserves the new generation and does not delete newly written records', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const quota = new DiagnosticQuota(directory)
  let prepares = 0, resumes = 0
  const clearer = createDiagnosticClearer({ quota, idle: () => true, hub: {
    prepare: async () => { prepares++; return true }, resume: async () => ++resumes > 1,
  } })
  assert.deepEqual(await clearer.clear(), { status: 'cleanup_pending' })
  const runId = (await loadDiagnosticIdentity(directory)).runId
  assert.deepEqual(await clearer.clear(), { status: 'cleared' })
  assert.equal((await loadDiagnosticIdentity(directory)).runId, runId)
  assert.equal(prepares, 1)
})

test('debug is time limited, metadata only, and disabled again after its deadline', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createManagedDiagnostics({ directory, component: 'backend' }); t.after(() => writer.close())
  await writer.ready
  writer.emit({ event: 'state.changed', operation: 'diagnostics', debug: true, metrics: { count: 1 } })
  writer.setDebug(15)
  writer.emit({ event: 'state.changed', operation: 'diagnostics', debug: true, metrics: { count: 2 } })
  await delay(25)
  writer.emit({ event: 'state.changed', operation: 'diagnostics', debug: true, metrics: { count: 3 } })
  await writer.close()
  const lines = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { metrics?: { count?: number } })
  assert.deepEqual(lines.map(line => line.metrics?.count), [2])
})


test('an operation first bound during startup receives a fresh trace after clear', t => {
  const previous = diagnosticBinding(), run = randomUUID(), next = randomUUID()
  const contexts: Array<{ trace?: string, run?: string }> = []
  t.after(() => setDiagnosticBinding(previous))
  setDiagnosticBinding(undefined)
  t.after(installDiagnosticPort(recordingDiagnosticPort((_event, context) => { contexts.push({ trace: context?.traceId, run: context?.diagnosticRunId }); return undefined })))
  withOperation('memory.get', () => {
    setDiagnosticBinding(run)
    emitDiagnostic({ event: 'operation.progress', operation: 'memory.get' }, diagnosticContext())
    const before = diagnosticContext()!.traceId
    setDiagnosticBinding(next)
    assert.notEqual(diagnosticContext()!.traceId, before)
  })
  assert.equal(contexts.at(-1)?.run, next)
  assert.notEqual(contexts.at(-1)?.trace, contexts[0]?.trace)
})
