import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryChannel, MemoryComputeError } from '../src/backend/memory-channel.ts'
import { createMemoryDispatch, MemoryDispatchConflict } from '../src/backend/memory-dispatch.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'
import { MEMORY_CONTRACT } from '../src/shared/memory-contract.ts'
import type { MemoryCompute } from '../src/shared/memory-contract.ts'

test('fact versions and raw sources invalidate just the sessions that used them, including forks', () => {
  const store = openMemoryStore(':memory:')
  try {
    let revision = 1
    let sourceAllowed = true
    const open = () => createMemoryDispatch(store, items => items.every(item => item.asOf || item.revision === revision), () => sourceAllowed)
    const dispatch = open()
    dispatch.record('main', [{ id: 1, revision: 1 }])
    dispatch.record('historical', [{ id: 1, revision: 1, asOf: '2026-01-15' }])
    dispatch.recordSource('raw', 'source')
    dispatch.inherit('main', 'fork')
    dispatch.inherit('raw', 'derived')

    revision = 2
    const resumed = open()
    assert.equal(resumed.stale('main'), true)
    assert.equal(resumed.stale('fork'), true)
    assert.equal(resumed.stale('historical'), false)
    assert.equal(resumed.stale('unrelated'), false)
    assert.equal(resumed.stale('derived'), false)
    sourceAllowed = false
    assert.equal(resumed.stale('raw'), true)
    assert.equal(resumed.stale('derived'), true)
    assert.equal(resumed.stale('unrelated'), false)
  } finally {
    store.close()
  }
})

test('a dispatch holds the commit barrier through dispatch and an abandoned grant releases it', async () => {
  const store = openMemoryStore(':memory:')
  try {
    const dispatch = createMemoryDispatch(store, () => true, () => true)
    const responses: object[] = []
    let allow!: () => void
    const unblocked = new Promise<void>(resolve => { allow = resolve })
    const channel = createMemoryChannel({
      send: response => responses.push(response),
      beginDispatch: async id => {
        if (id === 'cancelled') await unblocked
        dispatch.acquire(id)
        return true
      },
      endDispatch: dispatch.release,
    })
    channel.receive({ type: 'memory_dispatch', id: 'sent', session: 'main' })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(responses, [{ type: 'memory_dispatch_result', id: 'sent', allowed: true }])
    assert.equal(dispatch.canCommit(), false)
    const idle = dispatch.whenIdle()
    channel.receive({ type: 'memory_dispatched', id: 'sent' })
    await idle
    assert.equal(dispatch.canCommit(), true)

    channel.receive({ type: 'memory_dispatch', id: 'cancelled', session: 'main' })
    await new Promise<void>(resolve => setImmediate(resolve))
    channel.receive({ type: 'memory_dispatched', id: 'cancelled' })
    allow()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(responses.at(-1), { type: 'memory_dispatch_result', id: 'cancelled', allowed: false })
    assert.equal(dispatch.canCommit(), true)
  } finally {
    store.close()
  }
})

test('a clarification choice is scoped to its live turn even across forks and process restart', () => {
  const store = openMemoryStore(':memory:')
  try {
    const open = () => createMemoryDispatch(store, () => true, () => true)
    const dispatch = open()
    dispatch.recordTurnOnly('current')
    dispatch.inherit('current', 'fork')
    assert.equal(dispatch.stale('current'), false)
    assert.equal(dispatch.stale('fork'), true)
    assert.equal(dispatch.stale('unrelated'), false)
    assert.equal(open().stale('current'), true)
    dispatch.endTurn('current')
    assert.equal(dispatch.stale('current'), true)

    dispatch.recordTurnOnly('reset')
    dispatch.resetLive()
    assert.equal(dispatch.stale('reset'), true)
    assert.equal(dispatch.stale('unrelated'), false)
  } finally {
    store.close()
  }
})

test('a prospective commit waits only for requests that would carry affected facts', async () => {
  const store = openMemoryStore(':memory:')
  try {
    let revision = 1
    const dispatch = createMemoryDispatch(store, items => items.every(item => item.revision === revision), () => true)
    dispatch.record('affected', [{ id: 1, revision }])
    const affected = dispatch.admission('affected')
    const unrelated = dispatch.admission('unrelated')
    assert.ok(affected.allowed && unrelated.allowed)
    dispatch.acquireSession('slow-unrelated', 'unrelated', unrelated, () => true)
    dispatch.acquireSession('affected', 'affected', affected, () => true)
    revision = 2
    assert.throws(dispatch.validateCommit, error => error instanceof MemoryDispatchConflict && error.requests.join() === 'affected')
    const safe = dispatch.whenIdle(['affected'])
    dispatch.release('affected')
    await safe
    assert.doesNotThrow(dispatch.validateCommit)
    assert.equal(dispatch.canCommit(), false)
  } finally { store.close() }
})

