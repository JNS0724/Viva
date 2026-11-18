import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fork } from 'node:child_process'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { DIAGNOSTIC_LIMITS } from '../src/diagnostics/contracts.ts'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { createDiagnosticRecovery, safeDiagnosticRecovery } from '../src/diagnostics/node/recovery.ts'
import { DiagnosticQuota } from '../src/diagnostics/node/quota.ts'
import { diagnosticJsonl } from '../src/diagnostics/node/jsonl.ts'
import { safeDiagnosticSnapshot } from '../src/diagnostics/node/peer.ts'
import { diagnosticAlias, loadDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'
import { writeDiagnosticBundle } from '../src/diagnostics/node/bundle.ts'
import { eventually } from './fixtures/eventually.ts'
import { unzipStored } from './fixtures/diagnostic-zip.ts'

const temporary = () => mkdtemp(path.join(tmpdir(), 'viva-diagnostic-recovery-'))
const context = (index: number) => ({ version: 1 as const, traceId: 'a'.repeat(32), spanId: index.toString(16).padStart(16, '0') })

test('full activity tracking preserves existing spans and reports separately omitted starts', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createNodeDiagnostics({ directory, component: 'memory' }); t.after(() => writer.close())
  for (let index = 1; index <= DIAGNOSTIC_LIMITS.activeSpans + 3; index++) writer.emit({ event: 'operation.start', operation: 'memory.get',
    stage: index === 1 ? 'profile' : index <= DIAGNOSTIC_LIMITS.activeSpans ? 'onboarding' : 'failed' }, context(index))
  assert.equal(writer.snapshot().stats.activeCount, DIAGNOSTIC_LIMITS.activeSpans)
  assert.equal(writer.snapshot().stats.untrackedCount, 3)
  assert.equal(writer.snapshot().active.filter(span => span.stage === 'profile').length, 1)
  assert.equal(writer.snapshot().active.some(span => span.stage === 'failed'), false)
  writer.emit({ event: 'operation.start', operation: 'task', stage: 'failed', identities: { operationId: 'overflow-child' } }, context(1))
  writer.emit({ event: 'operation.end', operation: 'task', identities: { operationId: 'overflow-child' } }, context(1))
  writer.emit({ event: 'operation.end', operation: 'task' }, context(1))
  assert.equal(writer.snapshot().stats.activeCount, DIAGNOSTIC_LIMITS.activeSpans, 'an untracked child terminal cannot retire an existing parent')
  assert.equal(writer.snapshot().active.filter(span => span.stage === 'profile').length, 1)
  writer.emit({ event: 'operation.end', operation: 'memory.get' }, context(1))
  writer.emit({ event: 'operation.start', operation: 'memory.get', stage: 'file-profile' }, context(9000))
  assert.equal(writer.snapshot().stats.activeCount, DIAGNOSTIC_LIMITS.activeSpans)
  assert.equal(writer.snapshot().stats.untrackedCount, 4)
  assert.equal(safeDiagnosticSnapshot(writer.snapshot())?.stats.untrackedCount, 4)
  await writer.ready
})

