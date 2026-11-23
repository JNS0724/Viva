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
import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { scratch } from './fixtures/scratch.js'
import type { HostMemoryApi, HostMemoryMethod } from '../src/memory/contracts/host.ts'
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

test('the profile page has one owner round trip and discards a reply after its deadline', async t => {
  const f = channelFixture(); t.after(() => f.channel.close())
  const client = createVivaMemoryClient(f.channel.call, f.channel.readBatch)
  const project = { kind: 'project' as const, id: 'current' }
  const page = client.readPage(project, { budgetMs: 35 })
  const expired = assert.rejects(page, RequestTimeout)
  await tick()
  assert.deepEqual(f.sent.map(message => [message.method, message.input]), [['profilePage', { args: [project] }]])
  assert.ok(memoryHostRead.parse(f.sent[0]!.read).budgetMs <= 35)
  await expired
  f.answer(0)
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

test('dream model waits, repeated retry and persisted recovery never become a dependency of a profile or foreground query', { timeout: 10_000 }, async t => {
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
    const list = await client.listFiles({ query: 'weekly' })
    assert.ok(list.items.length > 0)
    const recall = await owner.runtime.handleModelRequest({ op: 'recall', session: source.sessionId, query: 'weekly report' },
      owner.sessionContext(source.sessionId), () => owner.ready())
    assert.ok(JSON.parse(recall).notes.length > 0)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = new Promise<void>(resolve => { entered = resolve })
    running = owner.runtime.runDocumentDream()
    t.diagnostic(`dream ${attempt + 1} scheduled`)
    await started
    await read()
    t.diagnostic(`read ${attempt + 1} completed`)
    finish(); await running
    t.diagnostic(`dream ${attempt + 1} completed`)
  }
  assert.equal(dreamCount, 2)
  await owner.close()
  t.diagnostic('initial owner closed')
  // Make the durable failed job due before reopen, without changing its generation or payload.
  const db = new DatabaseSync(path.join(root, 'memory.db'))
  assert.equal(db.prepare("UPDATE effects SET due_at=0 WHERE kind='memory.dream'").run().changes, 1); db.close()
  const resumed = new Promise<void>(resolve => { entered = resolve })
  owner = open()
  t.diagnostic('replacement owner opened')
  const recoveryBudget = createRequestBudget(500)
  try { await recoveryBudget.run(() => owner.recover()) } finally { recoveryBudget.close() }
  t.diagnostic('replacement owner recovered')
  running = owner.runtime.wake()
  const resumedBudget = createRequestBudget(1000)
  try { await resumedBudget.run(() => resumed) } finally { resumedBudget.close() }
  t.diagnostic('replacement dream started')
  await read()
  t.diagnostic('replacement read completed')
  assert.equal(dreamCount, 3, 'the persisted retry resumes independently of management reads')
  finish(); await running
  t.diagnostic('replacement dream completed')
})


test('the file detail request preserves its optional restriction and cancels backend work on deadline', async t => {
  const identity = { workspace: 'workspace', kind: 'digest', id: 'file' }
  let input: unknown, lifetime: ReturnType<typeof createRequestBudget> | undefined
  const { connection } = await backendWith(t, {
    'memory:read-file': (_event, target, restriction) => {
      input = [target, restriction]
      lifetime = memoryReadContext.getStore()
      return new Promise(() => {})
    },
  })
  await assert.rejects(connection.rpc('memory:read-file', [identity, undefined, { budgetMs: 40 }]), {
    message: translate('memory.read.timeout'),
  })
  assert.deepEqual(input, [identity, undefined])
  assert.ok(lifetime)
  if (!lifetime.signal.aborted) await new Promise<void>(resolve => lifetime!.signal.addEventListener('abort', () => resolve(), { once: true }))
  assert.ok(lifetime.signal.aborted)
})

test('a direct desktop transport retains read capacity through cancellation until the owner physically settles', async () => {
  const pending: Array<{ signal?: AbortSignal, settle(): void }> = []
  const channel = createRemoteMemoryChannel({ callOwner: (_method, _input, options) => new Promise((_resolve, reject) => {
    assert.equal(options.waitForCompletion, true)
    pending.push({ signal: options.signal, settle: () => reject(new RequestTimeout()) })
  }) })
  try {
    channel.receive(state('direct'))
    const page = () => channel.readBatch(read => read('listFiles', { args: [{}] }), { budgetMs: 25 })
    await assert.rejects(page(), RequestTimeout)
    await assert.rejects(page(), RequestTimeout)
    assert.ok(pending.every(call => call.signal?.aborted))
    assert.deepEqual(channel.readState(), { batches: 2, executions: 2 })
    await assert.rejects(page(), MemoryReadBusy)
    pending.forEach(call => call.settle())
    await tick()
    assert.deepEqual(channel.readState(), { batches: 0, executions: 0 })
  } finally { channel.close() }
})

test('a Dream provider grant and a late result each verify the current daily file while independent reads stay available', { timeout: 10_000 }, async t => {
  const { dir: root, defer } = scratch(t, 'dream-send-verification-')
  let report!: (id: string) => void, finish!: (result: string) => void
  const requested = new Promise<string>(resolve => { report = resolve })
  const provider = new Promise<string>(resolve => { finish = resolve })
  const owner = openMemoryOwner({ root, dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'fixture', model: 'fixture' }), quiesce: async () => {},
    compute: job => {
      if (job.stage === 'note') return Promise.resolve('{"status":"write","title":"Friday","markdown":"The report is due Friday."}')
      if (job.stage !== 'dream') return null
      report(job.id)
      return provider
    },
  })
  defer(() => owner.close())
  await owner.recover()
  const client = createVivaMemoryClient(<M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) =>
    owner.handleHost(method, input) as Promise<HostMemoryApi[M]['output']>)
  const independent = await client.createFile({ operationId: randomUUID(), text: 'Independently available memory' })
  const session = randomUUID(), at = Date.now()
  const received = await owner.receiveSource({ sessionId: session, messageId: randomUUID(), text: 'The report is due Friday.', at,
    timezone: 'UTC', turn: 1, step: 1, admitted: true, inherited: false })
  await owner.completeTurn({ sessionId: session, turn: 1, eventSeq: 3, sourceIds: [received.sourceId], assistant: 'Understood.', completed: true, at, timezone: 'UTC' })
  await owner.runtime.wake()
  const daily = (await client.listFiles({ kind: 'daily' })).items[0]!
  // Match owner-lock.ts (realpathSync) so Windows 8.3 temp aliases compare equal against createMemoryPhysicalFileReader's lstat path.
  const file = path.resolve(realpathSync(root), 'memory-files', daily.identity.workspace, ...daily.path.split('/'))
  const work = owner.runtime.runDocumentDream()
  const origin = { jobId: await requested }, signal = new AbortController().signal
  let permit: ReturnType<typeof owner.acquireSend> | undefined
  let release: (() => void) | undefined
  let mocked: { mock: { restore: () => void } } | undefined
  let settled = false
  const settlePermit = () => { if (!settled && permit) { settled = true; permit.settled() } }
  // Registered after owner.close() so LIFO cleanup releases permits and dream waiters before fence.close() drains.
  defer(() => {
    release?.()
    mocked?.mock.restore()
    syncBuiltinESMExports()
    settlePermit()
    finish('{"units":[]}')
  })
  permit = owner.acquireSend(randomUUID(), origin, 'provider attempt', await owner.loadOutputProof(origin, signal))
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const original = fs.lstat
  mocked = t.mock.method(fs, 'lstat', async (...args: Parameters<typeof original>) => {
    if (path.resolve(String(args[0])) === file) { entered(); await gate }
    return original(...args)
  })
  syncBuiltinESMExports()
  try {
    const denied = assert.rejects(owner.loadOutputProof(origin, signal), /timed out/)
    await Promise.race([blocked, denied])
    assert.match((await client.readFile(independent.identity))!.markdown, /Independently available memory/)
    await denied
  } finally {
    release?.()
    mocked.mock.restore()
    syncBuiltinESMExports()
    settlePermit()
  }
  await fs.writeFile(file, 'External edit after the admitted model request')
  const proof = await owner.loadOutputProof(origin, signal)
  assert.equal(owner.outputCurrent(origin, proof), false)
  finish('{"units":[]}')
  await work
  assert.equal(owner.runtime.dreamStatus().lastProcessedAt, null)
})