test('model computations need a pending current attempt and late results cannot complete its retry', async () => {
  const responses: object[] = []
  const first: MemoryCompute = {
    id: '326d5372-b964-442b-a7bc-2df3549daebd', sourceId: 'c2082072-021a-4a55-a60f-9a2a65df5b34',
    stage: 'review', generation: 1, provider: 'deepseek', model: 'test', system: 'review', input: '{}',
  }
  const second = { ...first, id: '3e33322c-9296-4776-8bf6-bd8637b57388' }
  const channel = createMemoryChannel({
    send: response => responses.push(response), handle: () => '', timeoutMs: 20,
    beginJobDispatch: (_id, jobId) => jobId === second.id,
  })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  channel.receive({ type: 'memory_ready', version: MEMORY_CONTRACT })
  const keepAlive = setInterval(() => {}, 100)
  try {
    const timedOut = channel.compute(first)
    assert.ok(timedOut)
    assert.equal(channel.compute(first), null)
    await assert.rejects(timedOut, /did not finish/)
    const retried = channel.compute(second)
    assert.ok(retried)
    let completed = false
    void retried.then(() => { completed = true }, () => {})
    channel.receive({ type: 'memory_dispatch', id: 'old', jobId: first.id })
    channel.receive({ type: 'memory_dispatch', id: 'current', jobId: second.id })
    channel.receive({ type: 'memory_computed', id: first.id, generation: second.generation, text: 'late' })
    channel.receive({ type: 'memory_computed', id: second.id, generation: second.generation + 1, text: 'wrong generation' })
    await tick()
    assert.equal(completed, false)
    assert.deepEqual(responses.slice(-2), [
      { type: 'memory_dispatch_result', id: 'old', allowed: false },
      { type: 'memory_dispatch_result', id: 'current', allowed: true },
    ])
    channel.receive({ type: 'memory_computed', id: second.id, generation: second.generation, text: 'verified' })
    assert.equal(await retried, 'verified')
  } finally {
    channel.close()
    channel.processExited()
    clearInterval(keepAlive)
  }
})

test('memory computation preserves only recognized failure codes from the matching model reply', async () => {
  const channel = createMemoryChannel({ send() {}, handle: () => '' })
  channel.receive({ type: 'memory_ready', version: MEMORY_CONTRACT })
  const job: MemoryCompute = { id: 'extract-attempt', sourceId: 'source-id', stage: 'extract', generation: 2,
    provider: 'fake', model: 'fake', system: 'extract', input: '{}' }
  try {
    for (const [failure, expected] of [['max-tokens', 'max-tokens'], ['arbitrary provider text', 'missing-reply']]) {
      const result = channel.compute(job)
      assert.ok(result)
      channel.receive({ type: 'memory_computed', id: job.id, generation: job.generation, failure })
      await assert.rejects(result, error => error instanceof MemoryComputeError && error.reason === expected
        && error.message === 'memory model computation did not finish')
    }
  } finally {
    channel.close()
  }
})

test('aborting a question review cancels the matching DSH calculation and rejects later grants', async () => {
  const sent: object[] = []
  const channel = createMemoryChannel({ send: message => sent.push(message), handle: () => '', beginJobDispatch: () => true })
  channel.receive({ type: 'memory_ready', version: MEMORY_CONTRACT })
  const job: MemoryCompute = { id: 'review-attempt', sourceId: 'source-id', stage: 'question', generation: 2,
    provider: 'fake', model: 'fake', system: 'verify', input: '{}' }
  const controller = new AbortController()
  const result = channel.compute(job, controller.signal)
  assert.ok(result)
  controller.abort()
  await assert.rejects(result, /did not finish/)
  assert.deepEqual(sent.at(-1), { type: 'memory_compute_cancel', id: job.id, generation: 2 })
  channel.receive({ type: 'memory_dispatch', id: 'late', jobId: job.id })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(sent.at(-1), { type: 'memory_dispatch_result', id: 'late', allowed: false })
  channel.close()
})

test('cancelling an asynchronous memory query aborts it and discards any late reply', async () => {
  const request = { op: 'recall', query: 'Latest report', session: 'main' }
  const responses: object[] = []
  const signals: AbortSignal[] = []
  const resolveReply: Array<(text: string) => void> = []
  const channel = createMemoryChannel({
    send: response => responses.push(response),
    handle: (_request, _parent, signal) => {
      signals.push(signal)
      return new Promise<string>(resolve => { resolveReply.push(resolve) })
    },
  })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))

  channel.receive({ type: 'memory_query', id: 'recall', request })
  channel.receive({ type: 'memory_query', id: 'recall', request })
  assert.equal(signals.length, 1)
  channel.receive({ type: 'memory_query_cancel', id: 'recall' })
  assert.equal(signals[0].aborted, true)
  channel.receive({ type: 'memory_query', id: 'recall', request })
  assert.equal(signals.length, 2)
  resolveReply[0]('stale proof')
  await tick()
  assert.deepEqual(responses, [])
  assert.equal(signals[1].aborted, false)
  resolveReply[1]('fresh proof')
  await tick()
  assert.deepEqual(responses, [{ type: 'memory_response', id: 'recall', text: 'fresh proof' }])

  channel.receive({ type: 'memory_query', id: 'closing', request })
  channel.close()
  assert.equal(signals[2].aborted, true)
  resolveReply[2]('closed channel')
  await tick()
  assert.equal(responses.length, 1)
})
