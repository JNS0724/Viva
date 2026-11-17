import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteMemoryChannel, MemoryReadBusy } from '../src/backend/remote-memory-channel.ts'
import { createVivaMemoryClient } from '../src/backend/memory-client.ts'
import { MEMORY_HOST_PROTOCOL, memoryHostRead } from '../src/memory/contracts/host.ts'
import { createRequestBudget, RequestTimeout } from '../src/shared/request-budget.ts'
import { memoryReadContext } from '../src/backend/memory-read-context.ts'
import { backendWith } from './fixtures/backend-wire.ts'
import { t as translate } from '../src/shared/i18n/translate.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { scratch } from './fixtures/scratch.js'
import { MemoryComputeError } from '../src/memory/contracts/compute.ts'

const state = (epoch: string, status = 'ready') => ({ type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch, state: status, revision: 0, coreEpoch: 0 })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function channelFixture() {
  const sent: Array<Record<string, unknown>> = []
  const channel = createRemoteMemoryChannel({ send: message => sent.push(message as Record<string, unknown>) })
  channel.receive(state('owner'))
  const answer = (index: number, result: unknown = index) => channel.receive({ type: 'memory_host_result', requestId: sent[index]!.requestId, epoch: sent[index]!.epoch, ok: true, result })
  return { channel, sent, answer }
}

test('two expired callers retain actual read slots; late terminals settle before a third fresh retry', async t => {
  const f = channelFixture(); t.after(() => f.channel.close())
  const first = f.channel.readBatch(call => call('profile', { args: [] }), { budgetMs: 20 })
  await assert.rejects(first, RequestTimeout)
  const second = f.channel.readBatch(call => call('profile', { args: [] }), { budgetMs: 20 })
  await assert.rejects(second, RequestTimeout)
  assert.deepEqual(f.channel.readState(), { batches: 2, executions: 2 })
  await assert.rejects(f.channel.readBatch(call => call('profile', { args: [] })), MemoryReadBusy)
  assert.equal(f.sent.length, 2, 'busy rejection does not add another owner request')
  f.answer(0, { old: 'must not reach either caller' })
  assert.deepEqual(f.channel.readState(), { batches: 1, executions: 1 })
  const third = f.channel.readBatch(call => call('profile', { args: [] }))
  await tick(); f.answer(2, { current: 'fresh' })
  assert.deepEqual(await third, { current: 'fresh' })
  const ids = f.sent.map(message => message.requestId)
  assert.equal(new Set(ids).size, 3)
  f.answer(1)
  assert.deepEqual(f.channel.readState(), { batches: 0, executions: 0 })
})

test('a five-read page inherits one shrinking deadline and stops dispatching after expiry', async t => {
  const f = channelFixture(); t.after(() => f.channel.close())
  const client = createVivaMemoryClient(f.channel.call, f.channel.readBatch)
  const page = client.readPage(undefined, { budgetMs: 35 })
  const expired = assert.rejects(page, RequestTimeout)
  await tick(); f.answer(0, {})
  await tick()
  assert.deepEqual(f.sent.map(message => message.method), ['profile', 'onboarding'])
  const reads = f.sent.map(message => memoryHostRead.parse(message.read))
  assert.equal(reads[0]!.readBatchId, reads[1]!.readBatchId)
  assert.ok(reads[1]!.budgetMs < reads[0]!.budgetMs)
  await expired
  f.answer(1, 'done'); await tick()
  assert.equal(f.sent.length, 2, 'late completion must not dispatch cleanup/revision/fileProfile')
  assert.deepEqual(f.channel.readState(), { batches: 0, executions: 0 })
})

test('normal concurrent batches, caller cancellation, recovery and owner replacement preserve capacity', async t => {
  const f = channelFixture(); t.after(() => f.channel.close())
  const cancel = new AbortController()
  const first = f.channel.readBatch(call => call('revision', { args: [] }), { signal: cancel.signal })
  const cancelled = assert.rejects(first, /cancelled/)
  const second = f.channel.readBatch(call => call('revision', { args: [] }))
  await tick(); cancel.abort(new Error('cancelled'))
  await cancelled
  f.answer(1, 2); assert.equal(await second, 2)
  assert.deepEqual(f.channel.readState(), { batches: 1, executions: 1 })
  f.channel.receive(state('owner', 'recovering'))
  await assert.rejects(f.channel.readBatch(call => call('revision', { args: [] })), /unavailable/)
  assert.deepEqual(f.channel.readState(), { batches: 1, executions: 1 }, 'recovery alone does not settle executions')
  f.channel.receive(state('owner', 'unavailable'))
  assert.deepEqual(f.channel.readState(), { batches: 1, executions: 1 }, 'an unavailable status alone does not prove instance exit')
  f.channel.receive(state('replacement'))
  assert.deepEqual(f.channel.readState(), { batches: 0, executions: 0 })
  const third = f.channel.readBatch(call => call('revision', { args: [] }))
  await tick(); f.answer(0, 999)
  assert.deepEqual(f.channel.readState(), { batches: 1, executions: 1 }, 'old owner cannot settle new work')
  f.answer(2, 3); assert.equal(await third, 3)
})