test('a killed prior writer is marked incomplete without changing an already committed business receipt', { timeout: 10_000 }, async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const receipt = path.join(directory, 'business-receipt.json'), body = '{"committed":true}'
  await writeFile(receipt, body)
  const child = fork(fileURLToPath(new URL('./fixtures/diagnostics-recovery-writer.ts', import.meta.url)), [directory], {
    execPath: process.execPath, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
  t.after(async () => { child.kill(); await exit })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned diagnostic writer did not persist')), 4000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('message', () => { clearTimeout(timer); resolve() })
  })
  child.kill('SIGKILL'); await exit
  const next = createNodeDiagnostics({ directory, component: 'memory' }); t.after(() => next.close())
  await next.ready
  assert.ok(await eventually(() => next.snapshot().previous?.status !== 'pending', { timeoutMs: 3000, intervalMs: 5 }))
  const previous = next.snapshot().previous!
  assert.equal(previous.status, 'complete'); assert.equal(previous.incompleteCount, 1)
  assert.equal(previous.spans[0]!.status, 'incomplete'); assert.equal(previous.spans[0]!.operation, 'memory.write')
  assert.equal(previous.spans[0]!.stage, 'checkpoint')
  const identity = await loadDiagnosticIdentity(directory)
  assert.equal(previous.spans[0]!.spanId, diagnosticAlias(identity, 'b'.repeat(16)))
  assert.equal(await readFile(receipt, 'utf8'), body)
  const cutoff = await next.quota.pin(process.pid)
  try {
    const destination = path.join(directory, 'evidence.zip')
    await writeDiagnosticBundle({ directory, destination, files: cutoff.files, snapshots: [{ component: 'memory', ...next.snapshot() }] })
    const archive = await readFile(destination), entries = unzipStored(archive)
    assert.equal(archive.includes(Buffer.from('SECRET_PRIOR_BODY')), false)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as { snapshots: Array<{ previous: { spans: Array<{ spanId: string }> } }> }
    const sourceSpans = [...entries].filter(([name]) => name.endsWith('.jsonl')).flatMap(([, data]) => data.toString().trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as { event: string; operation: string; spanId: string }))
    const oldStart = sourceSpans.find(record => record.event === 'operation.start' && record.operation === 'memory.write')!
    assert.equal(manifest.snapshots[0]!.previous.spans[0]!.spanId, oldStart.spanId, 'historical span links are re-aliased once, like their source record')
  } finally { await next.quota.release(cutoff.pin) }
})

test('live writers are excluded and rotated complete spans do not become false incomplete records', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const live = createNodeDiagnostics({ directory, component: 'memory', fileBytes: 1200 }); t.after(() => live.close())
  await live.ready
  live.emit({ event: 'operation.start', operation: 'memory.get' }, context(1))
  const observer = createNodeDiagnostics({ directory, component: 'memory' }); t.after(() => observer.close())
  await observer.ready
  assert.ok(await eventually(() => observer.snapshot().previous?.status !== 'pending', { timeoutMs: 2000, intervalMs: 5 }))
  assert.equal(observer.snapshot().previous?.incompleteCount, 0)
  await observer.close()
  for (let index = 1; index <= 6; index++) {
    if (index !== 1) live.emit({ event: 'operation.start', operation: 'memory.get' }, context(index))
    live.emit({ event: 'operation.end', operation: 'memory.get', outcome: 'completed' }, context(index))
  }
  assert.equal(await live.close(), true)
  assert.ok((await readdir(directory)).filter(file => file.endsWith('.jsonl')).length > 2)
  const next = createNodeDiagnostics({ directory, component: 'memory' }); t.after(() => next.close())
  await next.ready
  assert.ok(await eventually(() => next.snapshot().previous?.status !== 'pending', { timeoutMs: 3000, intervalMs: 5 }))
  assert.equal(next.snapshot().previous?.status, 'complete')
  assert.equal(next.snapshot().previous?.incompleteCount, 0)
})

test('startup inspection has one bounded attempt and a late metadata reply cannot revive closed diagnostics', async () => {
  let settle!: (value: { files: []; partial: boolean }) => void, calls = 0, summaries = 0
  const recovery = createDiagnosticRecovery({ directory: tmpdir(), component: 'memory', timeoutMs: 10,
    quota: { previous: () => { calls++; return new Promise(resolve => { settle = resolve }) } }, completed() { summaries++ } })
  recovery.start('run', 'a'.repeat(32)); recovery.start('run', 'a'.repeat(32))
  await delay(25)
  assert.equal(recovery.snapshot().status, 'partial'); assert.equal(recovery.settled(), false); assert.equal(calls, 1)
  const closing = recovery.close()
  settle({ files: [], partial: false }); await closing
  assert.equal(recovery.settled(), true); assert.equal(summaries, 0); assert.deepEqual(recovery.snapshot().spans, [])
})

