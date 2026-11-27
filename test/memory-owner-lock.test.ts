import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { OWNER_RPC_MAX_ACTIVE, ownerRpcFrame, type OwnerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { createMemoryOwnerSupervisor } from '../src/memory/node/owner-supervisor.ts'
import { createOwnerRpcPeer } from '../src/memory/node/owner-rpc-peer.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { eventually } from './fixtures/eventually.ts'
import { scratch } from './fixtures/scratch.js'
import { pauseOwnedProcess } from './fixtures/diagnostics-process-pause.ts'
import { createRemoteMemoryOwner } from '../plugins/memory/lib/remote-owner.ts'
import { openPluginOwner, registerStandaloneOwner } from '../plugins/memory/lib/standalone-owner.ts'
import { objectOf } from '../src/memory/contracts/unknown-value.ts'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const fixture = fileURLToPath(new URL('./fixtures/memory-owner-lock.ts', import.meta.url))
test('OS owner lock rejects another process, including a root alias, until process death', { timeout: 15_000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'memory-lock-')), root = join(base, 'root'), alias = join(base, 'alias')
  const child = fork(fixture, [root], { execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, silent: true })
  t.after(() => { child.kill(); rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
  await once(child, 'message')
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const options = { compute: () => null, route: () => null }
  assert.throws(() => openMemoryOwner({ root, ...options }), /active owner/)
  assert.throws(() => openMemoryOwner({ root: alias, ...options }), /active owner/)
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  const replacement = openMemoryOwner({ root: alias, ...options })
  await replacement.recover(); assert.equal(replacement.ready(), true); await replacement.close()
})



test('RPC keeps cancelled execution slots until terminal completion and still admits control and permit settlement', async () => {
  const terminal = deferred<void>()
  let settled = 0
  let cancelled = 0
  const left = createOwnerRpcPeer({ send: frame => { right.receive(frame) } })
  const right = createOwnerRpcPeer({
    send: frame => { left.receive(frame) },
    handle(method, input, signal) {
      if (method === 'ping' || method === 'adapter' && typeof input === 'object' && input && 'method' in input && input.method === 'settleSend') return true
      signal.addEventListener('abort', () => { cancelled++ }, { once: true })
      return terminal.promise.then(() => { settled++; return true })
    },
  })
  try {
    const request = new AbortController()
    const results = Array.from({ length: OWNER_RPC_MAX_ACTIVE }, () => left.call('read', {}, { signal: request.signal }).catch(error => error))
    await Promise.resolve()
    request.abort(new Error('test cancellation'))
    for (const result of await Promise.all(results)) assert.match(String(result), /test cancellation/)
    assert.equal(cancelled, OWNER_RPC_MAX_ACTIVE)
    assert.equal(settled, 0)
    await assert.rejects(left.call('read', {}), /limit/)
    assert.equal(await left.call('ping', {}), true)
    assert.equal(await left.call('adapter', { method: 'settleSend', args: [] }), true)
    terminal.resolve()
    assert.equal(await eventually(() => settled === OWNER_RPC_MAX_ACTIVE), true)
    await delay(0)
    assert.equal(await left.call('read', {}), true)
  } finally { left.close(); right.close() }
})

test('an incompatible database stops automatic forks and reports its startup failure', async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-incompatible-')
  const db = new DatabaseSync(join(root, 'memory.db'))
  db.exec('PRAGMA user_version=999')
  db.close()
  const events: DiagnosticEvent[] = []
  t.after(installDiagnosticPort(recordingDiagnosticPort(event => { events.push(event) })))
  const supervisor = createMemoryOwnerSupervisor({ root })
  defer(() => supervisor.close())
  const failure = { code: 'unknown_version' }
  await assert.rejects(supervisor.start(), failure)
  assert.equal(supervisor.status(), 'unavailable')
  await assert.rejects(supervisor.start(), failure)
  assert.equal(supervisor.pid(), undefined)
  assert.equal(events.filter(event => event.event === 'process.start').length, 1)
  assert.ok(events.some(event => event.event === 'health' && event.reason === 'unknown_version'))
  assert.ok(!events.some(event => event.event === 'retry.scheduled'))
})

test('a regular file occupying the memory root stops automatic startup retries', async t => {
  const { dir, defer } = scratch(t, 'memory-root-file-')
  const root = join(dir, 'memory')
  writeFileSync(root, 'keep')
  const supervisor = createMemoryOwnerSupervisor({ root })
  defer(() => supervisor.close())
  await assert.rejects(supervisor.start(), { code: 'ENOTDIR' })
  assert.equal(supervisor.status(), 'unavailable')
})

