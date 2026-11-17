import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { DIAGNOSTIC_LIMITS, parseDiagnosticContext, separateDiagnosticEnvelope, safeDiagnosticReason } from '../src/diagnostics/contracts.ts'
import type { DiagnosticComponent, DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { diagnosticContext, emitDiagnostic, inDiagnosticContext, installDiagnosticPort, withOperation } from '../src/diagnostics/node/context.ts'
import { encodeDiagnosticEnvelope } from '../src/diagnostics/node/envelope.ts'
import { createNodeDiagnostics } from '../src/diagnostics/node/logger.ts'
import { DiagnosticQuota } from '../src/diagnostics/node/quota.ts'
import { safeDiagnosticEvent, sanitizeStoredDiagnostic } from '../src/diagnostics/node/record.ts'
import { loadDiagnosticIdentity, newDiagnosticIdentity, diagnosticAlias, replaceDiagnosticIdentity } from '../src/diagnostics/node/identity.ts'

const context = { version: 1 as const, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
const temporary = () => mkdtemp(path.join(tmpdir(), 'viva-diagnostics-test-'))
const encodedBytes = (value: ReturnType<typeof encodeDiagnosticEnvelope>) => Buffer.isBuffer(value.body) ? value.body : Buffer.concat(value.body)

test('identity text is aliased synchronously before writer admission and is not hashed twice on disk', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' }); t.after(() => logger.close())
  await logger.ready
  const identity = await loadDiagnosticIdentity(directory)
  const secret = '/workspace/forgotten-body-and-model-name'
  const hmac = t.mock.method(crypto, 'createHmac')
  syncBuiltinESMExports()
  try {
    const before = hmac.mock.callCount()
    logger.emit({ event: 'operation.progress', operation: 'diagnostics', identities: { resourceId: secret } }, context)
    assert.equal(hmac.mock.callCount() - before, 1, 'the identity must be aliased before emit returns, rather than retained until the pump')
  } finally { hmac.mock.restore(); syncBuiltinESMExports() }
  assert.equal(await logger.close(), true)
  const output = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  const record = JSON.parse(output.trim()) as { identities: { resourceId: string } }
  assert.equal(record.identities.resourceId, diagnosticAlias(identity, secret))
  assert.doesNotMatch(output, /forgotten-body-and-model-name/)
})

test('opaque-looking model names and resource identities are not retained as raw alias-cache keys', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' }); t.after(() => logger.close())
  await logger.ready
  const hmac = t.mock.method(crypto, 'createHmac'); syncBuiltinESMExports()
  try {
    const before = hmac.mock.callCount()
    for (let count = 0; count < 2; count++) logger.emit({ event: 'operation.progress', operation: 'model',
      identities: { resourceId: 'abcdef0123456789' } }, context)
    assert.equal(hmac.mock.callCount() - before, 2, 'identity format does not prove a resource name is content-free')
  } finally { hmac.mock.restore(); syncBuiltinESMExports() }
})

test('context getters are captured once and cannot replace validated opaque identifiers', () => {
  let traceReads = 0
  const parsed = parseDiagnosticContext({ ...context, get traceId() { return ++traceReads === 1 ? context.traceId : 'SECRET_CONTEXT_BODY' } })
  assert.deepEqual(parsed, context)
  assert.equal(traceReads, 1)
  assert.equal(Object.isFrozen(parsed), true)
})

