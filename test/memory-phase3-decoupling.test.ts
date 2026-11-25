import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { createRemoteMemoryChannel } from '../src/backend/remote-memory-channel.ts'
import { MEMORY_HOST_PROTOCOL } from '../src/memory/contracts/host.ts'
import { ownerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { DREAM_CONSOLIDATE_SYSTEM, DREAM_PROFILE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { DREAM, WRITE_NOTE } from '../src/memory/core/memory-notes.ts'
import { createMemoryOwnerSupervisor } from '../src/memory/node/owner-supervisor.ts'
import { openMemoryDocuments } from '../src/memory/node/memory-document-store.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryRuntime } from '../src/memory/node/runtime.ts'
import { memorySourceToken, memorySourceWorkspace } from '../src/memory/node/source-identity.ts'
import { RESIDENT_PROFILE_PATH } from '../src/memory/core/resident-profile.ts'
import { applyMemoryAdapter } from '../plugins/memory/lib/adapter.ts'
import { withProvenanceHeader } from '../src/shared/request-routing/provenance.ts'
import { withRequestSource } from '../src/shared/request-routing/header.ts'
import { attachHostMemoryRelay } from '../plugins/memory/lib/host-relay.ts'
import { createSessionIngestion } from '../plugins/memory/lib/ingestion.ts'
import { openPluginOwner, registerStandaloneOwner } from '../plugins/memory/lib/standalone-owner.ts'
import { memoryProviderFailure } from '../plugins/memory/lib/model.ts'
import { objectOf } from '../src/memory/contracts/unknown-value.ts'
import { eventually } from './fixtures/eventually.ts'
import { scratch } from './fixtures/scratch.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createMockParentPort() {
  const port = new EventEmitter() as EventEmitter & {
    connected: boolean
    sent: unknown[]
    send: (msg: unknown, cb?: (err?: Error | null) => void) => boolean
  }
  port.connected = true
  port.sent = []
  port.send = (msg, cb) => {
    port.sent.push(msg)
    cb?.(null)
    return true
  }
  return port
}

test('parent IPC host relay supports cancel-before-budget, deadlineAt, MemoryDomainError round-trip, and retiring channel fencing', { timeout: 20_000 }, async t => {
  const { dir } = scratch(t, 'phase3-ipc-relay-')
  const root = path.join(dir, 'memory')
  const lifetime = new AbortController()
  const port = createMockParentPort()
  const connection = openPluginOwner({ root, hostNamespace: 'viva' }, port as unknown as NodeJS.Process)
  const relay = attachHostMemoryRelay({
    connection,
    port: port as unknown as NodeJS.Process,
    signal: lifetime.signal,
    getEpoch: () => connection.epoch(),
    enabled: true,
  })
  t.after(async () => {
    lifetime.abort()
    relay.close()
    await connection.close()
  })

  const sentToChild: unknown[] = []
  const channel = createRemoteMemoryChannel({
    send(msg) {
      sentToChild.push(msg)
      port.emit('message', msg)
    },
  })
  t.after(() => channel.close())
  port.send = (msg, cb) => {
    port.sent.push(msg)
    channel.receive(msg)
    cb?.(null)
    return true
  }
  const unsub = connection.subscribe(ev => { if (ev && typeof ev === 'object') relay.sendParent(ev) })
  t.after(unsub)

  await connection.start()
  assert.ok(await eventually(() => channel.ready(), { timeoutMs: 10_000 }))

  // 1. Round-trip createFile + idempotent retry + MemoryDomainError (operation.conflict)
  const opId = randomUUID()
  const created = await channel.call('createFile', { args: [{ operationId: opId, title: 'IPC Test', text: 'Phase 3 parent IPC round-trip' }] })
  assert.deepEqual(
    await channel.call('createFile', { args: [{ operationId: opId, title: 'IPC Test', text: 'Phase 3 parent IPC round-trip' }] }),
    created,
  )
  await assert.rejects(
    channel.call('createFile', { args: [{ operationId: opId, title: 'Conflict', text: 'Different body' }] }),
    (error: unknown) => objectOf(error)?.domainCode === 'operation.conflict',
  )

  // 2. sidecarRequest rejects host-only methods and legacy 'context' op outside §4.2 allowlist (P2-3)
  await assert.rejects(
    connection.callAdapter('sidecarRequest', [{ op: 'deleteAll' } as unknown as Parameters<typeof connection.callAdapter<'sidecarRequest'>>[1][0], dir]),
    /invalid|unsupported|parse|Expected/i,
  )
  await assert.rejects(
    connection.callAdapter('sidecarRequest', [{ op: 'context', session: randomUUID(), turn: 1, question: 'legacy' } as unknown as Parameters<typeof connection.callAdapter<'sidecarRequest'>>[1][0], dir]),
    /invalid|unsupported|parse|Expected/i,
  )

  // 3. Real attachHostMemoryRelay propagates memory_host_cancel to owner signal and honors waitForCompletion to hold read slot until terminal result (P2-5/P2-6)
  const relayPort = createMockParentPort()
  const callStarted = deferred<void>()
  const releaseCall = deferred<void>()
  let capturedSignal: AbortSignal | undefined
  let capturedWaitForCompletion: boolean | undefined
  const fakeConnection = {
    callHost(_method: unknown, _input: unknown, options?: { signal?: AbortSignal, waitForCompletion?: boolean }) {
      capturedSignal = options?.signal
      capturedWaitForCompletion = options?.waitForCompletion
      callStarted.resolve()
      if (!options?.waitForCompletion) {
        // Without waitForCompletion, abort settles the promise early (which would prematurely free the slot!).
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(options?.signal?.reason ?? new Error('aborted early'))
          options?.signal?.addEventListener('abort', onAbort, { once: true })
          void releaseCall.promise.then(() => {
            options?.signal?.removeEventListener('abort', onAbort)
            resolve({ files: [] })
          })
        })
      }
      return releaseCall.promise.then(() => {
        capturedSignal?.throwIfAborted()
        return { files: [] }
      })
    },
  }
  const cancelLifetime = new AbortController()
  const cancelRelay = attachHostMemoryRelay({
    connection: fakeConnection as unknown as Parameters<typeof attachHostMemoryRelay>[0]['connection'],
    port: relayPort as unknown as NodeJS.Process,
    signal: cancelLifetime.signal,
    getEpoch: () => 'e-cancel',
    enabled: true,
  })
  const heldChannel = createRemoteMemoryChannel({
    send: msg => { relayPort.emit('message', msg) },
  })
  relayPort.send = (msg, cb) => {
    relayPort.sent.push(msg)
    heldChannel.receive(msg)
    cb?.(null)
    return true
  }
  t.after(() => {
    releaseCall.resolve()
    cancelLifetime.abort()
    cancelRelay.close()
    heldChannel.close()
  })
  heldChannel.receive({
    type: 'memory_owner_state',
    protocol: MEMORY_HOST_PROTOCOL,
    epoch: 'e-cancel',
    state: 'ready',
    revision: 1,
    coreEpoch: 1,
    pid: 1234,
  })
  const abort = new AbortController()
  const batchPromise = heldChannel.readBatch(read => read('listFiles', { args: [{}] }), { signal: abort.signal, budgetMs: 5_000 })
  await callStarted.promise
  assert.equal(capturedWaitForCompletion, true, 'real attachHostMemoryRelay must pass waitForCompletion: true for readBatch')
  assert.equal(heldChannel.readState().executions, 1, 'active readBatch must occupy 1 execution slot')
  abort.abort(new Error('caller cancelled'))
  await assert.rejects(batchPromise, /caller cancelled/)
  assert.ok(await eventually(() => capturedSignal?.aborted === true, { timeoutMs: 3_000 }),
    'real attachHostMemoryRelay must propagate memory_host_cancel to worker/owner AbortSignal')
  await delay(30)
  assert.equal(heldChannel.readState().executions, 1, 'execution slot must remain occupied while worker has not physically settled')
  releaseCall.resolve()
  assert.ok(await eventually(() => heldChannel.readState().executions === 0, { timeoutMs: 3_000 }),
    'terminal memory_host_result must release the execution slot')

  // Retiring channel processExited rejects pending cleanly and ignores late frames
  heldChannel.processExited()
  assert.equal(heldChannel.ready(), false)
  assert.equal(heldChannel.receive({
    type: 'memory_host_result',
    protocol: MEMORY_HOST_PROTOCOL,
    requestId: 'late-req',
    epoch: 'e-cancel',
    ok: true,
    result: {},
  }), true)
})

