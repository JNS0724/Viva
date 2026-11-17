import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, appendFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'
import { diagnosticRecords, writeDiagnosticBundle } from '../src/diagnostics/node/bundle.ts'
import type { DiagnosticFileManifest } from '../src/diagnostics/node/bundle.ts'
import { newDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'
import { DiagnosticQuota } from '../src/diagnostics/node/quota.ts'
import { createDiagnosticExporter } from '../src/diagnostics/node/export.ts'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { installDiagnosticPort, withOperation } from '../src/diagnostics/node/context.ts'
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

/** Independent store-only ZIP reader: checks central offsets, local headers and native CRC32. */
function unzipStored(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0)
  const entries = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const result = new Map<string, Buffer>()
  for (let index = 0; index < entries; index++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50)
    assert.equal(archive.readUInt16LE(offset + 10), 0)
    const checksum = archive.readUInt32LE(offset + 16), size = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28), extraLength = archive.readUInt16LE(offset + 30), commentLength = archive.readUInt16LE(offset + 32)
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString()
    const local = archive.readUInt32LE(offset + 42)
    assert.equal(archive.readUInt32LE(local), 0x04034b50)
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
    const data = archive.subarray(start, start + size)
    assert.equal(data.length, size)
    assert.equal(crc32(data), checksum)
    result.set(name, data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return result
}

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
      { component: 'shell', stats: { state: 'ready', queuedBytes: 0, secret: 'SNAPSHOT_CANARY' }, active: [] },
    ] })
    const archive = await readFile(destination), files = unzipStored(archive)
    assert.deepEqual([...files.keys()], ['backend-1.jsonl', 'manifest.json'])
    assert.deepEqual(files.get('backend-1.jsonl')!.toString().trim().split('\n').map(line => JSON.parse(line).sequence), [1, 3])
    assert.equal(archive.includes(Buffer.from('CANARY')), false)
    const manifest = JSON.parse(files.get('manifest.json')!.toString()) as { files: DiagnosticFileManifest[] }
    assert.equal(manifest.files[0]!.invalid_record, 1)
    assert.equal(manifest.files[0]!.partial_trailing_record, false)
    assert.equal(manifest.files[0]!.rawCutoffBytes, Buffer.byteLength(source))
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
