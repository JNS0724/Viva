import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryClient, createMemoryService, MemoryServiceError } from '../src/memory/core/client.ts'
import { MEMORY_SERVICE_PROTOCOL, memoryConversationEvent } from '../src/memory/contracts/service.ts'
import type { MemoryClientBinding, MemoryCommand, MemoryMethod, MemoryResult, MemoryServiceStatus } from '../src/memory/contracts/service.ts'

const operationId = '038f4e1a-40d4-4fdd-98de-4146de21beb3'
function fixture(kind: MemoryClientBinding['kind'] = 'user-interface') {
  let epoch = 'owner-1'
  let state: MemoryServiceStatus['state'] = 'ready'
  const commands: MemoryCommand[] = []
  const grants: MemoryMethod[] = ['status', 'list', 'remember', 'getOperation', 'pendingHostEffects', 'ackHostEffect']
  const binding: MemoryClientBinding = { clientId: 'client-1', namespace: 'local-user', kind, capabilities: grants }
  let authorization: (command: MemoryCommand) => boolean | Promise<boolean> = command => command.method !== 'list' || command.input.scope.kind === 'user'
  let execute: (command: MemoryCommand) => MemoryResult | Promise<MemoryResult> = command => {
    commands.push(command)
    if (command.method === 'list') return { items: [], partial: false }
    if (command.method === 'remember') return { operationId: command.input.operationId, state: 'completed', revision: 1 }
    if (command.method === 'getOperation') return { operationId: command.input.operationId, state: 'completed', revision: 1 }
    if (command.method === 'pendingHostEffects') return { effects: [] }
    if (command.method === 'ackHostEffect') return { accepted: true }
    throw new Error('not implemented')
  }
  const service = createMemoryService({ binding, supported: grants, epoch: () => epoch, state: () => state,
    authorize: (_, command) => authorization(command), execute: command => execute(command) })
  let sequence = 0
  const client = createMemoryClient({ transport: service, requestId: () => `request-${++sequence}` })
  return { client, service, commands, grants, setEpoch: (value: string) => { epoch = value }, setState: (value: typeof state) => { state = value },
    authorize: (value: typeof authorization) => { authorization = value }, execute: (value: typeof execute) => { execute = value } }
}
const failure = (code: string, reason?: string) => (error: unknown) => error instanceof MemoryServiceError
  && error.failure.code === code && (reason === undefined || error.failure.reason === reason)

test('service advertises only granted implemented capabilities and uses trusted target authorization', async () => {
  const f = fixture()
  await assert.rejects(f.client.call('list', { scope: { kind: 'user' } }), failure('unavailable', 'not-connected'))
  const status = await f.client.connect()
  assert.equal(status.capabilities.includes('pendingHostEffects'), false)
  assert.equal(status.capabilities.includes('read'), false)
  f.grants.push('read')
  assert.equal((await f.client.call('status', {})).capabilities.includes('read'), false)
  assert.deepEqual(await f.client.call('list', { scope: { kind: 'user' } }), { items: [], partial: false })
  await assert.rejects(f.client.call('list', { scope: { kind: 'project', id: 'someone-else' } }), failure('unauthorized'))
  await assert.rejects(f.client.call('pendingHostEffects', {}), failure('unauthorized'))
  assert.equal(f.commands.length, 1)
})

test('wire validation rejects self-asserted authority and protocol mismatches', async () => {
  const f = fixture()
  const call = (extra: object) => f.service({ protocol: MEMORY_SERVICE_PROTOCOL, requestId: 'r', instanceEpoch: 'owner-1', method: 'list', input: { scope: { kind: 'user' } }, ...extra })
  assert.deepEqual(await call({ owner: 'admin' }), { requestId: 'invalid-request', instanceEpoch: 'owner-1', ok: false, error: { code: 'invalid-input' } })
  assert.deepEqual(await call({ input: { scope: { kind: 'user' }, owner: 'admin' } }), { requestId: 'r', instanceEpoch: 'owner-1', ok: false, error: { code: 'invalid-input' } })
  assert.deepEqual(await call({ protocol: 99 }), { requestId: 'r', instanceEpoch: 'owner-1', ok: false, error: { code: 'protocol-mismatch' } })
  assert.equal(f.commands.length, 0)
})

test('recovering allows outcome and host cleanup queries without admitting memory reads or writes', async () => {
  const f = fixture('host')
  f.setState('recovering')
  assert.equal((await f.client.connect()).state, 'recovering')
  assert.equal((await f.client.call('getOperation', { operationId }))?.state, 'completed')
  assert.deepEqual(await f.client.call('pendingHostEffects', {}), { effects: [] })
  assert.deepEqual(await f.client.call('ackHostEffect', { effectId: 'effect', causeOperationId: operationId, revision: 2 }), { accepted: true })
  await assert.rejects(f.client.call('list', { scope: { kind: 'user' } }), failure('unavailable', 'recovering'))
  await assert.rejects(f.client.call('remember', { operationId, text: 'example', scope: { kind: 'user' }, input: { kind: 'explicit-user' } }), failure('unavailable', 'recovering'))
  f.setState('unavailable')
  assert.equal((await f.client.call('status', {})).state, 'unavailable')
})

test('operation IDs survive reconnect while stale epochs and post-authorization owner changes reject', async () => {
  const f = fixture()
  await f.client.connect()
  const input = { operationId, text: 'example', scope: { kind: 'user' as const }, input: { kind: 'explicit-user' as const } }
  await f.client.call('remember', input)
  f.setEpoch('owner-2')
  await assert.rejects(f.client.call('remember', input), failure('unavailable', 'stale-epoch'))
  await f.client.connect()
  assert.equal((await f.client.call('getOperation', { operationId }))?.operationId, operationId)
  assert.equal(f.commands.filter(command => command.method === 'remember').length, 1)
  f.authorize(async () => { f.setEpoch('owner-3'); return true })
  await assert.rejects(f.client.call('remember', input), failure('unavailable', 'stale-epoch'))
  assert.equal(f.commands.filter(command => command.method === 'remember').length, 1)
})

