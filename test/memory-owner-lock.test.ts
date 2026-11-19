import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
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
  const options = { compute: () => null, route: () => null, quiesce: async () => {} }
  assert.throws(() => openMemoryOwner({ root, ...options }), /active owner/)
  assert.throws(() => openMemoryOwner({ root: alias, ...options }), /active owner/)
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  const replacement = openMemoryOwner({ root: alias, ...options })
  await replacement.recover(); assert.equal(replacement.ready(), true); await replacement.close()
})

test('supervisor reaps the old writer and drains its send grant before restoring the active turn', { timeout: 15_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-restart-')
  const drain = deferred<void>()
  const entered = deferred<string>()
  const supervisor = createMemoryOwnerSupervisor({
    root, hostNamespace: 'viva',
    callbacks: { drainSends: ({ epoch }) => { entered.resolve(epoch); return drain.promise } },
  })
  defer(() => { drain.resolve(); return supervisor.close() })
  await supervisor.start()
  const oldEpoch = supervisor.epoch()
  const oldPid = supervisor.pid()
  assert.ok(oldEpoch && oldPid && oldPid !== process.pid)
  const sessionId = randomUUID()
  const id = randomUUID()
  await supervisor.callAdapter('receiveSource', [{ sessionId, messageId: randomUUID(), text: 'Please save my morning schedule.',
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false }])
  await supervisor.callAdapter('acquireSend', [id, { session: sessionId }, 'a'.repeat(64)])
  process.kill(oldPid, 'SIGKILL')
  assert.equal(await entered.promise, oldEpoch)
  assert.equal(supervisor.status(), 'unavailable')
  assert.equal(supervisor.pid(), undefined)
  await assert.rejects(supervisor.callHost('profile', { args: [] }), /unavailable/)
  drain.resolve()
  await supervisor.start()
  assert.notEqual(supervisor.epoch(), oldEpoch)
  assert.notEqual(supervisor.pid(), oldPid)
  assert.equal((await supervisor.callAdapter('sessionView', [sessionId])).sessionContext.foregroundTurn, '1')
  await assert.rejects(supervisor.callAdapter('recordSendBody', [id]), /expired/)
  await supervisor.callAdapter('reconcileActiveTurns', [[{ sessionId, turn: 1 }]])
  assert.equal((await supervisor.callAdapter('sessionView', [sessionId])).sessionContext.foregroundTurn, '1')
  await supervisor.adapterExited()
  assert.equal((await supervisor.callAdapter('sessionView', [sessionId])).sessionContext.foregroundTurn, undefined)
})

test('a dsh-only exit releases pending send fences without restarting the owner or replaying a host write', { timeout: 15_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-dsh-exit-')
  const supervisor = createMemoryOwnerSupervisor({ root, hostNamespace: 'viva' })
  defer(supervisor.close)
  await supervisor.start()
  const epoch = supervisor.epoch()
  const pid = supervisor.pid()
  const session = randomUUID()
  const id = randomUUID()
  await supervisor.callAdapter('initializeSession', [{ sessionId: session }])
  await supervisor.callAdapter('acquireSend', [id, { session }, 'a'.repeat(64)])
  const revoked = deferred<void>()
  const reply = deferred<unknown>()
  const requestId = randomUUID()
  const unsubscribe = supervisor.subscribe(event => {
    if (event.type === 'memory_owner_send_revoked' && event.id === id) revoked.resolve()
    if (event.type === 'memory_host_result' && event.requestId === requestId) {
      assert.equal(event.epoch, epoch)
      if (event.ok) reply.resolve(event.result)
      else reply.reject(new Error(event.error.reason))
    }
  })
  defer(unsubscribe)
  const operationId = randomUUID()
  supervisor.sendHost({ type: 'memory_host_request', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch,
    method: 'setProfile', input: { args: [{ role: 'Designer' }, operationId] } })
  await revoked.promise
  await supervisor.adapterExited()
  await reply.promise
  assert.equal((await supervisor.callHost('getOperation', { operationId }))?.state, 'completed')
  assert.equal(supervisor.epoch(), epoch)
  assert.equal(supervisor.pid(), pid)
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

test('an aborted owner mutation waits for its actual terminal receipt', async () => {
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
    const result = left.call('adapter', { method: 'forgetStandaloneFile', args: [] }, { signal: request.signal })
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
      text: `I submit my weekly report on Friday. Reference ${turn}.`, at, timezone: 'UTC', turn, step: 1, admitted: true, inherited: false }])
    await supervisor.callAdapter('completeTurn', [{ sessionId, turn, eventSeq: turn * 3, sourceIds: [received.sourceId],
      assistant: 'Understood.', completed: true, at, timezone: 'UTC' }])
  }
  const jobId = await entered.promise
  const id = randomUUID()
  await supervisor.callAdapter('acquireSend', [id, { jobId }, 'b'.repeat(64)])
  await supervisor.callAdapter('recordSendBody', [id])
  await supervisor.callAdapter('settleSend', [id])
  assert.equal((await supervisor.callHost('listFiles', { args: [{}] })).status, 'ok')
  reply.resolve(JSON.stringify({ status: 'write', title: 'Weekly reporting', markdown: 'The weekly report is submitted on Friday.' }))
  assert.ok(await eventually(async () => (await supervisor.callHost('listFiles', { args: [{ kind: 'daily' }] })).items.length > 0))
  assert.equal(attempts.size, 1)
})