test('an aborted historical read retains its actual I/O lifetime until the read closes', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const file = 'memory-00000000-0000-0000-0000-000000000001.jsonl'
  await writeFile(path.join(directory, file), '{}\n')
  const original = fs.read, reads: unknown[][] = []
  const patched = t.mock.method(fs, 'read', (...args: unknown[]) => { reads.push(args) })
  const release = () => { patched.mock.restore(); for (const args of reads.splice(0)) Reflect.apply(original, fs, args) }
  t.after(release)
  const recovery = createDiagnosticRecovery({ directory, component: 'memory', timeoutMs: 1000,
    quota: { previous: async () => ({ files: [{ file, cutoff: 3 }], partial: false }) }, completed() {} })
  recovery.start('run', 'a'.repeat(32))
  assert.ok(await eventually(() => reads.length > 0, { timeoutMs: 1000, intervalMs: 5 }))
  let closed = false
  const closing = recovery.close().then(() => { closed = true })
  await delay(20)
  assert.equal(recovery.settled(), false); assert.equal(closed, false)
  release(); await closing
  assert.equal(recovery.settled(), true); assert.deepEqual(recovery.snapshot().spans, [])
})

test('historical ranges are a bounded contiguous tail of the last fully closed writer', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const identity = await loadDiagnosticIdentity(directory), prior = new DiagnosticQuota(directory)
  const files: string[] = []
  for (let index = 0; index < 5; index++) {
    const slot = await prior.reserve('memory', identity.runId)
    const file = await open(path.join(directory, slot.file), 'wx')
    try { await file.truncate(DIAGNOSTIC_LIMITS.fileBytes) } finally { await file.close() }
    await prior.close(slot); files.push(slot.file)
  }
  const result = await new DiagnosticQuota(directory).previous('memory', identity.runId)
  assert.equal(result.partial, true)
  assert.deepEqual(result.files.map(file => file.file), files.slice(1))
  assert.equal(result.files.reduce((sum, file) => sum + file.cutoff, 0), DIAGNOSTIC_LIMITS.exportSourceBytes)
})

test('startup parsing and control snapshots retain bounded metadata and explicit omission counts', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const file = 'memory-00000000-0000-0000-0000-000000000001.jsonl'
  const records = Array.from({ length: DIAGNOSTIC_LIMITS.activeSpans + 1 }, (_, index) => JSON.stringify({ schemaVersion: 1,
    event: 'operation.start', operation: 'memory.get', component: 'memory', time: '2026-11-18T00:00:00.000Z', sequence: index,
    traceId: 'a'.repeat(32), spanId: (index + 1).toString(16).padStart(32, '0'), processInstanceId: 'c'.repeat(32), diagnosticRunId: 'd'.repeat(32),
    unexpected: 'SECRET_UNRETAINED_BODY' })).join('\n') + '\n'
  await writeFile(path.join(directory, file), records)
  const recovery = createDiagnosticRecovery({ directory, component: 'memory', completed() {},
    quota: { previous: async () => ({ files: [{ file, cutoff: Buffer.byteLength(records) }], partial: false }) } })
  t.after(() => recovery.close())
  recovery.start('run', 'd'.repeat(32))
  assert.ok(await eventually(recovery.settled, { timeoutMs: 3000, intervalMs: 5 }))
  const result = recovery.snapshot()
  assert.equal(result.status, 'partial'); assert.equal(result.incompleteCount, DIAGNOSTIC_LIMITS.activeSpans)
  assert.equal(result.spans.length, DIAGNOSTIC_LIMITS.previousSpans)
  assert.equal(result.omittedCount, 1 + DIAGNOSTIC_LIMITS.activeSpans - DIAGNOSTIC_LIMITS.previousSpans)
  assert.equal(JSON.stringify(result).includes('SECRET_'), false)
  result.spans[0]!.spanId = 'modified'
  assert.notEqual(recovery.snapshot().spans[0]!.spanId, 'modified')
})

test('malformed JSONL also yields the parsing turn, without decoding its raw text into summaries', async () => {
  const report = { sourceBytesRead: 0, exportedThroughByte: 0, trailingBytesOmitted: 0, partial_trailing_record: false, invalid_record: 0 }
  const bytes = Buffer.from('\n'.repeat(16_000))
  let observedDuringParsing = false
  async function* input() {
    setImmediate(() => { observedDuringParsing = report.sourceBytesRead < bytes.length })
    yield bytes
  }
  for await (const _value of diagnosticJsonl(input(), report, { cooperate: true })) assert.fail('blank records must not be yielded')
  assert.equal(observedDuringParsing, true)
  assert.equal(report.invalid_record, 16_000); assert.equal(report.sourceBytesRead, bytes.length)
})