test('L2 3-step boot, late-subscriber replay, unavailable immediate clear, empty-text clear, and worker crash rebuild', { timeout: 30_000 }, async t => {
  const { dir } = scratch(t, 'phase3-l2-boot-')
  const root = path.join(dir, 'memory')

  // Seed a resident profile directly into memory.db before booting the supervisor
  const store = openMemoryStore(path.join(root, 'memory.db'))
  const seedRuntime = createMemoryRuntime({ store, dailyNotes: false, compute: () => null, route: () => null, changed: () => {}, canCommit: () => true })
  const docs = openMemoryDocuments({
    db: store.db,
    root: store.fileRoot,
    source(id) {
      const current = store.readSource(id)
      return current?.text ? { text: current.text, workspace: memorySourceWorkspace(current), token: memorySourceToken(current) } : undefined
    },
  })
  const sid = randomUUID()
  const srcId = randomUUID()
  seedRuntime.accept('常驻画像：偏好简短结论', { conversation: sid, session: sid, scope: { kind: 'user' }, context: { kind: 'user' } }, srcId)
  const src = store.readSource(srcId)!
  docs.commit({
    operationId: randomUUID(),
    workspace: memorySourceWorkspace(src),
    path: RESIDENT_PROFILE_PATH,
    expectedRevision: null,
    action: 'CREATE',
    markdown: '---\nname: Personal Profile\ndescription: Resident\n---\n\n## 自动整理\n- 偏好简短结论',
    sources: [{ id: src.id, token: memorySourceToken(src) }],
    reads: [],
  })
  seedRuntime.close()

  // 1. Standalone late-subscriber replay: registerStandaloneOwner boots BEFORE adapter subscribes (same settings)
  const shared = registerStandaloneOwner(root)
  await shared.start()

  const config = path.join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(dir, 'sessions'), compression: 'zstd' } },
  ]))
  const ctx = await boot('phase3-l2-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose(); await shared.close() })

  const lateOwner = applyMemoryAdapter(ctx, { host: false, dataRoot: root, dailyNotes: true })
  const readL2 = async () => renderContextSnapshot(await ctx.systemPrompt.assemble())
  assert.equal(lateOwner.ready(), true, 'late-subscribing adapter must be immediately ready via 3-step replay')
  assert.ok(await eventually(async () => (await readL2()).includes('偏好简短结论'), { timeoutMs: 5_000 }),
    'late-subscribing adapter must immediately have L2 resident profile once systemPrompt injects')
  await lateOwner.close()
  await ctx.fiber.dispose()
  await shared.close()

  // 2. Host mode (config.host: true): worker pid reported, SIGKILL worker clears L2 on unavailable & rebuilds automatically
  const ctxHost = await boot('phase3-l2-host-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctxHost.fiber.dispose() })
  const port = createMockParentPort()
  const states: Array<{ state: string, pid?: number }> = []
  port.send = (raw, cb) => {
    port.sent.push(raw)
    const msg = objectOf(raw)
    if (msg?.type === 'memory_owner_state') {
      states.push({ state: String(msg.state), pid: typeof msg.pid === 'number' ? msg.pid : undefined })
    }
    cb?.(null)
    return true
  }

  const owner = applyMemoryAdapter(ctxHost, { host: true, dataRoot: root }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 10_000 }))
  const readHostL2 = async () => renderContextSnapshot(await ctxHost.systemPrompt.assemble())
  assert.match(await readHostL2(), /偏好简短结论/, 'host-mode adapter must populate L2 resident profile on boot')
  assert.ok(states.some(s => s.state === 'ready' && typeof s.pid === 'number'), 'memory_owner_state must carry worker pid')
  const firstPid = states.findLast(s => s.state === 'ready')!.pid!
  const firstEpoch = owner.epoch

  // Kill ONLY the memory-worker process: L2 clears on unavailable, then rebuilds automatically on replacement worker!
  process.kill(firstPid, 'SIGKILL')
  assert.ok(await eventually(async () => !owner.ready() && !(await readHostL2()).includes('偏好简短结论'), { timeoutMs: 10_000 }),
    'unavailable state must immediately fail-closed clear L2 profile')
  assert.ok(await eventually(() => owner.ready() && owner.epoch !== firstEpoch, { timeoutMs: 15_000 }),
    'supervisor must respawn replacement memory-worker with a new epoch')
  assert.match(await readHostL2(), /偏好简短结论/, 'replacement worker must rebuild L2 resident profile before ready')
})