test('the first recovering state allows host receipts to finish a pending operation', { timeout: 15_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-owner-recovery-gate-')
  const initial = createMemoryOwnerSupervisor({ root, hostNamespace: 'viva' })
  defer(initial.close)
  await initial.start()
  const operationId = randomUUID()
  const conversation = randomUUID()
  await initial.callAdapter('receiveSource', [{ sessionId: conversation, messageId: randomUUID(), text: 'old local memory',
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false }])
  const prepared = await initial.callHost('prepareSourceChange', { operationId, conversation, ids: [] })
  assert.equal(initial.status(), 'recovering')
  await initial.close()

  const successor = createMemoryOwnerSupervisor({ root, hostNamespace: 'viva' })
  defer(successor.close)
  const firstRecovery = deferred<void>()
  let attempted = false
  const unsubscribe = successor.subscribe(state => {
    if (state.type !== 'memory_owner_state' || state.state !== 'recovering' || attempted) return
    attempted = true
    void successor.callHost('getOperation', { operationId }).then(receipt => {
      assert.equal(receipt?.state, 'prepared')
      return successor.callHost('commitSourceChange', { operationId, ticket: prepared.ticket })
    }).then(receipt => {
      assert.equal(receipt.state, 'completed')
      firstRecovery.resolve()
    }, firstRecovery.reject)
  })
  defer(unsubscribe)
  await Promise.all([successor.start(), firstRecovery.promise])
  assert.equal(successor.status(), 'ready')
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
  let fault: { matches(request: Request): boolean, hit: ReturnType<typeof deferred<unknown>> } | undefined
  const watched = new Map<string, NonNullable<typeof fault>>()
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (this.spawnargs?.includes('--memory-owner-ipc')) {
      if (event === 'spawn') {
        owner = this
        const send = this.send
        t.mock.method(this, 'send', function (this: ChildProcess, message: unknown, ...rest: unknown[]) {
          const frame = ownerRpcFrame(message)
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
              assert.ok(this.kill('SIGKILL'))
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
    drop(matches: (request: Request) => boolean) {
      assert.equal(fault, undefined)
      const hit = deferred<unknown>()
      fault = { matches, hit }
      return hit.promise
    },
  }
}

test('standalone owner restart settles lost grants, write receipts and manual Dream requests', { timeout: 45_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-standalone-lost-replies-')
  const fault = ownerFaults(t)
  const persistence = registerStandaloneOwner(root)
  defer(persistence.close)
  await persistence.start()
  const connection = openPluginOwner({ root, dailyNotes: true, callbacks: {
    drainSends: ({ epoch }): Promise<void> => adapter.drainSends(epoch),
  } }, process)
  const adapter = createRemoteMemoryOwner(connection, () => {})
  defer(adapter.close)
  await connection.start()
  const session = randomUUID()
  await adapter.initializeSession({ sessionId: session })

  const epoch = adapter.epoch
  const id = randomUUID()
  const droppedGrant = fault.drop(frame => frame.method === 'adapter' && objectOf(frame.input)?.method === 'acquireSend')
  const grant = assert.rejects(adapter.acquireSend(id, { session }, 'e'.repeat(64)), /retired|unavailable|revoked/)
  await Promise.all([droppedGrant, grant])
  assert.ok(await eventually(() => adapter.ready() && adapter.epoch !== epoch))
  await assert.rejects(adapter.call('recordSendBody', [id]), /expired/)

  const nextEpoch = adapter.epoch
  const request = { operationId: randomUUID(), title: 'Example recovery note', text: 'A single durable memory document.' }
  const droppedWrite = fault.drop(frame => frame.method === 'adapter' && objectOf(frame.input)?.method === 'rememberStandaloneFile')
  const write = assert.rejects(adapter.rememberStandaloneFile(session, request), /retired|unavailable/)
  const [receipt] = await Promise.all([droppedWrite, write])
  assert.ok(await eventually(() => adapter.ready() && adapter.epoch !== nextEpoch))
  assert.equal((await connection.callHost('getOperation', { operationId: request.operationId }))?.state, 'completed')
  assert.deepEqual(await adapter.rememberStandaloneFile(session, request), receipt)
  assert.equal((await connection.callHost('listFiles', { args: [{}] })).items.length, 1)

  const settledEpoch = adapter.epoch
  const permit = await adapter.acquireSend(randomUUID(), { session }, 'f'.repeat(64))
  await permit.recordBody()
  const droppedSettlement = fault.drop(frame => frame.method === 'adapter' && objectOf(frame.input)?.method === 'settleSend')
  permit.settled()
  await droppedSettlement
  assert.ok(await eventually(() => adapter.ready() && adapter.epoch !== settledEpoch))
  assert.equal(permit.current(), false)

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

test('Viva keeps dsh while retiring send and response paths and recovering an already committed write', { timeout: 45_000 }, async t => {
  const fault = ownerFaults(t)
  const started = deferred<void>()
  const stale = 'Stale owner generation response'
  const fresh = 'Continue with the new owner'
  let delayed = false
  const h = await startHarness(t, { decideFirst: (raw: object) => {
    const messages = objectOf(raw)?.messages
    if (!Array.isArray(messages)) return null
    const last = JSON.stringify(messages.findLast(message => objectOf(message)?.role === 'user'))
    if (!delayed && last?.includes('Probe the owner generation')) {
      delayed = true
      started.resolve()
      return { text: stale, delayMs: 2500 }
    }
    return null
  } })
  const bridge = h.bridge()
  await bridge.start()
  const dsh = bridge.pid(), epoch = bridge.memory.state()?.epoch
  assert.ok(dsh && epoch && fault.pid() !== dsh)
  const turn = bridge.prompt('Probe the owner generation')
  try {
    await started.promise
    fault.kill()
    await turn
  } finally { await turn.catch(() => {}) }
  assert.ok(await eventually(() => bridge.memory.ready() && bridge.memory.state()?.epoch !== epoch))
  assert.equal(bridge.pid(), dsh)
  await bridge.prompt(fresh)
  assert.ok(replies(h.events).join('').includes(fresh), 'the surviving dsh answered through the replacement owner')
  assert.ok(!JSON.stringify(h.events).includes(stale), 'the retired reply was neither streamed nor settled')
  assert.ok(!JSON.stringify(h.llm.requests).includes(stale), 'the retired reply was never included in a later model request')

  const nextEpoch = bridge.memory.state()?.epoch
  const request = { operationId: randomUUID(), title: 'Viva recovery note', text: 'A single durable Viva memory document.' }
  const dropped = fault.drop(frame => frame.method === 'host' && objectOf(frame.input)?.method === 'createFile')
  const write = assert.rejects(bridge.memory.call('createFile', { args: [request] }), /unavailable|generation/)
  const [receipt] = await Promise.all([dropped, write])
  assert.ok(await eventually(() => bridge.memory.ready() && bridge.memory.state()?.epoch !== nextEpoch))
  assert.equal(bridge.pid(), dsh)
  assert.equal((await bridge.memory.call('getOperation', { operationId: request.operationId }))?.state, 'completed')
  assert.deepEqual(await bridge.memory.call('createFile', { args: [request] }), receipt)
  assert.equal((await bridge.memory.call('listFiles', { args: [{}] })).items.length, 1)

  const sendEpoch = bridge.memory.state()?.epoch
  const unsent = 'A request body whose owner allowance never arrived'
  const droppedBody = fault.drop(frame => frame.method === 'adapter' && objectOf(frame.input)?.method === 'recordSendBody')
  await Promise.all([droppedBody, bridge.prompt(unsent)])
  assert.ok(!JSON.stringify(h.llm.requests).includes(unsent), 'the adapter released no request body without the owner acknowledgment')
  assert.ok(await eventually(() => bridge.memory.ready() && bridge.memory.state()?.epoch !== sendEpoch))
  assert.equal(bridge.pid(), dsh)
})
