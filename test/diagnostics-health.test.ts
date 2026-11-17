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
import { createManagedDiagnostics } from '../src/diagnostics/node/managed.ts'
import { createDiagnosticHub } from '../src/diagnostics/node/hub.ts'
import { createDiagnosticClearer } from '../src/diagnostics/node/clear.ts'
import { DiagnosticQuota } from '../src/diagnostics/node/quota.ts'
import { diagnosticAlias, loadDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'
import { diagnosticBinding, diagnosticContext, emitDiagnostic, installDiagnosticPort, setDiagnosticBinding, withOperation } from '../src/diagnostics/node/context.ts'

const source = { snapshot: () => ({ stats: { state: 'unavailable' as const, queuedBytes: 0, peakQueuedBytes: 0, maxWriteDelayMs: 0, droppedCount: 2, writtenBytes: 0, activeCount: 1, untrackedCount: 0 },
  active: [{ operation: 'memory.dream', stage: 'recovering', ageMs: 24_000 }] }) }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const temporary = () => mkdtemp(path.join(tmpdir(), 'viva-diagnostic-health-'))

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
  t.after(installDiagnosticPort({ emit(_event, context) { contexts.push({ trace: context?.traceId, run: context?.diagnosticRunId }); return undefined } }))
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
