import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { pauseOwnedProcess } from './fixtures/diagnostics-process-pause.ts'
import { spawnBackend } from '../src/shell/backend-client.ts'
import { START, TOKEN } from './fixtures/backend-wire.ts'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, appendFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { unzipStored } from './fixtures/diagnostic-zip.ts'
import { diagnosticRecords, writeDiagnosticBundle } from '../src/diagnostics/node/bundle.ts'
import type { DiagnosticFileManifest } from '../src/diagnostics/node/bundle.ts'
import { newDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'
import { DiagnosticQuota } from '../src/diagnostics/node/quota.ts'
import { createDiagnosticClearer } from '../src/diagnostics/node/clear.ts'
import { createDiagnosticExporter } from '../src/diagnostics/node/export.ts'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { diagnosticBinding, diagnosticContext, installDiagnosticPort, setDiagnosticBinding, withDetachedOperation, withOperation } from '../src/diagnostics/node/context.ts'
import { diagnosticAlias, loadDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'
import { backendWith } from './fixtures/backend-wire.ts'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import type { RawIpc } from '../src/shared/ipc-contract.ts'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { registerRuntimeMemoryIpc } from '../src/backend/memory-ipc.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'

const fixture = (sequence: number) => ({ schemaVersion: 1, time: '2026-11-17T00:00:00.000Z', component: 'backend', appVersion: '0.4.0',
  platform: 'darwin', arch: 'arm64', sequence, traceId: 'a'.repeat(32), spanId: 'b'.repeat(32), processInstanceId: 'c'.repeat(32), diagnosticRunId: 'd'.repeat(32),
  event: 'operation.progress', operation: 'memory.get', stage: 'profile' })
const report = (): DiagnosticFileManifest => ({ entry: 'backend-1.jsonl', rawCutoffBytes: 0, sourceBytesRead: 0,
  exportedThroughByte: 0, trailingBytesOmitted: 0, partial_trailing_record: false, outputBytes: 0, invalid_record: 0 })
const scratch = () => mkdtemp(path.join(tmpdir(), 'viva-diagnostic-export-'))

test('background roots preserve their trigger link in both the local history and the exported archive', async t => {
  const directory = await scratch(), writer = createNodeDiagnostics({ directory, component: 'backend' })
  const restore = installDiagnosticPort(writer)
  t.after(async () => { restore(); await writer.close(); await rm(directory, { recursive: true, force: true }) })
  await writer.ready
  withOperation('conversation', () => withDetachedOperation('task', () => withOperation('storage', () => 42)))
  await writer.close()
  const file = (await readdir(directory)).find(name => name.endsWith('.jsonl'))!
  const local = await readFile(path.join(directory, file))
  const destination = path.join(directory, 'export.zip')
  await writeDiagnosticBundle({ directory, destination, files: [{ file, cutoff: local.length }] })
  const zip = unzipStored(await readFile(destination))
  const exported = zip.get('backend-1.jsonl')!
  function check(bytes: Buffer) {
    const rows = bytes.toString().trim().split('\n').map(line => JSON.parse(line) as {
      event: string, operation: string, traceId: string, spanId: string, parentSpanId?: string, links?: unknown
    })
    const start = (op: string) => rows.find(row => row.event === 'operation.start' && row.operation === op)!
    const trigger = start('conversation'), task = start('task'), storage = start('storage')
    assert.notEqual(task.traceId, trigger.traceId)
    assert.equal(task.parentSpanId, undefined)
    assert.deepEqual(task.links, [{ traceId: trigger.traceId, spanId: trigger.spanId }])
    assert.equal(storage.traceId, task.traceId)
    assert.equal(storage.parentSpanId, task.spanId)
    return trigger.traceId
  }
  assert.notEqual(check(local), check(exported))
})

test('export reports a frozen live quota owner and can retry after the real lock releases', { timeout: 20_000 }, async t => {
  const directory = await scratch(), destination = path.join(directory, 'result.zip')
  const holder = fork(fileURLToPath(new URL('./fixtures/diagnostic-quota-holder.ts', import.meta.url)), [directory],
    { execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exit = once(holder, 'exit')
  let paused: Awaited<ReturnType<typeof pauseOwnedProcess>> | undefined
  t.after(async () => { await paused?.resume(); if (holder.exitCode === null) holder.kill(); await exit; await rm(directory, { recursive: true, force: true }) })
  assert.equal((await once(holder, 'message'))[0], 'locked')
  paused = await pauseOwnedProcess(holder.pid!)
  const exporter = createDiagnosticExporter({ quota: new DiagnosticQuota(directory) })
  const start = performance.now()
  assert.deepEqual(await exporter.exportBundle(destination), { status: 'busy', reason: 'busy' })
  assert.ok(performance.now() - start < 5000)
  assert.equal(exporter.state(), 'idle')
  const files = await readdir(directory)
  assert.ok(files.includes('inventory.lock'))
  assert.ok(!files.some(file => file.endsWith('.partial') || file.endsWith('.zip')))
  await paused.resume(); paused = undefined
  holder.send('release')
  await exit
  assert.deepEqual(await exporter.exportBundle(destination), { status: 'saved' })
  assert.ok(unzipStored(await readFile(destination)).has('manifest.json'))
})

test('a saved export with a temporarily blocked pin release can be retried or cleared in the same process', async t => {
  const directory = await scratch(), lock = path.join(directory, 'inventory.lock')
  t.after(() => rm(directory, { recursive: true, force: true }))
  class HeldReleaseQuota extends DiagnosticQuota {
    override async pin(...args: Parameters<DiagnosticQuota['pin']>) {
      const selected = await super.pin(...args)
      await writeFile(lock, JSON.stringify({ pid: process.pid, instance: this.instance }), { flag: 'wx' })
      return selected
    }
  }
  const quota = new HeldReleaseQuota(directory), exporter = createDiagnosticExporter({ quota })
  const first = path.join(directory, 'first.zip'), second = path.join(directory, 'second.zip')
  assert.deepEqual(await exporter.exportBundle(first), { status: 'saved' })
  assert.ok(unzipStored(await readFile(first)).has('manifest.json'))
  assert.equal(exporter.state(), 'cleanup_pending')
  assert.deepEqual(await exporter.exportBundle(second), { status: 'busy', reason: 'cleanup_pending' })
  await rm(lock)
  assert.deepEqual(await exporter.exportBundle(second), { status: 'saved' })
  assert.ok(unzipStored(await readFile(second)).has('manifest.json'))
  await rm(lock)
  const clearer = createDiagnosticClearer({ quota, idle: exporter.ensureIdle, hub: { prepare: async () => true, resume: async () => true } })
  assert.deepEqual(await clearer.clear(), { status: 'cleared' })
  assert.equal(exporter.state(), 'idle')
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'inventory.json'), 'utf8')).pins, [])
})