test('model proposals cannot forge explicit-user authority and source references are schema-checked', async () => {
  const f = fixture('model')
  await f.client.connect()
  await assert.rejects(f.client.call('remember', { operationId, text: 'example', scope: { kind: 'user' }, input: { kind: 'explicit-user' } }), failure('unauthorized'))
  const input = { operationId, text: 'example', scope: { kind: 'user' as const }, input: { kind: 'model-proposal' as const, sources: [{ namespace: 'user', sourceId: 'source', revision: 1 }] } }
  assert.equal((await f.client.call('remember', input)).state, 'completed')
  assert.equal(memoryConversationEvent.safeParse({ kind: 'received', eventId: 'e', cursor: 'c', threadId: 't', at: 1,
    source: { namespace: 'u', sourceId: 's', revision: 1 }, role: 'user', origin: 'derived', text: 'summary', dependencies: [], owner: 'admin' }).success, false)
})

test('endpoint does not leak invalid results/internal exceptions and client checks correlation', async () => {
  const f = fixture()
  await f.client.connect()
  f.execute(() => { throw new Error('/private/secret credentials') })
  await assert.rejects(f.client.call('list', { scope: { kind: 'user' } }), failure('unavailable'))
  f.execute(() => ({ operationId, state: 'completed' }))
  await assert.rejects(f.client.call('list', { scope: { kind: 'user' } }), failure('unavailable', 'invalid-service-result'))
  const client = createMemoryClient({ requestId: () => 'expected', transport: async () => ({ requestId: 'wrong', instanceEpoch: 'owner', ok: true, result: {} }) })
  await assert.rejects(client.connect(), failure('unavailable', 'invalid-service-response'))
})

test('disconnect invalidates in-flight read response', async () => {
  const f = fixture()
  await f.client.connect()
  let finish: (() => void) | undefined
  f.execute(async () => { await new Promise<void>(resolve => { finish = resolve }); return { items: [], partial: false } })
  const pending = f.client.call('list', { scope: { kind: 'user' } })
  await new Promise<void>(resolve => setImmediate(resolve))
  f.client.disconnect()
  finish?.()
  await assert.rejects(pending, failure('unavailable', 'superseded-connection'))
})

test('non-DSH model port returns tool execution and added evidence to the isolated model job', async () => {
  const sources: import('../src/memory/contracts/service.ts').MemorySourceReference[] = [{ namespace: 'local', sourceId: 's', revision: 2 }]
  const calls: string[] = []
  const model: import('../src/memory/contracts/service.ts').MemoryModelCompute = {
    async run(job, { signal, executeTool }) {
      assert.equal(signal.aborted, false)
      assert.deepEqual(job.sources, [])
      assert.equal(job.tools[0].name, 'read')
      const result = await executeTool({ callId: `${job.jobId}:call`, name: 'read', input: { id: 'document' } })
      assert.deepEqual(result.sources, sources, 'adapter receives newly read evidence for next-send admission')
      assert.equal(result.callId, `${job.jobId}:call`)
      return { state: 'completed', text: result.content }
    },
  }
  const result = await model.run({ jobId: 'job-1', purpose: 'dream', input: '整理', sources: [],
    tools: [{ name: 'read', description: 'Read authorized memory', schema: { type: 'object' } }] }, {
    signal: new AbortController().signal,
    executeTool: async invocation => {
      calls.push(invocation.callId)
      assert.deepEqual(invocation.input, { id: 'document' })
      return { callId: invocation.callId, state: 'completed', content: '原文', sources }
    },
  })
  assert.deepEqual(calls, ['job-1:call'])
  assert.deepEqual(result, { state: 'completed', text: '原文' })
})

test('normalized source events retain scope, canonical occurrence and revision across edits', () => {
  const source = { namespace: 'host', sourceId: 'canonical', occurrenceId: 'fork-copy', revision: 3 }
  const event = memoryConversationEvent.parse({ kind: 'revised', eventId: 'edit', cursor: 'cursor', threadId: 'fork', sessionId: 'dsh-session',
    projectId: 'project', scope: { kind: 'project', id: 'project' }, at: 123,
    source, previousRevision: 2, role: 'user', origin: 'original', text: '更正原文', dependencies: [] })
  assert.ok(event.kind === 'revised')
  assert.deepEqual(event.source, source)
  assert.equal(event.previousRevision, 2)
  assert.equal(event.scope.kind, 'project')
})

test('service and client reject a valid receipt for another operation', async () => {
  const wrongId = '2417b19d-a65b-454b-95ad-00d90bccd3a3'
  const f = fixture()
  await f.client.connect()
  f.execute(() => ({ operationId: wrongId, state: 'completed' }))
  await assert.rejects(f.client.call('getOperation', { operationId }), failure('unavailable', 'invalid-service-result'))
  const client = createMemoryClient({ requestId: () => 'req', transport: async raw => {
    assert.ok(raw && typeof raw === 'object' && 'method' in raw)
    return { requestId: 'req', instanceEpoch: 'owner', ok: true, result: raw.method === 'connect'
      ? { protocol: MEMORY_SERVICE_PROTOCOL, instanceEpoch: 'owner', state: 'ready', capabilities: ['getOperation'] }
      : { operationId: wrongId, state: 'completed' } }
  } })
  await client.connect()
  await assert.rejects(client.call('getOperation', { operationId }), failure('unavailable', 'invalid-service-response'))
})
