import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { OWNER_RPC_MAX_ACTIVE, ownerRpcFrame, type OwnerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { createDesktopMemoryOwner } from '../src/backend/desktop-memory-owner.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import { createMemoryOwnerSupervisor } from '../src/memory/node/owner-supervisor.ts'
import { createOwnerRpcPeer } from '../src/memory/node/owner-rpc-peer.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { eventually } from './fixtures/eventually.ts'
import { scratch } from './fixtures/scratch.js'
import { pauseOwnedProcess } from './fixtures/diagnostics-process-pause.ts'
import { createRemoteMemoryOwner } from '../plugins/memory/lib/remote-owner.ts'
import { openPluginOwner, registerStandaloneOwner } from '../plugins/memory/lib/standalone-owner.ts'
import { objectOf } from '../src/memory/contracts/unknown-value.ts'
import { replies, startHarness } from './fixtures/dsh-harness.ts'
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
    const received = await supervisor.callAdapter('receiveSource', [{ sessionId, messageId: randomUUID(),
      text: `I submit my weekly report on Friday. Reference ${turn}.`, at, timezone: 'UTC', turn, cwd: null }])
    await supervisor.callAdapter('completeTurn', [{ sessionId, turn, eventSeq: turn * 3, sourceIds: [received.sourceId],
      assistant: 'Understood.', completed: true, at, timezone: 'UTC' }])
  }
  await entered.promise
  assert.equal((await supervisor.callHost('listFiles', { args: [{}] })).status, 'ok')
  reply.resolve(JSON.stringify({ status: 'write', title: 'Weekly reporting', markdown: 'The weekly report is submitted on Friday.' }))
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


test('Viva activates its live dsh plugin after the first attach acknowledgement disappears', { timeout: 30_000 }, async t => {
  const emit = ChildProcess.prototype.emit
  let firstRequest: string | undefined, attempts = 0, dropped = false
  let sender: ChildProcess | undefined
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    const frame = event === 'message' ? ownerRpcFrame(args[0]) : null
    if (frame?.kind === 'request' && frame.method === 'attach') {
      attempts++
      if (!sender) {
        sender = this
        firstRequest = frame.id
        const send = this.send
        t.mock.method(this, 'send', function (this: ChildProcess, message: unknown, ...rest: unknown[]) {
          const response = ownerRpcFrame(message)
          if (response?.kind === 'result' && response.id === firstRequest && response.ok) { dropped = true; return true }
          return Reflect.apply(send, this, [message, ...rest]) as boolean
        })
      }
      assert.equal(this, sender)
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  const harness = await startHarness(t)
  const bridge = harness.bridge()
  await bridge.start()
  assert.ok(dropped)
  assert.equal(attempts, 2)
  assert.equal(bridge.pid(), sender?.pid)
  assert.ok(bridge.memory.ready())
  const text = 'Continue after a missing attach reply'
  await bridge.prompt(text)
  assert.ok(replies(harness.events).join('').includes(text))
})

test('a ready notification outranks an older attach response on the same Viva IPC link', async () => {
  const port = Object.assign(new EventEmitter(), { connected: true, send(frame: OwnerRpcFrame) {
    if (frame.kind !== 'request') return
    const state = { type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: 'new-owner', state: 'ready', revision: 1, coreEpoch: 0 }
    port.emit('message', { type: frame.type, kind: 'event', event: state })
    port.emit('message', { type: frame.type, kind: 'result', id: frame.id, ok: true,
      result: { ...state, epoch: 'retired-owner', state: 'recovering' } })
  } })
  const connection = openPluginOwner({ root: '/fixture', hostNamespace: 'viva' }, port as unknown as typeof process)
  try {
    await connection.start()
    assert.equal(connection.status(), 'ready')
    assert.equal(connection.epoch(), 'new-owner')
  } finally { await connection.close() }
})