test('real HTTP preserves the sender trace and immediate parent under a validated run binding', async t => {
  const directory = await scratch()
  const writer = createNodeDiagnostics({ directory, component: 'backend' })
  const restore = installDiagnosticPort(writer), previous = diagnosticBinding()
  t.after(async () => { restore(); setDiagnosticBinding(previous); await writer.close(); await rm(directory, { recursive: true, force: true }) })
  await writer.ready
  const identity = await loadDiagnosticIdentity(directory)
  setDiagnosticBinding(identity.runId)
  let received: ReturnType<typeof diagnosticContext>
  const { connection } = await backendWith(t, { 'probe:causal': () => { received = diagnosticContext(); return 42 } })
  let root: ReturnType<typeof diagnosticContext>
  assert.equal(await withOperation('conversation', () => { root = diagnosticContext(); return connection.rpc('probe:causal', []) }), 42)
  assert.ok(root && received)
  assert.equal(received.traceId, root.traceId)
  assert.equal(received.diagnosticRunId, identity.runId)
  assert.notEqual(received.parentSpanId, root.spanId, 'the HTTP client owns an intervening child span')
  assert.equal(await writer.close(), true)
  const records = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8'))))
    .join('').trim().split('\n').map(line => JSON.parse(line) as { event: string, traceId: string, spanId: string, parentSpanId?: string, reason?: string })
  const parent = records.find(record => record.event === 'operation.start' && record.spanId === diagnosticAlias(identity, received!.parentSpanId!))
  assert.equal(parent?.traceId, diagnosticAlias(identity, root.traceId))
  assert.equal(parent?.parentSpanId, diagnosticAlias(identity, root.spanId))
  assert.equal(records.some(record => record.event === 'context.dropped' && record.reason === 'epoch_changed'), false)
})

