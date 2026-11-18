import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createManagedDiagnostics } from '../src/diagnostics/node/managed.ts'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { DIAGNOSTIC_LIMITS } from '../src/diagnostics/contracts.ts'
import { eventually } from './fixtures/eventually.ts'
import { loadDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'

const scratch = () => mkdtemp(path.join(tmpdir(), 'viva-diagnostic-sink-'))
test('pending Node and portable scopes let caller metadata graphs be garbage-collected', () => {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/diagnostic-binding-gc.ts', import.meta.url))],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { mode: 'both', collected: true, activeCount: 0 })
})

for (const phase of ['startup', 'retry'] as const) test(`pending ${phase} identity I/O retains clear capacity and cannot rebind a closed writer`, { timeout: 15_000 }, async () => {
  const directory = await scratch()
  const identity = await loadDiagnosticIdentity(directory)
  const original = promises.readFile
  const descriptor = Object.getOwnPropertyDescriptor(promises, 'readFile')!
  const releases: Array<() => Promise<void>> = []
  let entered!: () => void, reads = 0
  const held = new Promise<void>(resolve => { entered = resolve })
  const restore = () => { Object.defineProperty(promises, 'readFile', descriptor); syncBuiltinESMExports() }
  Object.defineProperty(promises, 'readFile', { ...descriptor, value: (...args: Parameters<typeof original>) => {
    if (args[0] !== path.join(directory, 'identity.json')) return original(...args)
    reads++
    if (phase === 'retry' && reads === 1) return Promise.reject(Object.assign(new Error('synthetic identity read failure'), { code: 'EIO' }))
    entered()
    return new Promise<Awaited<ReturnType<typeof original>>>((resolve, reject) => {
      releases.push(() => original(...args).then(resolve, reject))
    })
  } })
  syncBuiltinESMExports()
  const writer = createManagedDiagnostics({ directory, component: 'backend' })
  const release = async () => { restore(); await Promise.all(releases.splice(0).map(finish => finish())) }
  try {
    await held
    const token = '20ffbf34-204d-4da2-a626-b78dcfd1e1a9'
    assert.equal(await writer.prepare(token), false, 'a caller deadline is not an identity I/O acknowledgment')
    assert.equal(writer.released(), false)
    assert.equal(await writer.resume(token, identity.runId), false)
    assert.equal(reads, phase === 'retry' ? 2 : 1, 'only one identity attempt may remain in flight')
    await release()
    assert.ok(await eventually(writer.released, { timeoutMs: 1000, intervalMs: 5 }))
    assert.equal(writer.identity(), undefined, 'late identity data must not restore a closed writer binding')
    assert.equal(writer.snapshot().stats.state, 'closed')
    assert.equal(await writer.prepare(token), true, 'the same clear can recover after actual I/O settlement')
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.jsonl')), [])
  } finally {
    await release(); await writer.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

for (const code of ['ENOSPC', 'EAGAIN', 'EACCES']) test(`asynchronous ${code} writes fail closed for diagnostics and preserve business results`, async t => {
  const directory = await scratch(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createNodeDiagnostics({ directory, component: 'backend' })
  t.after(() => writer.close())
  await writer.ready
  const write = t.mock.method(fs, 'write', (_fd: number, _data: unknown, ...args: unknown[]) => {
    const callback = args.at(-1)
    assert.equal(typeof callback, 'function')
    setImmediate(() => { if (typeof callback === 'function') callback(Object.assign(new Error('SENSITIVE_WRITE_ERROR'), { code })) })
  })
  writer.emit({ event: 'operation.start', operation: 'memory.get' })
  assert.equal(await Promise.resolve(42), 42)
  assert.ok(await eventually(() => writer.snapshot().stats.state === 'unavailable', { timeoutMs: 1000, intervalMs: 5 }))
  assert.equal(writer.snapshot().stats.reason, code)
  assert.doesNotThrow(() => writer.emit({ event: 'operation.end', operation: 'memory.get', outcome: 'completed' }))
  write.mock.restore()
  assert.equal(typeof await writer.close(), 'boolean')
  assert.ok(await eventually(writer.released, { timeoutMs: 1000, intervalMs: 5 }))
  assert.equal(await writer.quota.clearClosed(), true)
})

test('partial destination writes settle exact bytes without corrupting JSONL records', async t => {
  const directory = await scratch(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createNodeDiagnostics({ directory, component: 'backend' })
  t.after(() => writer.close())
  await writer.ready
  const original = fs.write
  const write = t.mock.method(fs, 'write', (fd: number, data: unknown, ...args: unknown[]) => {
    const callback = args.at(-1)
    assert.equal(typeof callback, 'function')
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : undefined
    assert.ok(bytes)
    Reflect.apply(original, fs, [fd, bytes.subarray(0, 61), callback])
  })
  for (let count = 0; count < 20; count++) writer.emit({ event: 'operation.progress', operation: 'memory.get', metrics: { count } })
  assert.equal(await writer.close(), true)
  write.mock.restore()
  const contents = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.deepEqual(contents.trim().split('\n').map(line => (JSON.parse(line) as { metrics: { count: number } }).metrics.count), Array.from({ length: 20 }, (_, i) => i))
  assert.equal(writer.snapshot().stats.writtenBytes, Buffer.byteLength(contents))
  assert.equal(writer.snapshot().stats.queuedBytes, 0)
})

test('a permanently pending destination remains charged after close timeout and is recoverable only after actual closure', async t => {
  const directory = await scratch(); t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createManagedDiagnostics({ directory, component: 'backend' })
  t.after(() => writer.close())
  await writer.ready
  let wrote = false
  const write = t.mock.method(fs, 'write', () => { wrote = true })
  const originalClose = fs.close
  const closing: Array<{ fd: number, callback: (error: NodeJS.ErrnoException | null) => void }> = []
  const close = t.mock.method(fs, 'close', (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => { closing.push({ fd, callback }) })
  const release = () => {
    write.mock.restore(); close.mock.restore()
    for (const { fd, callback } of closing.splice(0)) originalClose(fd, callback)
  }
  t.after(release)
  writer.emit({ event: 'operation.progress', operation: 'memory.get' })
  assert.ok(await eventually(() => wrote, { timeoutMs: 1000, intervalMs: 5 }))
  for (let i = 0; i < 10_000; i++) writer.emit({ event: 'operation.progress', operation: 'memory.get' })
  assert.ok(writer.snapshot().stats.peakQueuedBytes <= DIAGNOSTIC_LIMITS.queueBytes)
  assert.ok(writer.snapshot().stats.droppedCount > 0)
  const token = '20ffbf34-204d-4da2-a626-b78dcfd1e1a9'
  assert.equal(await writer.prepare(token), false)
  assert.equal(writer.released(), false)
  assert.equal(await writer.quota.clearClosed(), false)
  assert.ok(await eventually(() => closing.length > 0, { timeoutMs: 1000, intervalMs: 5 }))
  release()
  assert.ok(await eventually(writer.released, { timeoutMs: 1000, intervalMs: 5 }))
  assert.equal(await writer.prepare(token), true, 'a cached caller timeout must not override later actual close evidence')
  assert.equal(await writer.quota.clearClosed(), true)
})