test('a read-only root reports the OS permission error instead of retrying SQLite CANTOPEN', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-readonly-')
  const supervisor = createMemoryOwnerSupervisor({ root })
  defer(() => supervisor.close())
  chmodSync(root, 0o555)
  try {
    await assert.rejects(supervisor.start(), { code: 'EACCES' })
    assert.equal(supervisor.status(), 'unavailable')
  } finally { chmodSync(root, 0o755) }
})

for (const name of ['owner.lock.sqlite', 'memory.db', 'memory-files']) {
  test(`wrong entry type for ${name} stops the worker without scheduling another fork`, async t => {
    const { dir: root, defer } = scratch(t, 'memory-owner-path-type-')
    const entry = join(root, name)
    if (name === 'memory-files') writeFileSync(entry, '')
    else mkdirSync(entry)
    const events: DiagnosticEvent[] = []
    t.after(installDiagnosticPort(recordingDiagnosticPort(event => { events.push(event) })))
    const supervisor = createMemoryOwnerSupervisor({ root })
    defer(() => supervisor.close())
    await assert.rejects(supervisor.start(), { code: 'invalid_record' })
    assert.equal(supervisor.status(), 'unavailable')
    assert.ok(!events.some(event => event.event === 'retry.scheduled'))
  })
}

test('an explicit terminal observer waits for real execution to finish after cancellation', async () => {
  const release = deferred<boolean>()
  const cancelled = deferred<void>()
  const request = new AbortController()
  const left = createOwnerRpcPeer({ send: frame => { right.receive(frame) } })
  const right = createOwnerRpcPeer({
    send: frame => { left.receive(frame) },
    handle(_method, _input, signal) {
      signal.addEventListener('abort', () => cancelled.resolve(), { once: true })
      return release.promise
    },
  })
  try {
    let reported = false
    const result = left.call('host', { method: 'profilePage' }, { signal: request.signal, waitForCompletion: true })
      .then(value => { reported = true; return value })
    await Promise.resolve()
    request.abort()
    await cancelled.promise
    assert.equal(reported, false)
    release.resolve(true)
    assert.equal(await result, true)
  } finally { left.close(); right.close() }
})

test('a daily note requests model computation across IPC while the parent can still query the owner', { timeout: 15_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-model-')
  const entered = deferred<string>()
  const reply = deferred<string>()
  const attempts = new Set<string>()
  const supervisor = createMemoryOwnerSupervisor({
    root, dailyNotes: true,
    callbacks: { async compute({ job }) {
      assert.equal(job.provider, 'fixture')
      assert.equal(job.model, 'fixture')
      assert.equal(job.stage, 'note')
      attempts.add(job.id)
      entered.resolve(job.id)
      return reply.promise
    } },
  })
  defer(() => { reply.resolve('{}'); return supervisor.close() })
  await supervisor.start()
  const sessionId = randomUUID()
  await supervisor.callAdapter('setRoute', [{ provider: 'fixture', model: 'fixture' }])
  for (let turn = 1; turn <= 5; turn++) {
    const at = Date.now()
    const fromSeq = (turn - 1) * 3
    await supervisor.callAdapter('settleTurn', [{
      sessionId, cwd: null, sessionKind: 'main', inheritedSeq: 0,
      expectedNextSeq: fromSeq === 0 ? null : fromSeq,
      fromSeq, toSeq: fromSeq + 3, turn, reasonKind: 'completed',
      sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true,
        text: `I submit my weekly report on Friday. Reference ${turn}.`, at, timezone: 'UTC' }],
      assistantText: 'Understood.', at, timezone: 'UTC',
    }])
  }
  await entered.promise
  assert.equal((await supervisor.callHost('listFiles', { args: [{}] })).status, 'ok')
  reply.resolve(JSON.stringify({ status: 'write', title: 'Weekly reporting', state: 'The weekly report is submitted on Friday.', events: ['The weekly report is submitted on Friday.'] }))
  assert.ok(await eventually(async () => (await supervisor.callHost('listFiles', { args: [{ kind: 'daily' }] })).items.length > 0))
  assert.equal(attempts.size, 1)
})


test('the supervisor times out a suspended owner and replaces it after process exit', { timeout: 30_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-heartbeat-')
  const supervisor = createMemoryOwnerSupervisor({ root, heartbeatMs: 500 })
  defer(supervisor.close)
  await supervisor.start()
  const epoch = supervisor.epoch(), pid = supervisor.pid()
  assert.ok(epoch && pid)
  const paused = await pauseOwnedProcess(pid)
  defer(() => paused.resume().catch(() => {}))
  await assert.rejects(supervisor.callHost('revision', { args: [] }, { budgetMs: 25 }), /timed out|unavailable/)
  assert.ok(await eventually(() => supervisor.status() === 'unavailable' || supervisor.epoch() !== epoch))
  // A suspended Windows debugger can hold the exit notification. Resume after
  // the supervisor has fenced this generation, then require a new OS process.
  await paused.resume().catch(() => {})
  assert.ok(await eventually(() => supervisor.epoch() !== epoch && supervisor.status() === 'ready'))
  assert.notEqual(supervisor.pid(), pid)
  assert.equal(typeof await supervisor.callHost('revision', { args: [] }), 'number')
})