test('backend startup explicitly separates early health messages from its ready handshake', { timeout: 10_000 }, async t => {
  let unexpected = false
  const backend = await spawnBackend({ entry: fileURLToPath(new URL('./fixtures/diagnostic-startup.ts', import.meta.url)),
    start: { ...START, type: 'start', token: TOKEN, dataKey: null }, onExit: () => { unexpected = true } })
  t.after(() => backend.shutdown())
  assert.equal(backend.ready.type, 'ready')
  assert.equal(unexpected, false)
})

test('complete malformed JSON is counted once, does not leak, and does not prevent later records', async () => {
  const source = Buffer.from(`${JSON.stringify(fixture(1))}\n{"secret":"秘密_CANARY_🙂",oops}\n${JSON.stringify(fixture(3))}\n`)
  const chunks = Array.from({ length: Math.ceil(source.length / 3) }, (_, index) => source.subarray(index * 3, index * 3 + 3))
  const metadata = report()
  const result: Buffer[] = []
  for await (const chunk of diagnosticRecords(Readable.from(chunks), metadata, newDiagnosticIdentity())) result.push(chunk)
  const text = Buffer.concat(result).toString()
  assert.equal(text.includes('CANARY'), false)
  assert.deepEqual(text.trim().split('\n').map(line => JSON.parse(line).sequence), [1, 3])
  assert.equal(metadata.invalid_record, 1)
  assert.equal(metadata.partial_trailing_record, false)
  assert.equal(metadata.trailingBytesOmitted, 0)
  assert.equal(metadata.exportedThroughByte, source.length)
})

test('a real memory:get waiting for an owner reply remains independently exportable with its blocked profile stage', async t => {
  const directory = await scratch()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' })
  const restore = installDiagnosticPort(logger)
  t.after(restore)
  const requests: object[] = []
  const channel = createRemoteMemoryChannel({ send: request => { requests.push(request) } })
  channel.receive({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: 'test-owner', state: 'ready', revision: 0, coreEpoch: 0 })
  const handlers = new Map<string, Parameters<RawIpc['handle']>[1]>()
  registerRuntimeMemoryIpc(checkedIpc({ handle: (name, handler) => { handlers.set(name, handler) }, on() {} }), {
    client: createVivaMemoryClient(channel.call), habits: () => ({ text: '', samples: 0 }), cwd: () => '', chooseDocs: async () => null,
  })
  await logger.ready
  const pending = withOperation('memory.get', async () => handlers.get('memory:get')!({}))
  const rejected = assert.rejects(pending, /connection closed/)
  try {
    assert.equal(requests.length, 1, 'the first owner read has no reply')
    const limit = Date.now() + 2000
    while (logger.snapshot().stats.queuedBytes && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 5))
    const exporter = createDiagnosticExporter({ quota: logger.quota, snapshots: async () => [{ component: 'backend', ...logger.snapshot() }] })
    const destination = path.join(directory, 'waiting.zip')
    assert.equal((await exporter.exportBundle(destination)).status, 'saved')
    const archive = unzipStored(await readFile(destination))
    const manifest = archive.get('manifest.json')!.toString()
    assert.match(manifest, /"stage": "profile"/)
    const records = [...archive].filter(([name]) => name.endsWith('.jsonl')).map(([, value]) => value.toString()).join('')
    assert.match(records, /"event":"wait.begin","operation":"memory.owner","stage":"profile"/)
    assert.equal(records.includes('test-owner'), false)
  } finally { channel.close(); await rejected; await logger.close() }
})

test('cutoff within a UTF-8 tail or the first row is a partial record rather than corruption', async () => {
  for (const prefix of ['', `${JSON.stringify(fixture(1))}\n`]) {
    const tail = Buffer.from('{"secret":"秘密_CANARY_🙂').subarray(0, -2)
    const source = Buffer.concat([Buffer.from(prefix), tail])
    const metadata = report(), result: Buffer[] = []
    for await (const chunk of diagnosticRecords(Readable.from([source]), metadata, newDiagnosticIdentity())) result.push(chunk)
    assert.equal(metadata.invalid_record, 0)
    assert.equal(metadata.partial_trailing_record, true)
    assert.equal(metadata.trailingBytesOmitted, tail.length)
    assert.equal(metadata.exportedThroughByte, Buffer.byteLength(prefix))
    assert.equal(Buffer.concat(result).toString().includes('CANARY'), false)
  }
})