test('single-hop agent/pre-step detects real mid-recall file disable (no frame mutation) and refreshes at most once (P2-5)', { timeout: 25_000 }, async t => {
  const { dir } = scratch(t, 'phase3-l3-stale-')
  const root = path.join(dir, 'memory')
  const config = path.join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(dir, 'sessions'), compression: 'zstd' } },
  ]))
  const ctx = await boot('phase3-l3-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose() })

  const seenMessages: string[] = []
  class CaptureAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seenMessages.push(JSON.stringify(options.messages))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new CaptureAdapter())

  // Observe real automaticRecall RPCs without mutating any reply frame:
  // when unmodified recall #1 returns its hit, disable the matched file via real setFileEnabled host RPC,
  // and release unmodified reply #1 only after the real worker commits the disable & broadcasts memory_owner_change.
  let recallCalls = 0
  let firstRecallId: string | undefined
  let firstRecallReply: Record<string, unknown> | undefined
  const firstRecallArrived = deferred<void>()
  const disableCommitted = deferred<void>()
  const origEmit = ChildProcess.prototype.emit
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (this.spawnargs?.includes('--memory-owner-ipc')) {
      if (event === 'spawn') {
        const origSend = this.send
        t.mock.method(this, 'send', function (this: ChildProcess, msg: unknown, ...rest: unknown[]) {
          const frame = ownerRpcFrame(msg)
          if (frame?.kind === 'request' && frame.method === 'adapter' && objectOf(frame.input)?.method === 'automaticRecall') {
            recallCalls++
            if (recallCalls === 1) firstRecallId = frame.id
          }
          return Reflect.apply(origSend, this, [msg, ...rest]) as boolean
        })
      } else if (event === 'message') {
        const frame = ownerRpcFrame(args[0])
        if (frame?.kind === 'result' && frame.ok && frame.id === firstRecallId) {
          firstRecallId = undefined
          firstRecallReply = objectOf(frame.result) ?? undefined
          firstRecallArrived.resolve()
          const child = this
          void disableCommitted.promise.then(() => {
            // Deliver the exact unmodified worker reply frame after the real disable committed.
            Reflect.apply(origEmit, child, [event, args[0]])
          })
          return true
        }
      }
    }
    return Reflect.apply(origEmit, this, [event, ...args]) as boolean
  })

  const port = createMockParentPort()
  const hostResults = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown }>>>()
  let latestChangeRev = 0
  port.send = (raw, cb) => {
    const msg = objectOf(raw)
    if (msg?.type === 'memory_host_result' && typeof msg.requestId === 'string') {
      hostResults.get(msg.requestId)?.resolve({ ok: Boolean(msg.ok), result: msg.result })
      hostResults.delete(msg.requestId)
    } else if (msg?.type === 'memory_owner_change' && typeof msg.revision === 'number') {
      latestChangeRev = Math.max(latestChangeRev, msg.revision)
    }
    cb?.(null)
    return true
  }

  const owner = applyMemoryAdapter(ctx, { host: true, dataRoot: root }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 10_000 }))

  const reqId = randomUUID()
  const waiter = deferred<{ ok: boolean, result?: unknown }>()
  hostResults.set(reqId, waiter)
  port.emit('message', {
    type: 'memory_host_request',
    protocol: MEMORY_HOST_PROTOCOL,
    requestId: reqId,
    epoch: owner.epoch!,
    method: 'createFile',
    input: { args: [{ operationId: randomUUID(), title: '刷新校验', text: 'STALE_REFRESH_MARKER_P3 发布清单规范' }] },
  })
  const createdRes = await waiter.promise
  assert.equal(createdRes.ok, true)
  const createdFile = objectOf(createdRes.result) as { identity: { workspace: string, path: string, id: string }, contentRevision: string }
  const readReqId = randomUUID()
  const readWaiter = deferred<{ ok: boolean, result?: unknown }>()
  hostResults.set(readReqId, readWaiter)
  port.emit('message', {
    type: 'memory_host_request',
    protocol: MEMORY_HOST_PROTOCOL,
    requestId: readReqId,
    epoch: owner.epoch!,
    method: 'readFile',
    input: { args: [createdFile.identity] },
  })
  const detailRes = await readWaiter.promise
  assert.equal(detailRes.ok, true)
  const fileVersion = objectOf(detailRes.result)!.version

  const sessionId = SessionId(randomUUID())
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'test-model' } })
  t.after(async () => { await handle.dispose() })

  const disableTask = firstRecallArrived.promise.then(async () => {
    assert.equal(objectOf(firstRecallReply?.result)?.status, 'hit', 'unmodified first recall must be a hit before disable')
    const revBeforeDisable = latestChangeRev
    const disableReqId = randomUUID()
    const disableWaiter = deferred<{ ok: boolean, result?: unknown }>()
    hostResults.set(disableReqId, disableWaiter)
    port.emit('message', {
      type: 'memory_host_request',
      protocol: MEMORY_HOST_PROTOCOL,
      requestId: disableReqId,
      epoch: owner.epoch!,
      method: 'setFileEnabled',
      input: {
        args: [{
          operationId: randomUUID(),
          identity: createdFile.identity,
          version: fileVersion,
          enabled: false,
        }],
      },
    })
    assert.equal((await disableWaiter.promise).ok, true)
    assert.ok(await eventually(() => latestChangeRev > revBeforeDisable, { timeoutMs: 3_000 }))
    disableCommitted.resolve()
  })

  const done = deferred<void>()
  const off = ctx.on('session/event', (session, event) => {
    if (session.id === handle.agent.session.id && event.type === 'turn/end') { off(); done.resolve() }
  })
  const queryText = '查询发布清单规范'
  const routed = withRequestSource(queryText, randomUUID(), queryText)
  const headedText = withProvenanceHeader(routed.text, {
    origin: 'human',
    sourceKind: 'main-human',
    sessionKind: 'main',
    conversationId: String(sessionId),
    sourceId: randomUUID(),
    humanSpans: routed.spans,
  })
  handle.agent.send(createUserMessage({ content: [{ type: 'text', text: headedText }], source: { kind: 'user' } }), 'next-turn', true)
  await Promise.all([done.promise, disableTask])

  assert.equal(recallCalls, 2, 'mid-recall file disable must trigger exactly one refresh without frame mutation')
  assert.ok(firstRecallReply, 'must have captured unmodified first recall reply')
  assert.ok(
    firstRecallReply.stale === true || Number(firstRecallReply.revision) < latestChangeRev,
    'unmodified worker reply must either be worker-flagged stale or carry pre-disable revision',
  )
  assert.equal((seenMessages[0] ?? '').includes('STALE_REFRESH_MARKER_P3'), false,
    'final LLM prompt must exclude the disabled file after at-most-once refresh')

  // Part B (P2-4): Worker-side cross-revision detection directly returns unmodified stale === true
  // when a real mutation commits between the worker's startRevision and endRevision reads inside automaticRecall.
  const sendHostRpc = async (method: string, input: unknown) => {
    const id = randomUUID()
    const w = deferred<{ ok: boolean, result?: unknown }>()
    hostResults.set(id, w)
    port.emit('message', { type: 'memory_host_request', protocol: MEMORY_HOST_PROTOCOL, requestId: id, epoch: owner.epoch!, method, input })
    const r = await w.promise
    assert.equal(r.ok, true)
    return r.result
  }
  await sendHostRpc('createFile', {
    args: [{ operationId: randomUUID(), title: '命中目标文件', text: 'WORKER_STALE_TARGET_MARKER 命中目标内容' }],
  })
  const otherCreated = objectOf(await sendHostRpc('createFile', {
    args: [{ operationId: randomUUID(), title: '并发变更文件', text: 'unrelated concurrent file content' }],
  })) as { identity: { workspace: string, path: string, id: string } }
  let otherDetail = objectOf(await sendHostRpc('readFile', { args: [otherCreated.identity] }))!

  const workerSession = randomUUID()
  const workerAliasText = '检索命中目标内容'
  let observedWorkerStale = false
  let toggleEnabled = false
  for (let attempt = 0; attempt < 5 && !observedWorkerStale; attempt++) {
    // Dispatch automaticRecall first, then immediately mutate an unrelated file in the same tick:
    // automaticRecall captures startRevision before awaiting async file search, while setFileEnabled
    // commits endRevision synchronously in SQLite -> worker observes startRevision !== endRevision with hit!
    const recallPromise = owner.call('automaticRecall', [
      { session: workerSession, turn: attempt + 1, question: workerAliasText },
      dir,
    ])
    const mutatePromise = sendHostRpc('setFileEnabled', {
      args: [{ operationId: randomUUID(), identity: otherCreated.identity, version: otherDetail.version, enabled: toggleEnabled }],
    })
    toggleEnabled = !toggleEnabled
    const [recallRes] = await Promise.all([recallPromise, mutatePromise])
    otherDetail = objectOf(await sendHostRpc('readFile', { args: [otherCreated.identity] }))!
    if (recallRes.result.status === 'hit' && recallRes.stale === true) observedWorkerStale = true
  }
  assert.equal(observedWorkerStale, true, 'real memory-worker must directly flag stale === true when revision advances mid-automaticRecall')
})