/** Drop only the real worker result that matches the currently armed operation. */
function ownerFaults(t: TestContext) {
  type Request = Extract<OwnerRpcFrame, { kind: 'request' }>
  const emit = ChildProcess.prototype.emit
  let owner: ChildProcess | undefined
  let reconciles = 0
  let fault: { kill: boolean, matches(request: Request): boolean, hit: ReturnType<typeof deferred<unknown>> } | undefined
  const watched = new Map<string, NonNullable<typeof fault>>()
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (this.spawnargs?.includes('--memory-owner-ipc')) {
      if (event === 'spawn') {
        owner = this
        const send = this.send
        t.mock.method(this, 'send', function (this: ChildProcess, message: unknown, ...rest: unknown[]) {
          const frame = ownerRpcFrame(message)
          if (frame?.kind === 'request' && frame.method === 'adapter' && objectOf(frame.input)?.method === 'reconcileActiveTurns') reconciles++
          if (fault && frame?.kind === 'request' && fault.matches(frame)) watched.set(frame.id, fault)
          return Reflect.apply(send, this, [message, ...rest]) as boolean
        })
      } else if (event === 'message') {
        const frame = ownerRpcFrame(args[0])
        if (frame?.kind === 'result') {
          const pending = watched.get(frame.id)
          watched.delete(frame.id)
          if (pending && pending === fault) {
            fault = undefined
            if (frame.ok) {
              if (pending.kill) assert.ok(this.kill('SIGKILL'))
              pending.hit.resolve(frame.result)
              return true
            }
            pending.hit.reject(new Error(frame.error.message))
          }
        }
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  return {
    pid: () => owner?.pid,
    kill() { assert.ok(owner?.kill('SIGKILL')) },
    reconciles: () => reconciles,
    drop(matches: (request: Request) => boolean, kill = true) {
      assert.equal(fault, undefined)
      const hit = deferred<unknown>()
      fault = { matches, kill, hit }
      return hit.promise
    },
  }
}

test('standalone owner restart recovers lost write receipts and manual Dream requests', { timeout: 45_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-standalone-lost-replies-')
  const fault = ownerFaults(t)
  const persistence = registerStandaloneOwner(root)
  defer(persistence.close)
  await persistence.start()
  const connection = openPluginOwner({ root, dailyNotes: true }, process)
  const adapter = createRemoteMemoryOwner(connection)
  defer(adapter.close)
  await connection.start()
  const session = randomUUID()
  await adapter.bindIntakeSession(session, root)

  const nextEpoch = adapter.epoch
  const request = { operationId: randomUUID(), title: 'Example recovery note', text: 'A single durable memory document.' }
  const droppedWrite = fault.drop(frame => frame.method === 'adapter' && objectOf(frame.input)?.method === 'rememberStandaloneFile')
  const write = assert.rejects(adapter.rememberStandaloneFile(session, request), /retired|unavailable/)
  const [receipt] = await Promise.all([droppedWrite, write])
  assert.ok(await eventually(() => adapter.ready() && adapter.epoch !== nextEpoch))
  assert.equal((await connection.callHost('getOperation', { operationId: request.operationId }))?.state, 'completed')
  assert.deepEqual(await adapter.rememberStandaloneFile(session, request), receipt)
  assert.equal((await connection.callHost('listFiles', { args: [{}] })).items.length, 1)

  const dreamEpoch = adapter.epoch
  const jobId = randomUUID()
  const droppedDream = fault.drop(frame => frame.method === 'host' && objectOf(frame.input)?.method === 'requestDream')
  const dream = assert.rejects(connection.callHost('requestDream', { args: [jobId] }), /unavailable/)
  await Promise.all([droppedDream, dream])
  assert.ok(await eventually(() => adapter.ready() && adapter.epoch !== dreamEpoch))
  const completed = await eventually(async () => {
    const status = await connection.callHost('requestDream', { args: [jobId] })
    assert.equal(status.jobId, jobId)
    return status.completedAt ? status : undefined
  })
  assert.ok(completed)
  assert.deepEqual(await connection.callHost('requestDream', { args: [jobId] }), completed)
})