test('starts before salt readiness omit identity text but still match independent terminals after readiness', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' }); t.after(() => logger.close())
  const first = 'body-like-first-operation', second = '/path-like-second-operation'
  for (const operationId of [first, second]) logger.emit({ event: 'operation.start', operation: 'memory.dream', identities: { operationId } }, context)
  assert.equal(logger.snapshot().stats.activeCount, 2)
  await logger.ready
  const identity = await loadDiagnosticIdentity(directory)
  logger.emit({ event: 'operation.end', operation: 'memory.dream', identities: { operationId: second } }, context)
  assert.equal(logger.snapshot().stats.activeCount, 1)
  logger.emit({ event: 'operation.end', operation: 'memory.dream', identities: { operationId: first } }, context)
  assert.equal(logger.snapshot().stats.activeCount, 0)
  assert.equal(await logger.close(), true)
  const output = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  const records = output.trim().split('\n').map(line => JSON.parse(line) as { event: string, traceId: string, spanId: string,
    reason?: string, metrics?: { partial?: boolean }, identities?: { operationId: string } })
  const starts = records.filter(record => record.event === 'operation.start')
  const ends = records.filter(record => record.event === 'operation.end')
  assert.equal(starts.length, 2); assert.equal(ends.length, 2)
  assert.ok(starts.every(record => record.identities === undefined && record.reason === 'not_ready' && record.metrics?.partial === true))
  assert.equal(ends[0]!.identities?.operationId, diagnosticAlias(identity, second))
  assert.equal(ends[1]!.identities?.operationId, diagnosticAlias(identity, first))
  assert.equal(ends[0]!.spanId, starts[1]!.spanId)
  assert.equal(ends[1]!.spanId, starts[0]!.spanId)
  assert.doesNotMatch(output, /body-like|path-like/)
})

test('retained contexts are immutable scalar snapshots rather than caller-owned object graphs', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' }); t.after(() => logger.close())
  await logger.ready
  const supplied = { ...context }
  logger.emit({ event: 'operation.start', operation: 'memory.get' }, supplied)
  supplied.spanId = 'c'.repeat(16)
  Object.assign(supplied, { body: 'MUST_NOT_RETAIN_BODY' })
  logger.emit({ event: 'operation.end', operation: 'memory.get' }, supplied)
  assert.equal(logger.snapshot().stats.activeCount, 0)
  const invalid = { ...context, body: 'MUST_NOT_RETAIN_BODY' }
  logger.emit({ event: 'operation.progress', operation: 'memory.get' }, invalid)
  assert.ok(logger.snapshot().stats.droppedCount > 0)
  const identity = await loadDiagnosticIdentity(directory)
  assert.equal(await logger.close(), true)
  const output = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  const records = output.trim().split('\n').map(line => JSON.parse(line) as { spanId: string, reason?: string })
  assert.equal(records[0]!.spanId, diagnosticAlias(identity, context.spanId))
  assert.equal(records[1]!.spanId, records[0]!.spanId)
  assert.equal(records[2]!.reason, 'invalid_context')
  assert.doesNotMatch(output, /MUST_NOT_RETAIN_BODY/)
})