test('historical snapshot validation captures getters once and never coerces unknown status objects', () => {
  let reads = 0, coercions = 0
  const valid = { get status() { reads++; return reads === 1 ? 'complete' : 'SECRET_STATUS' }, incompleteCount: 0, omittedCount: 0, spans: [] }
  assert.deepEqual(safeDiagnosticRecovery(valid), { status: 'complete', incompleteCount: 0, omittedCount: 0, spans: [] })
  assert.equal(reads, 1)
  assert.equal(safeDiagnosticRecovery({ ...valid, status: { toString() { coercions++; return 'complete' } } }), undefined)
  assert.equal(coercions, 0)
})

test('a late file-close acknowledgment cannot turn an expired inspection into complete', { timeout: 5000 }, async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const file = 'memory-00000000-0000-0000-0000-000000000001.jsonl'
  const text = JSON.stringify({ schemaVersion: 1, event: 'operation.end', operation: 'memory.get', component: 'memory',
    time: '2026-11-18T00:00:00.000Z', sequence: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(32),
    processInstanceId: 'c'.repeat(32), diagnosticRunId: 'd'.repeat(32) }) + '\n'
  await writeFile(path.join(directory, file), text)
  const original = fs.close, pending: Array<{ fd: number; callback: (error: NodeJS.ErrnoException | null) => void }> = []
  const patched = t.mock.method(fs, 'close', (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => { pending.push({ fd, callback }) })
  const release = () => { patched.mock.restore(); for (const { fd, callback } of pending.splice(0)) original(fd, callback) }
  const recovery = createDiagnosticRecovery({ directory, component: 'memory', timeoutMs: 1000, completed() {},
    quota: { previous: async () => ({ files: [{ file, cutoff: Buffer.byteLength(text) }], partial: false }) } })
  try {
    recovery.start('run', 'd'.repeat(32))
    assert.ok(await eventually(() => pending.length > 0, { timeoutMs: 1000, intervalMs: 5 }))
    await delay(1050)
    assert.equal(recovery.snapshot().status, 'partial'); assert.equal(recovery.settled(), false)
    release()
    assert.ok(await eventually(recovery.settled, { timeoutMs: 1000, intervalMs: 5 }))
    assert.equal(recovery.snapshot().status, 'partial'); assert.equal(recovery.snapshot().reason, 'timeout')
  } finally { release(); await recovery.close() }
})

test('a conflicting historical child cannot supply its missing parent terminal', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const file = 'memory-00000000-0000-0000-0000-000000000001.jsonl'
  const base = { schemaVersion: 1, component: 'memory', time: '2026-11-18T00:00:00.000Z', traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(32), processInstanceId: 'c'.repeat(32), diagnosticRunId: 'd'.repeat(32) }
  const text = [
    { event: 'operation.start', operation: 'memory.get' },
    { event: 'operation.start', operation: 'task' },
    { event: 'operation.end', operation: 'task' },
    { event: 'operation.progress', operation: 'memory.get', stage: 'waiting' },
  ].map((record, sequence) => JSON.stringify({ ...base, ...record, sequence })).join('\n') + '\n'
  await writeFile(path.join(directory, file), text)
  const recovery = createDiagnosticRecovery({ directory, component: 'memory', completed() {},
    quota: { previous: async () => ({ files: [{ file, cutoff: Buffer.byteLength(text) }], partial: false }) } })
  t.after(() => recovery.close())
  recovery.start('run', 'd'.repeat(32))
  assert.ok(await eventually(recovery.settled, { timeoutMs: 1000, intervalMs: 5 }))
  assert.equal(recovery.snapshot().status, 'partial'); assert.equal(recovery.snapshot().reason, 'invalid_context')
  assert.equal(recovery.snapshot().incompleteCount, 1)
  assert.equal(recovery.snapshot().spans[0]!.operation, 'memory.get'); assert.equal(recovery.snapshot().spans[0]!.stage, 'waiting')
})