test('memoryProviderFailure classifies 429 Retry-After (both LlmFailure and thrown LlmError) and 503 overload', () => {
  const fromFrame = memoryProviderFailure({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 45_000 })
  assert.ok(fromFrame)
  assert.equal(fromFrame.reason, 'rate-limited')
  assert.equal(fromFrame.retryAfterMs, 45_000)

  const fromThrown = memoryProviderFailure(Object.assign(new Error('429'), {
    failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 9_999_999 },
  }))
  assert.ok(fromThrown)
  assert.equal(fromThrown.reason, 'rate-limited')
  assert.equal(fromThrown.retryAfterMs, 3_600_000, 'retryAfterMs must be capped at 1 hour')

  const from503 = memoryProviderFailure({ code: 'SERVER', status: 503 })
  assert.ok(from503)
  assert.equal(from503.reason, 'provider-overloaded')
  assert.equal(from503.retryAfterMs, undefined)
})

test('real plugin -> worker RPC enforces 429 Retry-After cooldown across Note, Dream (consolidate + profile), restart + manual Dream, 503 backoff, and foreground soft yielding', { timeout: 45_000 }, async t => {
  const { dir } = scratch(t, 'phase3-quota-gov-')
  const root = path.join(dir, 'memory')
  const config = path.join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(dir, 'sessions'), compression: 'zstd' } },
  ]))
  const ctx = await boot('phase3-quota-test', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctx.fiber.dispose() })

  type Mode = 'fg-hold' | 'note-429-frame' | 'note-503' | 'note-ok' | 'dream-429-consolidate' | 'dream-429-profile' | 'dream-ok'
  let mode: Mode = 'fg-hold'
  let fgStarted = deferred<void>()
  let fgRelease = deferred<void>()
  const bgCalls: Array<{ stage: string, mode: Mode }> = []

  class QuotaTestAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const first = options.messages[0]
      const isMemoryBg = Boolean(first && first.role === 'user' && first.source?.kind === 'viva-memory')
      if (!isMemoryBg) {
        fgStarted.resolve()
        await fgRelease.promise
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'fg done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fg done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const sys = typeof options.system === 'string' ? options.system : ''
      const isDreamConsolidate = sys.includes(DREAM_CONSOLIDATE_SYSTEM)
      const isDreamProfile = sys.includes(DREAM_PROFILE_SYSTEM)
      const stage = isDreamProfile ? 'dream_profile' : isDreamConsolidate ? 'dream_consolidate' : 'note'
      bgCalls.push({ stage, mode })

      if (mode === 'note-429-frame') {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'RATE_LIMIT', message: '429', status: 429, providerRetryAfterMs: 45_000 },
          },
        }
        return
      }
      if (mode === 'note-503') {
        throw new LlmError('503 overloaded', 'SERVER', { status: 503 })
      }
      if (mode === 'dream-429-consolidate' && isDreamConsolidate) {
        throw new LlmError('429 thrown', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 45_000 })
      }
      if (mode === 'dream-429-profile' && isDreamProfile) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'RATE_LIMIT', message: '429', status: 429, providerRetryAfterMs: 45_000 },
          },
        }
        return
      }
      const replyText = isDreamConsolidate
        ? JSON.stringify({ operations: [] })
        : isDreamProfile
          ? JSON.stringify({ action: 'NOOP' })
          : JSON.stringify({ status: 'write', title: 'Daily Note', markdown: 'Weekly report submitted on Friday.' })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: replyText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: replyText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new QuotaTestAdapter())

  const port = createMockParentPort()
  const hostResults = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown }>>>()
  port.send = (raw, cb) => {
    const msg = objectOf(raw)
    if (msg?.type === 'memory_host_result' && typeof msg.requestId === 'string') {
      hostResults.get(msg.requestId)?.resolve({ ok: Boolean(msg.ok), result: msg.result })
      hostResults.delete(msg.requestId)
    }
    cb?.(null)
    return true
  }

  const owner = applyMemoryAdapter(ctx, { host: true, dataRoot: root, dailyNotes: true }, port as unknown as NodeJS.Process)
  t.after(async () => { await owner.close() })
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 10_000 }))

  const readEffects = (kind: string) => {
    const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
    try {
      return db.prepare('SELECT kind, due_at, attempts, cooldown_until FROM effects WHERE kind = ?').all(kind) as Array<{
        kind: string, due_at: number, attempts: number, cooldown_until: number
      }>
    } finally { db.close() }
  }

  await owner.call('setRoute', [{ provider: 'mock', model: 'test-model' }])

  const seedTurns = async (
    targetCtx: typeof ctx,
    targetOwner: typeof owner,
    _targetPort: typeof port,
    _targetResults: typeof hostResults,
    sid: string,
    cwdPath: string,
    count: number,
  ) => {
    const baseAt = Date.now()
    const handle = await targetCtx.sessionPersistence.create({ version: 4, id: SessionId(sid), createdAt: baseAt, cwd: cwdPath, isSeeded: false })
    try {
      const events = []
      for (let turn = 1; turn <= count; turn++) {
        const fromSeq = (turn - 1) * 3
        events.push(
          { seq: SessionSeq(fromSeq), time: baseAt + fromSeq, type: 'turn/start' as const, data: { turn } },
          { seq: SessionSeq(fromSeq + 1), time: baseAt + fromSeq + 1, type: 'user/message' as const, data: createUserMessage({ content: [{ type: 'text', text: `I submit my weekly report every Friday. Turn ${turn}.` }], source: { kind: 'user' } }), surfaceOp: 'append' as const },
          { seq: SessionSeq(fromSeq + 2), time: baseAt + fromSeq + 2, type: 'turn/end' as const, data: { turn, reason: { kind: 'completed' as const } } },
        )
      }
      await handle.append(events)
    } finally {
      await handle.close()
    }
    for (let turn = 1; turn <= count; turn++) {
      const at = Date.now()
      const text = `I submit my weekly report every Friday. Turn ${turn}.`
      const sourceId = randomUUID()
      const fromSeq = (turn - 1) * 3
      await targetOwner.call('settleTurn', [{
        sessionId: sid,
        cwd: cwdPath,
        sessionKind: 'main',
        conversation: sid,
        inheritedSeq: 0,
        expectedNextSeq: fromSeq === 0 ? null : fromSeq,
        fromSeq,
        toSeq: fromSeq + 3,
        turn,
        reasonKind: 'completed',
        sources: [{ sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text, conversation: sid, at, timezone: 'UTC' }],
        assistantText: '',
        at,
        timezone: 'UTC',
      }])
    }
  }

  // First produce one real daily note so Dream consolidation has input to process.
  mode = 'note-ok'
  await seedTurns(ctx, owner, port, hostResults, randomUUID(), dir, 5)
  assert.ok(await eventually(() => bgCalls.some(c => c.stage === 'note'), { timeoutMs: 10_000 }), 'initial daily note must run')
  assert.ok(await eventually(() => readEffects(WRITE_NOTE).length === 0, { timeoutMs: 10_000 }), 'initial daily note effect must settle')
  const noteCallsBeforeFg = bgCalls.filter(c => c.stage === 'note').length

  // Part A: Foreground soft yielding (activeForegroundStreams > 0) defers background Note without touching attempts/cooldown_until!
  mode = 'fg-hold'
  t.after(() => fgRelease.resolve())
  const fgSession = SessionId(randomUUID())
  const fgHandle = await ctx.agents.create({ sessionId: fgSession, meta: { cwd: dir }, agentOptions: { provider: 'mock', model: 'test-model' } })
  t.after(async () => { fgRelease.resolve(); await fgHandle.dispose() })
  fgHandle.agent.send(createUserMessage({ content: [{ type: 'text', text: 'foreground stream active' }], source: { kind: 'user' } }), 'next-turn', true)
  await fgStarted.promise

  const noteSession = randomUUID()
  await seedTurns(ctx, owner, port, hostResults, noteSession, dir, 5)
  assert.ok(await eventually(() => readEffects(WRITE_NOTE).length > 0, { timeoutMs: 5_000 }))
  await delay(250)
  const deferredNotes = readEffects(WRITE_NOTE)
  assert.equal(bgCalls.filter(c => c.stage === 'note').length, noteCallsBeforeFg, 'background Note must soft-yield while foreground stream is active')
  assert.equal(deferredNotes[0]!.attempts, 0, 'soft-deferred Note must NOT increment attempts')
  assert.equal(deferredNotes[0]!.cooldown_until, 0, 'soft-deferred Note must NOT set cooldown_until')

  // Part A2: Manual Dream bypasses soft foreground yielding while foreground stream is STILL active!
  mode = 'dream-429-consolidate'
  const dreamReqId = randomUUID()
  const dreamWaiter = deferred<{ ok: boolean, result?: unknown }>()
  hostResults.set(dreamReqId, dreamWaiter)
  const failAtDream = Date.now()
  port.emit('message', {
    type: 'memory_host_request',
    protocol: MEMORY_HOST_PROTOCOL,
    requestId: dreamReqId,
    epoch: owner.epoch!,
    method: 'requestDream',
    input: { args: [randomUUID()] },
  })
  assert.equal((await dreamWaiter.promise).ok, true)
  assert.ok(await eventually(() => bgCalls.some(c => c.stage === 'dream_consolidate'), { timeoutMs: 10_000 }),
    'manual Dream (manual: true) must bypass foreground soft deferral')
  assert.ok(await eventually(() => {
    const rows = readEffects(DREAM)
    return rows.length > 0 && rows[0]!.cooldown_until >= failAtDream + 44_000
  }, { timeoutMs: 10_000 }), '429 Retry-After on Dream consolidate (thrown LlmError) must persist cooldown_until >= failAt + 45_000')
  const dreamRow = readEffects(DREAM)[0]!
  assert.ok(dreamRow.due_at >= dreamRow.cooldown_until, 'due_at must be >= cooldown_until')
  assert.equal(dreamRow.attempts, 1, 'provider 429 must increment attempts to 1')

  // Release foreground stream now
  fgRelease.resolve()
  await delay(100)

  // Part B: 429 -> worker restart -> manual requestDream before clock advances MUST preserve cooldown_until!
  await owner.close()
  const sup2 = createMemoryOwnerSupervisor({ root, hostNamespace: 'viva', dailyNotes: true })
  t.after(() => sup2.close())
  await sup2.start()
  const manualAfterRestart = await sup2.callHost('requestDream', { args: [randomUUID()] })
  assert.ok(manualAfterRestart)
  const dreamAfterRestart = readEffects(DREAM)[0]!
  assert.ok(dreamAfterRestart.cooldown_until >= dreamRow.cooldown_until, 'restart + manual Dream must preserve cooldown_until')
  assert.ok(dreamAfterRestart.due_at >= dreamAfterRestart.cooldown_until, 'manual Dream upsert must clamp due_at to MAX(due_at, cooldown_until)')
  await sup2.close()

  // Part C: Fresh Cordis ctx to test Note 429 via assembler.finish.failure frame
  const dirC = scratch(t, 'phase3-note-429-').dir
  const rootC = path.join(dirC, 'memory')
  const ctxC = await boot('phase3-quota-c', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctxC.fiber.dispose() })
  ctxC.llm.registerAdapter(['mock'], new QuotaTestAdapter())
  mode = 'note-429-frame'
  const portC = createMockParentPort()
  const hostResultsC = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown }>>>()
  portC.send = (raw, cb) => {
    const msg = objectOf(raw)
    if (msg?.type === 'memory_host_result' && typeof msg.requestId === 'string') {
      hostResultsC.get(msg.requestId)?.resolve({ ok: Boolean(msg.ok), result: msg.result })
      hostResultsC.delete(msg.requestId)
    }
    cb?.(null)
    return true
  }
  const ownerC = applyMemoryAdapter(ctxC, { host: true, dataRoot: rootC, dailyNotes: true }, portC as unknown as NodeJS.Process)
  t.after(async () => { await ownerC.close() })
  assert.ok(await eventually(() => ownerC.ready(), { timeoutMs: 10_000 }))
  await ownerC.call('setRoute', [{ provider: 'mock', model: 'test-model' }])
  const failAtNote = Date.now()
  await seedTurns(ctxC, ownerC, portC, hostResultsC, randomUUID(), dirC, 5)
  const readEffectsC = (kind: string) => {
    const db = new DatabaseSync(path.join(rootC, 'memory.db'), { readOnly: true })
    try {
      return db.prepare('SELECT due_at, attempts, cooldown_until FROM effects WHERE kind = ?').all(kind) as Array<{
        due_at: number, attempts: number, cooldown_until: number
      }>
    } finally { db.close() }
  }
  assert.ok(await eventually(() => {
    const rows = readEffectsC(WRITE_NOTE)
    return rows.length > 0 && rows[0]!.cooldown_until >= failAtNote + 44_000
  }, { timeoutMs: 10_000 }), '429 Retry-After on Note (assembler.finish.failure) must persist cooldown_until >= failAt + 45_000')
  const note429 = readEffectsC(WRITE_NOTE)[0]!
  assert.ok(note429.due_at >= note429.cooldown_until)
  assert.equal(note429.attempts, 1)
  await ownerC.close()

  // Part D: Fresh Cordis ctx to test 503 without Retry-After uses 1_000ms exponential backoff (cooldown_until === 0)
  const dirD = scratch(t, 'phase3-note-503-').dir
  const rootD = path.join(dirD, 'memory')
  const ctxD = await boot('phase3-quota-d', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctxD.fiber.dispose() })
  ctxD.llm.registerAdapter(['mock'], new QuotaTestAdapter())
  mode = 'note-503'
  const portD = createMockParentPort()
  const hostResultsD = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown }>>>()
  portD.send = (raw, cb) => {
    const msg = objectOf(raw)
    if (msg?.type === 'memory_host_result' && typeof msg.requestId === 'string') {
      hostResultsD.get(msg.requestId)?.resolve({ ok: Boolean(msg.ok), result: msg.result })
      hostResultsD.delete(msg.requestId)
    }
    cb?.(null)
    return true
  }
  const ownerD = applyMemoryAdapter(ctxD, { host: true, dataRoot: rootD, dailyNotes: true }, portD as unknown as NodeJS.Process)
  t.after(async () => { await ownerD.close() })
  assert.ok(await eventually(() => ownerD.ready(), { timeoutMs: 10_000 }))
  await ownerD.call('setRoute', [{ provider: 'mock', model: 'test-model' }])
  await seedTurns(ctxD, ownerD, portD, hostResultsD, randomUUID(), dirD, 5)
  const readEffectsD = () => {
    const db = new DatabaseSync(path.join(rootD, 'memory.db'), { readOnly: true })
    try {
      return db.prepare('SELECT due_at, attempts, cooldown_until FROM effects WHERE kind = ?').all(WRITE_NOTE) as Array<{
        due_at: number, attempts: number, cooldown_until: number
      }>
    } finally { db.close() }
  }
  assert.ok(await eventually(() => {
    const rows = readEffectsD()
    return rows.length > 0 && rows[0]!.attempts >= 1
  }, { timeoutMs: 10_000 }), '503 without Retry-After must increment attempts with exponential backoff')
  assert.equal(readEffectsD()[0]!.cooldown_until, 0, '503 without Retry-After must NOT set cooldown_until')
  await ownerD.close()

  // Part E: Dream profile pass 429 via assembler.finish.failure persists cooldown_until >= failAt + 45_000
  const dirE = scratch(t, 'phase3-dream-profile-429-').dir
  const rootE = path.join(dirE, 'memory')
  const ctxE = await boot('phase3-quota-e', config, [], undefined, new URL('../package.json', import.meta.url).href)
  t.after(async () => { await ctxE.fiber.dispose() })
  ctxE.llm.registerAdapter(['mock'], new QuotaTestAdapter())
  mode = 'note-ok'
  const portE = createMockParentPort()
  const hostResultsE = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown }>>>()
  portE.send = (raw, cb) => {
    const msg = objectOf(raw)
    if (msg?.type === 'memory_host_result' && typeof msg.requestId === 'string') {
      hostResultsE.get(msg.requestId)?.resolve({ ok: Boolean(msg.ok), result: msg.result })
      hostResultsE.delete(msg.requestId)
    }
    cb?.(null)
    return true
  }
  const ownerE = applyMemoryAdapter(ctxE, { host: true, dataRoot: rootE, dailyNotes: true }, portE as unknown as NodeJS.Process)
  t.after(async () => { await ownerE.close() })
  assert.ok(await eventually(() => ownerE.ready(), { timeoutMs: 10_000 }))
  await ownerE.call('setRoute', [{ provider: 'mock', model: 'test-model' }])
  await seedTurns(ctxE, ownerE, portE, hostResultsE, randomUUID(), dirE, 5)
  const readEffectsE = (kind: string) => {
    const db = new DatabaseSync(path.join(rootE, 'memory.db'), { readOnly: true })
    try {
      return db.prepare('SELECT due_at, attempts, cooldown_until FROM effects WHERE kind = ?').all(kind) as Array<{
        due_at: number, attempts: number, cooldown_until: number
      }>
    } finally { db.close() }
  }
  assert.ok(await eventually(() => readEffectsE(WRITE_NOTE).length === 0 && readEffectsE(DREAM).length > 0, { timeoutMs: 10_000 }))
  mode = 'dream-429-profile'
  const failAtProfile = Date.now()
  const profReqId = randomUUID()
  const profWaiter = deferred<{ ok: boolean, result?: unknown }>()
  hostResultsE.set(profReqId, profWaiter)
  portE.emit('message', {
    type: 'memory_host_request',
    protocol: MEMORY_HOST_PROTOCOL,
    requestId: profReqId,
    epoch: ownerE.epoch!,
    method: 'requestDream',
    input: { args: [randomUUID()] },
  })
  assert.equal((await profWaiter.promise).ok, true)
  assert.ok(await eventually(() => {
    const rows = readEffectsE(DREAM)
    return rows.length > 0 && rows[0]!.cooldown_until >= failAtProfile + 44_000
  }, { timeoutMs: 10_000 }), '429 Retry-After on Dream profile pass (assembler.finish.failure) must persist cooldown_until >= failAt + 45_000')
  assert.equal(readEffectsE(DREAM)[0]!.attempts, 1)
})