test('identity readiness discards early contexts from a different diagnostic run before encoding', async t => {
  const directory = await temporary(); t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' }); t.after(() => logger.close())
  logger.emit({ event: 'operation.start', operation: 'memory.dream' }, { ...context, diagnosticRunId: crypto.randomUUID() })
  assert.equal(logger.snapshot().stats.activeCount, 1)
  await logger.ready
  assert.equal(logger.snapshot().stats.activeCount, 0)
  assert.equal(await logger.close(), true)
  const output = (await Promise.all((await readdir(directory)).filter(file => file.endsWith('.jsonl')).map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.doesNotMatch(output, /"operation":"memory.dream"/)
})

test('changing diagnostic getters cannot replace validated fields or repeatedly read nested envelopes before persistence', async t => {
  const changing = () => {
    const reads = new Map<string, number>()
    const value = (key: string, first: unknown, later: unknown) => {
      reads.set(key, (reads.get(key) ?? 0) + 1)
      return reads.get(key) === 1 ? first : later
    }
    return { reads, raw: {
      get event() { return value('event', 'operation.progress', 'SECRET_EVENT_NAME') },
      get operation() { return value('operation', 'diagnostics', 'SECRET_OPERATION') },
      get stage() { return value('stage', 'ready', 'SECRET_STAGE') },
      get reason() { return value('reason', 'normal', 'SECRET_REASON') },
      get outcome() { return value('outcome', 'completed', 'SECRET_OUTCOME') },
      get identities() { return value('identities', { requestId: 'opaque-request' }, { resourceId: 'SECRET_IDENTITY' }) },
      get metrics() { return value('metrics', { count: 7 }, { count: 999 }) },
    } }
  }
  const first = changing()
  assert.deepEqual(safeDiagnosticEvent(first.raw), { event: 'operation.progress', operation: 'diagnostics', stage: 'ready',
    reason: 'normal', outcome: 'completed', identities: { requestId: 'opaque-request' }, metrics: { count: 7 } })
  assert.ok([...first.reads.values()].every(count => count === 1))
  const directory = await temporary()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' })
  await logger.ready
  const second = changing()
  logger.emit(second.raw as unknown as DiagnosticEvent)
  assert.equal(await logger.close(), true)
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl'))
  const output = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.match(output, /"event":"operation.progress"/)
  assert.match(output, /"count":7/)
  assert.doesNotMatch(output, /SECRET_/)
  assert.ok([...second.reads.values()].every(count => count === 1))
})

test('invalid diagnostic metadata is removed independently of strict business fields', () => {
  for (const diagnostics of [undefined, { ...context, version: 99 }, { ...context, secret: 'CANARY' }, { ...context, spanId: null }, { ...context, traceId: '../CANARY' }]) {
    const original = { method: 'profile', input: { args: [] }, extraBusiness: true, diagnostics }
    const result = separateDiagnosticEnvelope(original)
    assert.deepEqual(result.business, { method: 'profile', input: { args: [] }, extraBusiness: true })
    assert.equal(result.context, undefined)
    assert.equal(result.dropped, diagnostics !== undefined)
    assert.equal(original.diagnostics, diagnostics)
  }
  assert.deepEqual(parseDiagnosticContext(context), context)
})

test('diagnostic encoding preserves the exact business buffer at byte limits and invalid contexts', () => {
  for (const text of ['', 'abc', '深圳🙂', '\n"\\']) {
    const body = Buffer.from(JSON.stringify({ args: [text] }))
    const full = encodeDiagnosticEnvelope(body, context, 100_000)
    assert.deepEqual(JSON.parse(encodedBytes(full).toString()), { args: [text], diagnostics: context })
    assert.equal(full.byteLength, body.length + full.diagnosticBytes)
    assert.equal(encodeDiagnosticEnvelope(body, context, full.byteLength).dropped, false)
    for (const limit of [body.length, full.byteLength - 1, body.length - 1]) {
      const fallback = encodeDiagnosticEnvelope(body, context, limit)
      assert.equal(fallback.body, body)
      assert.equal(fallback.dropped, true)
    }
  }
  const empty = encodeDiagnosticEnvelope(Buffer.from('{}'), context, 500)
  assert.deepEqual(JSON.parse(encodedBytes(empty).toString()), { diagnostics: context })
  const invalid = { ...context, version: 999 } as unknown as typeof context
  const body = Buffer.from('{"args":[]}')
  assert.equal(encodeDiagnosticEnvelope(body, invalid, 500).body, body)
  const large = Buffer.from(JSON.stringify({ args: ['x'.repeat(1024 * 1024)] }))
  const zeroCopy = encodeDiagnosticEnvelope(large, context, 32 * 1024 * 1024)
  assert.ok(!Buffer.isBuffer(zeroCopy.body))
  assert.equal(zeroCopy.body[0].buffer, large.buffer, 'the large business prefix is a view of the original encoding')
  assert.equal(zeroCopy.body[0].byteOffset, large.byteOffset)
})

test('around-call diagnostics preserves synchronous values, this, errors and asynchronous cancellation', async () => {
  const events: DiagnosticEvent[] = []
  const contexts: Array<ReturnType<typeof diagnosticContext>> = []
  const restore = installDiagnosticPort({ emit(event) { events.push(event); contexts.push(diagnosticContext()); return undefined } })
  try {
    const error = new Error('DO_NOT_LOG_THIS')
    const receiver = { value: 42, run() { return this.value } }
    assert.equal(withOperation('tool', () => receiver.run()), 42)
    assert.throws(() => withOperation('tool', () => { throw error }), value => value === error)
    await assert.rejects(withOperation('model', () => Promise.reject(error)), value => value === error)
    const stop = new DOMException('SENSITIVE_ABORT', 'AbortError')
    await assert.rejects(withOperation('conversation.cancel', () => Promise.reject(stop)), value => value === stop)
    assert.equal(events.at(-1)?.outcome, 'cancelled')
    assert.ok(contexts.every(value => value?.traceId && value.spanId))
    assert.equal(JSON.stringify(events).includes('SENSITIVE'), false)
    assert.equal(JSON.stringify(events).includes('DO_NOT_LOG_THIS'), false)
  } finally { restore() }
})

test('concurrent operations keep their async context and nested operations share only their parent trace', async () => {
  const restore = installDiagnosticPort({ emit: () => undefined })
  try {
    await inDiagnosticContext(context, async () => {
      const results = await Promise.all([1, 2].map(value => withOperation('task', async () => {
        const before = diagnosticContext()!
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(diagnosticContext(), before)
        return { value, before }
      })))
      assert.notEqual(results[0]!.before.spanId, results[1]!.before.spanId)
      assert.equal(results[0]!.before.traceId, context.traceId)
      assert.equal(results[0]!.before.parentSpanId, context.spanId)
    })
    assert.equal(diagnosticContext(), undefined)
  } finally { restore() }
})

test('a native Promise from another realm is observed at settlement and preserves its rejection', async () => {
  const events: DiagnosticEvent[] = [], failure = new Error('CROSS_REALM_ERROR')
  const restore = installDiagnosticPort({ emit(event) { events.push(event); return undefined } })
  try {
    const pending = runInNewContext('Promise.reject(failure)', { failure }) as Promise<never>
    const result = withOperation('tool', () => pending)
    assert.equal(events.length, 1, 'the other realm promise is still pending at return')
    await assert.rejects(result, error => error === failure)
    assert.equal(events.at(-1)?.outcome, 'failed')
  } finally { restore() }
})

test('a throwing diagnostic port cannot change successful or failed business work', async () => {
  const restore = installDiagnosticPort({ emit() { throw new Error('DIAGNOSTIC_FAILURE') } })
  try {
    assert.equal(emitDiagnostic({ event: 'state.changed', operation: 'memory.owner' }), undefined)
    assert.equal(withOperation('memory.write', () => 123), 123)
    const error = new Error('BUSINESS_FAILURE')
    await assert.rejects(withOperation('memory.forget', () => Promise.reject(error)), value => value === error)
  } finally { restore() }
})

test('error classification does not invoke business error accessors', () => {
  let reads = 0
  const error = Object.defineProperties(new Error('SECRET'), {
    code: { get() { reads++; throw new Error('must not run') } },
    name: { get() { reads++; return 'AbortError' } },
    reason: { get() { reads++; return 'timeout' } },
  })
  assert.equal(safeDiagnosticReason(error), 'unknown_error')
  assert.equal(reads, 0)
  assert.equal(safeDiagnosticReason(new DOMException('SECRET', 'AbortError')), 'aborted')
})

test('event allowlists exclude arbitrary fields and unknown error/category names', () => {
  const safe = safeDiagnosticEvent({ event: 'state.changed', operation: 'memory.owner', reason: 'SECRET', stage: 'SECRET',
    message: 'SECRET', stack: 'SECRET', metrics: { count: 1, secret: 'SECRET', bytes: NaN }, identities: { requestId: 'SECRET', message: 'SECRET' } })!
  assert.deepEqual(safe, { event: 'state.changed', operation: 'memory.owner', metrics: { count: 1 }, identities: { requestId: 'SECRET' } })
  assert.equal(safeDiagnosticEvent({ event: 'SECRET', operation: 'memory.owner' }), undefined)
  assert.equal(sanitizeStoredDiagnostic({ ...safe, schemaVersion: 1, time: 'SECRET' }, newDiagnosticIdentity()), undefined)
})

test('identity persists across restarts and replacing its salt changes future-writer aliases without changing business identities', async () => {
  const dir = await temporary()
  try {
    const first = await loadDiagnosticIdentity(dir), second = await loadDiagnosticIdentity(dir)
    assert.deepEqual(first, second)
    const original = 'native-business-id'
    const next = await replaceDiagnosticIdentity(dir)
    assert.notEqual(next.runId, first.runId)
    assert.notEqual(diagnosticAlias(first, original), diagnosticAlias(next, original))
    assert.equal(original, 'native-business-id')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('real Pino/SonicBoom writes structured aliased events and releases all admitted bytes', async () => {
  const dir = await temporary()
  const runtime = createNodeDiagnostics({ directory: dir, component: 'backend', version: '0.4.0' })
  const restore = installDiagnosticPort(runtime)
  try {
    await runtime.ready
    assert.equal(runtime.snapshot().stats.state, 'ready')
    await withOperation('memory.get', async () => {
      emitDiagnostic({ event: 'operation.progress', operation: 'memory.get', stage: 'profile', identities: { requestId: 'SECRET_REQUEST_TEXT' } })
      await Promise.resolve()
      return true
    })
    assert.equal(await runtime.close(), true)
    const files = (await readdir(dir)).filter(file => file.endsWith('.jsonl'))
    const text = (await Promise.all(files.map(file => readFile(path.join(dir, file), 'utf8')))).join('')
    assert.equal(text.includes('SECRET_REQUEST_TEXT'), false)
    const lines = text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    assert.equal(lines.length, 3)
    assert.equal(lines[0]!.event, 'operation.start')
    assert.equal(lines[2]!.outcome, 'completed')
    assert.equal(lines[0]!.traceId, lines[2]!.traceId)
    assert.equal(runtime.snapshot().stats.queuedBytes, 0)
  } finally { restore(); await runtime.close(); await rm(dir, { recursive: true, force: true }) }
})

test('queue floods are bounded before file initialization and cannot block business work', async () => {
  const dir = await temporary()
  const runtime = createNodeDiagnostics({ directory: dir, component: 'backend', queueBytes: 2 * DIAGNOSTIC_LIMITS.eventBytes })
  try {
    for (let n = 0; n < 1000; n++) runtime.emit({ event: 'state.changed', operation: 'memory.owner' })
    assert.ok(runtime.snapshot().stats.queuedBytes <= 2 * DIAGNOSTIC_LIMITS.eventBytes)
    assert.ok(runtime.snapshot().stats.droppedCount >= 998)
    await runtime.ready
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }) }
})

test('quota charges live reservations and pins, and closed files can be reclaimed', async () => {
  const dir = await temporary()
  const quota = new DiagnosticQuota(dir, { maxBytes: 300_000, fileBytes: 100_000 })
  try {
    const one = await quota.reserve('backend')
    await assert.rejects(quota.reserve('memory'), /quota full/)
    await readFile(path.join(dir, 'inventory.json'))
    await quota.close(one)
    const two = await quota.reserve('memory')
    assert.notEqual(one.id, two.id)
    const inventory = JSON.parse(await readFile(path.join(dir, 'inventory.json'), 'utf8')) as { slots: Array<{ bytes: number }> }
    assert.ok(inventory.slots.reduce((sum, item) => sum + item.bytes, 0) < 300_000)
    await quota.close(two)
    assert.equal(await quota.clearClosed(), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('an unusable directory degrades logging without propagating to business', async () => {
  const dir = await temporary()
  const link = `${dir}-link`
  try {
    await symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    const runtime = createNodeDiagnostics({ directory: link, component: 'backend' })
    const restore = installDiagnosticPort(runtime)
    try { await runtime.ready; assert.equal(runtime.snapshot().stats.state, 'unavailable'); assert.equal(withOperation('memory.recall', () => 42), 42) }
    finally { restore(); await runtime.close() }
    assert.equal((await stat(dir)).isDirectory(), true)
  } finally { await rm(link, { force: true }); await rm(dir, { recursive: true, force: true }) }
})

test('shutdown drains admitted records across serialized rotations and settles every file reservation', async t => {
  const directory = await temporary()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend', fileBytes: 2048 })
  await logger.ready
  for (let i = 0; i < 30; i++) logger.emit({ event: 'operation.progress', operation: 'memory.get', metrics: { count: i } })
  assert.equal(await logger.close(), true)
  const files = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
  assert.ok(files.length > 2)
  const rows = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).flatMap(text => text.trim().split('\n').map(line => JSON.parse(line) as { sequence: number }))
  assert.deepEqual(rows.map(row => row.sequence).sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => index + 1))
  const inventory = JSON.parse(await readFile(path.join(directory, 'inventory.json'), 'utf8')) as { slots: Array<{ closed: boolean }> }
  assert.ok(inventory.slots.every(slot => slot.closed))
  assert.equal(logger.snapshot().stats.queuedBytes, 0)
})

test('summary floods preserve reserved room for the terminal business evidence', async t => {
  const directory = await temporary()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' })
  for (let i = 0; i < 1000; i++) logger.emit({ event: 'operation.progress', operation: 'memory.dream' })
  logger.emit({ event: 'operation.start', operation: 'memory.write' })
  logger.emit({ event: 'operation.end', operation: 'memory.write', outcome: 'failed', reason: 'validation_failed' })
  assert.equal(await logger.close(), true)
  const files = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
  const rows = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.match(rows, /"operation":"memory.write"/)
  assert.match(rows, /"outcome":"failed"/)
  assert.ok(logger.snapshot().stats.droppedCount > 0)
  assert.ok(logger.snapshot().stats.peakQueuedBytes <= DIAGNOSTIC_LIMITS.queueBytes)
})

test('zero-byte closed slots cannot exhaust or corrupt the bounded inventory', async t => {
  const directory = await temporary()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const quota = new DiagnosticQuota(directory)
  for (let i = 0; i < 130; i++) {
    const slot = await quota.reserve('backend')
    await writeFile(path.join(directory, slot.file), '')
    await quota.close(slot)
  }
  const inventory = JSON.parse(await readFile(path.join(directory, 'inventory.json'), 'utf8')) as { slots: unknown[] }
  assert.equal(inventory.slots.length, 128)
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.jsonl')).length, 128)
  await quota.reserve('backend')
})

test('an asynchronous destination-open failure degrades the sink while preserving business values and errors', async t => {
  const directory = await temporary()
  t.after(() => rm(directory, { recursive: true, force: true }))
  class BrokenFileQuota extends DiagnosticQuota {
    override async reserve(component: DiagnosticComponent) {
      const slot = await super.reserve(component)
      await mkdir(path.join(directory, slot.file))
      return slot
    }
  }
  const logger = createNodeDiagnostics({ directory, component: 'backend', quota: new BrokenFileQuota(directory) })
  const restore = installDiagnosticPort(logger)
  t.after(restore)
  await logger.ready
  assert.equal(logger.snapshot().stats.state, 'unavailable')
  assert.equal(logger.snapshot().stats.reason, 'EEXIST')
  assert.equal(await withOperation('memory.write', async () => 42), 42)
  const error = new Error('BUSINESS_ERROR_UNCHANGED')
  await assert.rejects(withOperation('memory.forget', async () => { throw error }), value => value === error)
  await logger.close()
  assert.ok(logger.snapshot().stats.droppedCount > 0)
})

test('a single burst flushes its sub-threshold tail without another event or shutdown', async t => {
  const directory = await temporary()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createNodeDiagnostics({ directory, component: 'backend' })
  await logger.ready
  for (let i = 0; i < 15; i++) logger.emit({ event: 'operation.progress', operation: 'memory.get', metrics: { count: i } })
  const deadline = Date.now() + 2000
  while (logger.snapshot().stats.queuedBytes && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(logger.snapshot().stats.queuedBytes, 0)
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl'))
  const content = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).join('')
  assert.equal(content.trim().split('\n').length, 15)
  await logger.close()
})