test('a hung required snapshot also has a cancellable HTTP deadline and does not block subsequent channels', async t => {
  const { connection } = await backendWith(t, { 'agent:snapshot': () => new Promise(() => {}), 'agent:info': () => 'ready' })
  await assert.rejects(connection.rpc('agent:snapshot', [{ budgetMs: 20 }]))
  assert.equal(await connection.rpc('agent:info', []), 'ready')
})

test('HTTP memory deadline cancels its backend lifetime while other channels remain usable', async t => {
  let lifetime: ReturnType<typeof createRequestBudget> | undefined
  const { connection } = await backendWith(t, {
    'memory:get': () => { lifetime = memoryReadContext.getStore(); return new Promise(() => {}) },
    'agent:info': () => 'usable',
  })
  await assert.rejects(connection.rpc('memory:get', [{ budgetMs: 40 }]), error => {
    assert.equal((error as Error).message, translate('memory.read.timeout')); return true
  })
  assert.ok(lifetime)
  if (!lifetime.signal.aborted) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend lifetime was not cancelled')), 500)
    lifetime!.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  assert.equal(lifetime.signal.aborted, true)
  assert.equal(await connection.rpc('agent:info', []), 'usable')
})

test('budget cancellation rejects the caller, retains task rejection handling and stops future stages', async () => {
  const budget = createRequestBudget(20)
  let finish!: (value: number) => void
  const pending = budget.run(() => new Promise<number>(resolve => { finish = resolve }))
  await assert.rejects(pending, RequestTimeout)
  finish(1)
  assert.throws(budget.remainingMs, RequestTimeout)
  budget.close()
})

test('dream model waits, repeated retry and persisted recovery never become a dependency of the five page reads', { timeout: 10_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'memory-availability-dream-')
  let entered!: () => void, finish!: () => void
  let running!: Promise<void>
  let dreamCount = 0
  let owner: ReturnType<typeof openMemoryOwner>
  const open = () => openMemoryOwner({ root, dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fixture', model: 'fixture' }), quiesce: async () => {},
    compute: job => {
      if (job.stage === 'note') return Promise.resolve(JSON.stringify({ status: 'write', title: 'Weekly report', markdown: 'The weekly report is due Friday.' }))
      if (job.stage !== 'dream') return null
      dreamCount++
      const lease = owner.acquireSend(randomUUID(), { jobId: job.id }, '{}')
      const pending = new Promise<string>((_resolve, reject) => { finish = () => reject(new MemoryComputeError('timeout')) })
      entered()
      return pending.finally(lease.settled)
    },
  })
  owner = open()
  defer(async () => { finish?.(); await running; await owner.close() })
  await owner.recover()
  const source = { sessionId: randomUUID(), messageId: randomUUID(), text: 'The weekly report is due Friday.',
    at: Date.now(), timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false }
  const receipt = await owner.receiveSource(source)
  await owner.completeTurn({ sessionId: source.sessionId, turn: 1, eventSeq: 3, sourceIds: [receipt.sourceId], assistant: 'Noted.', completed: true, at: source.at, timezone: 'UTC' })
  await owner.runtime.wake()
  t.diagnostic('daily note committed')
  const channel = createRemoteMemoryChannel({ send(raw) {
    const message = raw as { method: string, input: unknown, requestId: string, epoch: string }
    const identity = { requestId: message.requestId, epoch: message.epoch }
    void owner.handleHost(message.method, message.input).then(result => channel.receive({ type: 'memory_host_result', ...identity, ok: true, result }),
      () => channel.receive({ type: 'memory_host_result', ...identity, ok: false, error: { code: 'unavailable' } }))
  } })
  defer(() => channel.close())
  const ready = () => channel.receive(state(owner.epoch, owner.status()))
  const client = createVivaMemoryClient(channel.call, channel.readBatch)
  const read = async () => {
    ready()
    const page = await client.readPage(undefined, { budgetMs: 500 })
    assert.equal(page.onboarding, 'pending')
    assert.equal(typeof page.revision, 'number')
    assert.equal(owner.ready(), true)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = new Promise<void>(resolve => { entered = resolve })
    running = owner.runtime.runDocumentDream()
    t.diagnostic(`dream ${attempt + 1} scheduled`)
    await started
    await read()
    finish(); await running
  }
  assert.equal(dreamCount, 2)
  await owner.close()
  // Make the durable failed job due before reopen, without changing its generation or payload.
  const db = new DatabaseSync(path.join(root, 'memory.db'))
  db.prepare("UPDATE effects SET due_at=0 WHERE kind='memory.dream'").run(); db.close()
  const resumed = new Promise<void>(resolve => { entered = resolve })
  owner = open()
  const recoveryBudget = createRequestBudget(500)
  try { await recoveryBudget.run(() => owner.recover()) } finally { recoveryBudget.close() }
  running = owner.runtime.wake()
  await resumed
  await read()
  assert.equal(dreamCount, 3, 'the persisted retry resumes independently of management reads')
  finish(); await running
})