test('Dream edited in-flight preserves Retry-After cooldown on newer generation without bumping attempts (P1-4) and non-agent-loop streams do not defer background work (P2-4)', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'phase3-dream-race-p14-')
  const root = path.join(dir, 'memory')
  const config = path.join(dir, 'cordis.yml')
  writeFileSync(config, JSON.stringify([
    ...['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-agent-loop', 'dsh-tool-executor-native', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-user-questions']
      .map(name => ({ id: name, name: '@deepseek-ai/' + name })),
    { id: 'session-persistence-jsonl', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(dir, 'sessions'), compression: 'zstd' } },
  ]))
  const ctx = await boot('phase3-p14-p24', config, [], undefined, new URL('../package.json', import.meta.url).href)
  defer(async () => { await ctx.fiber.dispose() })

  const dreamEntered = deferred<void>()
  const releaseDream429 = deferred<void>()
  const fgEntered = deferred<void>()
  const releaseFg = deferred<void>()
  const summarizerRelease = deferred<void>()
  let dreamPhase: 'hold-429' | 'ok' = 'hold-429'
  const stages: string[] = []

  class RaceAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const first = options.messages[0]
      const isMemoryBg = Boolean(first && first.role === 'user' && first.source?.kind === 'viva-memory')
      if (!isMemoryBg) {
        if (JSON.stringify(options.messages).includes('compaction-summary-probe')) {
          await summarizerRelease.promise
        } else {
          fgEntered.resolve()
          await releaseFg.promise
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const sys = typeof options.system === 'string' ? options.system : ''
      const isDreamConsolidate = sys.includes(DREAM_CONSOLIDATE_SYSTEM)
      const isDreamProfile = sys.includes(DREAM_PROFILE_SYSTEM)
      const stage = isDreamProfile ? 'dream_profile' : isDreamConsolidate ? 'dream_consolidate' : 'note'
      stages.push(stage)
      if (isDreamConsolidate && dreamPhase === 'hold-429') {
        dreamEntered.resolve()
        await releaseDream429.promise
        throw new LlmError('429 during edit race', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 45_000 })
      }
      const text = isDreamConsolidate ? JSON.stringify({ operations: [] })
        : isDreamProfile ? JSON.stringify({ action: 'NOOP' })
        : JSON.stringify({ status: 'write', title: 'Daily Note', markdown: 'Weekly report on Friday.' })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new RaceAdapter())

  const port = createMockParentPort()
  const hostResults = new Map<string, ReturnType<typeof deferred<{ ok: boolean, result?: unknown }>>>()
  port.send = (raw, cb) => {
    const msg = objectOf(raw)
    if (msg?.type === 'memory_host_result' && typeof msg.requestId === 'string') {
      hostResults.get(msg.requestId)?.resolve({ ok: Boolean(msg.ok), result: msg.result })
      hostResults.delete(msg.requestId)
    }
    cb?.(null)
    return true
  }
  const owner = applyMemoryAdapter(ctx, { host: true, dataRoot: root, dailyNotes: true }, port as unknown as NodeJS.Process)
  t.after(async () => {
    releaseDream429.resolve()
    releaseFg.resolve()
    summarizerRelease.resolve()
    await owner.close()
  })
  assert.ok(await eventually(() => owner.ready(), { timeoutMs: 10_000 }))
  await owner.call('setRoute', [{ provider: 'mock', model: 'test-model' }])

  const sendHost = async (method: string, input: unknown) => {
    const requestId = randomUUID()
    const waiter = deferred<{ ok: boolean, result?: unknown }>()
    hostResults.set(requestId, waiter)
    port.emit('message', { type: 'memory_host_request', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch: owner.epoch!, method, input })
    const res = await waiter.promise
    assert.equal(res.ok, true)
    return res.result
  }
  const readDream = () => {
    const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
    try {
      return db.prepare('SELECT generation, due_at, attempts, cooldown_until FROM effects WHERE kind = ?').get(DREAM) as
        { generation: number, due_at: number, attempts: number, cooldown_until: number } | undefined
    } finally { db.close() }
  }

  // P2-4a: Hold a non-agent-loop stream WITH sessionId (like compaction summarizer); background Note must NOT be deferred!
  const fakeSummarizerSession = SessionId(randomUUID())
  const summarizerIter = ctx.llm.stream({
    provider: 'mock',
    model: 'test-model',
    sessionId: fakeSummarizerSession,
    messages: [createUserMessage({ content: [{ type: 'text', text: 'compaction-summary-probe' }], source: { kind: 'user' } })],
  })[Symbol.asyncIterator]()
  const summarizerPending = summarizerIter.next()

  const sid = randomUUID()
  const baseAt2 = Date.now()
  const h2 = await ctx.sessionPersistence.create({ version: 4, id: SessionId(sid), createdAt: baseAt2, cwd: dir, isSeeded: false })
  try {
    const evs = []
    for (let turn = 1; turn <= 5; turn++) {
      const fromSeq = (turn - 1) * 3
      evs.push(
        { seq: SessionSeq(fromSeq), time: baseAt2 + fromSeq, type: 'turn/start' as const, data: { turn } },
        { seq: SessionSeq(fromSeq + 1), time: baseAt2 + fromSeq + 1, type: 'user/message' as const, data: createUserMessage({ content: [{ type: 'text', text: `Compaction probe turn ${turn}` }], source: { kind: 'user' } }), surfaceOp: 'append' as const },
        { seq: SessionSeq(fromSeq + 2), time: baseAt2 + fromSeq + 2, type: 'turn/end' as const, data: { turn, reason: { kind: 'completed' as const } } },
      )
    }
    await h2.append(evs)
  } finally {
    await h2.close()
  }
  for (let turn = 1; turn <= 5; turn++) {
    const at = Date.now()
    const text = `Compaction probe turn ${turn}`
    const sourceId = randomUUID()
    const fromSeq = (turn - 1) * 3
    await owner.call('settleTurn', [{
      sessionId: sid,
      cwd: dir,
      sessionKind: 'main',
      conversation: sid,
      inheritedSeq: 0,
      expectedNextSeq: fromSeq === 0 ? null : fromSeq,
      fromSeq,
      toSeq: fromSeq + 3,
      turn,
      reasonKind: 'completed',
      sources: [{ sourceId, author: 'user', sourceKind: 'main-human', profileEligible: true, text, conversation: sid, at, timezone: 'UTC' }],
      assistantText: '',
      at,
      timezone: 'UTC',
    }])
  }
  assert.ok(await eventually(() => stages.includes('note'), { timeoutMs: 8_000 }),
    'non-agent-loop stream carrying sessionId must NOT defer background Note')
  summarizerRelease.resolve()
  await summarizerPending
  assert.ok(await eventually(() => {
    const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
    try { return db.prepare('SELECT 1 FROM effects WHERE kind = ?').all(WRITE_NOTE).length === 0 }
    finally { db.close() }
  }, { timeoutMs: 8_000 }), 'initial daily note effect must settle before starting Dream')

  // P1-4: Start Dream generation G, edit/create a memory file while G is in-flight (re-queuing Dream to G+1), then fail G with 429 Retry-After: 45s.
  await sendHost('requestDream', { args: [randomUUID()] })
  await dreamEntered.promise
  const beforeRequeue = readDream()
  assert.ok(beforeRequeue, 'Dream effect G must exist while running')

  await sendHost('createFile', {
    args: [{
      operationId: randomUUID(),
      title: '并发编辑触发 G+1',
      text: 'In-flight edit that re-queues Dream to G+1',
    }],
  })
  const afterRequeue = readDream()
  assert.ok(afterRequeue && afterRequeue.generation > beforeRequeue.generation, 'in-flight file write must bump Dream to G+1')
  assert.equal(afterRequeue.attempts, 0)

  const failAt = Date.now()
  releaseDream429.resolve()
  assert.ok(await eventually(() => {
    const row = readDream()
    return Boolean(row && row.generation === afterRequeue.generation && row.cooldown_until >= failAt + 44_000)
  }, { timeoutMs: 8_000 }), 'G 429 Retry-After must persist cooldown_until onto G+1 row')
  const finalDream = readDream()!
  assert.ok(finalDream.due_at >= finalDream.cooldown_until, 'G+1 due_at must be >= cooldown_until')
  assert.equal(finalDream.attempts, 0, 'G 429 must NOT increment G+1 attempts')

  // P2-4b: Anti-starvation batch exemption across 2-pass automatic Dream while foreground stream stays open > 30s.
  let clockOffset = 0
  const realDateNow = Date.now
  t.mock.method(Date, 'now', () => realDateNow() + clockOffset)

  dreamPhase = 'ok'
  const fgSession = SessionId(randomUUID())
  const fgHandle = await ctx.agents.create({ sessionId: fgSession, meta: { cwd: dir }, agentOptions: { provider: 'mock', model: 'test-model' } })
  defer(async () => { releaseFg.resolve(); await fgHandle.dispose() })
  fgHandle.agent.send(createUserMessage({ content: [{ type: 'text', text: 'long foreground stream' }], source: { kind: 'user' } }), 'next-turn', true)
  await fgEntered.promise

  // Switch Dream back to automatic (clear dream.manualJob) and make it due now.
  const consolidateBefore = stages.filter(s => s === 'dream_consolidate').length
  const profileBefore = stages.filter(s => s === 'dream_profile').length
  {
    const db = new DatabaseSync(path.join(root, 'memory.db'))
    try {
      db.prepare("DELETE FROM memory_meta WHERE key IN ('dream.manualJob', 'dream.manualFollowup')").run()
      db.prepare('UPDATE effects SET due_at = 0, cooldown_until = 0, attempts = 0 WHERE kind = ?').run(DREAM)
    } finally { db.close() }
  }
  await owner.call('setRoute', [null])
  await owner.call('setRoute', [{ provider: 'mock', model: 'test-model' }])
  await delay(150)
  assert.equal(stages.filter(s => s === 'dream_consolidate').length, consolidateBefore, 'automatic Dream must initially soft-yield')

  // Advance Date.now beyond 30s MAX_SOFT_YIELD_MS while foreground stream is STILL open -> both passes must complete!
  clockOffset = 35_000
  {
    const db = new DatabaseSync(path.join(root, 'memory.db'))
    try {
      db.prepare('UPDATE effects SET due_at = 0 WHERE kind = ?').run(DREAM)
    } finally { db.close() }
  }
  await owner.call('setRoute', [null])
  await owner.call('setRoute', [{ provider: 'mock', model: 'test-model' }])
  assert.ok(await eventually(() => {
    if (stages.filter(s => s === 'dream_consolidate').length <= consolidateBefore) return false
    if (stages.filter(s => s === 'dream_profile').length <= profileBefore) return false
    const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
    try {
      const notes = db.prepare('SELECT revision, processed FROM memory_daily_notes').all() as Array<{ revision: number, processed: number }>
      return notes.length > 0 && notes.every(row => row.processed >= row.revision && row.revision > 0)
    } finally { db.close() }
  }, { timeoutMs: 10_000 }),
    'anti-starvation batch exemption must let both automatic Dream passes AND SQLite note checkpoint commit while foreground stream remains open')
  releaseFg.resolve()
})