test('oversized complete rows are skipped within bounded framing and following rows survive', async () => {
  const source = Buffer.from(`${'SECRET'.repeat(5000)}\n${JSON.stringify(fixture(2))}\n`)
  const metadata = report(), result: Buffer[] = []
  for await (const chunk of diagnosticRecords(Readable.from([source]), metadata, newDiagnosticIdentity())) result.push(chunk)
  assert.equal(metadata.invalid_record, 1)
  assert.equal(JSON.parse(Buffer.concat(result).toString()).sequence, 2)
  assert.equal(metadata.partial_trailing_record, false)
})

test('real ZIP export respects fixed cutoffs, excludes private files and validates independent CRCs', async () => {
  const directory = await scratch()
  try {
    const name = 'backend-11111111-1111-4111-8111-111111111111.jsonl'
    const source = `${JSON.stringify(fixture(1))}\n{"secret":"ZIP_CANARY",broken}\n${JSON.stringify(fixture(3))}\n`
    await writeFile(path.join(directory, name), source)
    await writeFile(path.join(directory, 'identity.json'), 'PRIVATE_SALT_CANARY')
    await writeFile(path.join(directory, 'trace.db'), 'PRIVATE_DATABASE_CANARY')
    await appendFile(path.join(directory, name), `${JSON.stringify(fixture(9))}\n`)
    const destination = path.join(directory, 'diagnostics.zip')
    await writeDiagnosticBundle({ directory, destination, files: [{ file: name, cutoff: Buffer.byteLength(source) }], snapshots: [
      { component: 'shell', stats: { state: 'ready', queuedBytes: 0, activeCount: 99, secret: 'SNAPSHOT_CANARY' },
        active: Array.from({ length: 32 }, () => ({ operation: 'memory.get', ageMs: 20 })) },
    ] })
    const archive = await readFile(destination), files = unzipStored(archive)
    assert.deepEqual([...files.keys()], ['backend-1.jsonl', 'manifest.json'])
    assert.deepEqual(files.get('backend-1.jsonl')!.toString().trim().split('\n').map(line => JSON.parse(line).sequence), [1, 3])
    assert.equal(archive.includes(Buffer.from('CANARY')), false)
    const manifest = JSON.parse(files.get('manifest.json')!.toString()) as { files: DiagnosticFileManifest[], snapshots: Array<{ activeOmitted: number }> }
    assert.equal(manifest.files[0]!.invalid_record, 1)
    assert.equal(manifest.files[0]!.partial_trailing_record, false)
    assert.equal(manifest.files[0]!.rawCutoffBytes, Buffer.byteLength(source))
    assert.equal(manifest.snapshots[0]!.activeOmitted, 67, 'a bounded peer snapshot must retain the number of operations omitted before export')
    assert.equal((await readdir(directory)).some(file => file.endsWith('.partial')), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('supervised export reuses one task and releases its pin after confirmed process exit', async () => {
  const directory = await scratch(), quota = new DiagnosticQuota(directory)
  try {
    const slot = await quota.reserve('backend')
    await writeFile(path.join(directory, slot.file), `${JSON.stringify(fixture(1))}\n`)
    await quota.close(slot)
    const exporter = createDiagnosticExporter({ quota })
    const destination = path.join(directory, 'diagnostics.zip')
    const first = exporter.exportBundle(destination)
    assert.equal(exporter.exportBundle(path.join(directory, 'ignored.zip')), first)
    assert.deepEqual(await first, { status: 'saved' })
    assert.equal(exporter.state(), 'idle')
    assert.equal(unzipStored(await readFile(destination)).size, 2)
    const inventory = JSON.parse(await readFile(path.join(directory, 'inventory.json'), 'utf8')) as { pins: unknown[] }
    assert.equal(inventory.pins.length, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a stuck quota acquisition ends user waiting and prevents further export children', async () => {
  class StuckQuota extends DiagnosticQuota {
    override pin(): ReturnType<DiagnosticQuota['pin']> { return new Promise(() => {}) }
  }
  const directory = await scratch()
  try {
    const exporter = createDiagnosticExporter({ quota: new StuckQuota(directory), timeoutMs: 50 })
    assert.deepEqual(await exporter.exportBundle(path.join(directory, 'never.zip')), { status: 'failed', reason: 'timeout' })
    assert.equal(exporter.state(), 'cleanup_pending')
    assert.deepEqual(await exporter.exportBundle(path.join(directory, 'again.zip')), { status: 'busy', reason: 'cleanup_pending' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