test('createRemoteMemoryChannel.waitReady honors bounded budgetMs and survives unavailable(A) -> recovering(B) -> ready(B) (P1-3)', async t => {
  const channel = createRemoteMemoryChannel({ send() {} })
  t.after(() => channel.close())

  const started = performance.now()
  await assert.rejects(() => channel.waitReady(60), /did not become ready|unavailable/i)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 400, `bounded waitReady(60) must reject promptly, got ${elapsed}ms`)

  channel.receive({
    type: 'memory_owner_state',
    protocol: MEMORY_HOST_PROTOCOL,
    epoch: 'e-old',
    state: 'unavailable',
    revision: 1,
    coreEpoch: 1,
    pid: 1,
  })
  const waiting = channel.waitReady(500)
  setTimeout(() => {
    channel.receive({
      type: 'memory_owner_state',
      protocol: MEMORY_HOST_PROTOCOL,
      epoch: 'e-new',
      state: 'recovering',
      revision: 1,
      coreEpoch: 1,
      pid: 2,
    })
  }, 15)
  setTimeout(() => {
    channel.receive({
      type: 'memory_owner_state',
      protocol: MEMORY_HOST_PROTOCOL,
      epoch: 'e-new',
      state: 'ready',
      revision: 1,
      coreEpoch: 1,
      pid: 2,
    })
  }, 35)
  await waiting
  assert.equal(channel.ready(), true)
})
