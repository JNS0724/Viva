import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import { createAcpOperations } from '../src/backend/acp-operations.ts'
import { createAssistantStream } from '../src/backend/assistant-stream.ts'
import { STOP_GRACE_MS } from '../src/backend/stop-in-time.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const fail = (value: unknown) => assert.fail(String(value))
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const prompt = [{ type: 'text' as const, text: 'work' }]

test('cancel deadline revokes one operation, and its late response/finally cannot end a newer operation of the same session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = deferred<PromptResponse>(), second = deferred<PromptResponse>(), ended: string[] = [], cancelled: string[] = []
  let requested = 0, forced = 0
  const streams = createAssistantStream({ send: () => {}, emit: () => {} })
  const operations = createAcpOperations({
    streams, connection: () => ({ prompt: () => (++requested === 1 ? first.promise : second.promise), cancel: () => new Promise(() => {}) }),
    cancelPermissions: id => { cancelled.push(id) }, streamUpdate: () => {},
  })
  const old = operations.run({ sessionId: 'same', prompt, context: { conversationId: 'old', sessionId: 'same' }, onEnd: () => { ended.push('old') }, onError: fail })
  await flush(); await operations.cancelInTime('same', () => { forced++ })
  t.mock.timers.tick(STOP_GRACE_MS); assert.equal(forced, 1); assert.equal(operations.isReleased('same'), true)
  const next = operations.run({ sessionId: 'same', prompt, context: { conversationId: 'new', sessionId: 'same' }, onEnd: () => { ended.push('new') }, onError: fail })
  await flush(); first.resolve({ stopReason: 'end_turn' }); await old
  assert.equal(operations.has('same'), true)
  assert.deepEqual(operations.context('same'), { conversationId: 'new', sessionId: 'same' })
  t.mock.timers.tick(STOP_GRACE_MS); assert.equal(forced, 1)
  second.resolve({ stopReason: 'end_turn' }); await next
  assert.deepEqual(ended, ['new']); assert.deepEqual(cancelled, ['same'])
  assert.equal(operations.has('same'), false)
  operations.dispose()
})

test('disposal while stream binding waits cannot send a late native prompt or reopen the operation book', async () => {
  const binding = deferred<void>(), base = createAssistantStream({ send: () => {}, emit: () => {} })
  let calls = 0
  const operations = createAcpOperations({
    streams: { ...base, begin: async id => { const operation = await base.begin(id); await binding.promise; return operation } },
    connection: () => ({ prompt: async () => { calls++; return { stopReason: 'end_turn' } }, cancel: async () => {} }),
    cancelPermissions: () => {}, streamUpdate: () => {},
  })
  const run = () => operations.run({ sessionId: 's', prompt, onEnd: fail, onError: fail })
  const pending = run(); await flush(); operations.dispose(); binding.resolve(); await pending; await run()
  assert.equal(calls, 0); assert.equal(operations.has('s'), false)
})

test('captured context cannot be changed by the caller or a reader, and completed operations reject unowned stream updates', async () => {
  const result = deferred<PromptResponse>(), events: unknown[] = [], context = { conversationId: 'original', sessionId: 's' }
  const streams = createAssistantStream({ send: () => {}, emit: () => {} })
  const operations = createAcpOperations({
    streams, connection: () => ({ prompt: () => result.promise, cancel: async () => {} }), cancelPermissions: () => {},
    streamUpdate: (_id, _update, captured) => { events.push(captured) },
  })
  const pending = operations.run({ sessionId: 's', prompt, context, onEnd: () => {}, onError: fail })
  await flush(); context.conversationId = 'changed'; operations.context('s')!.conversationId = 'also changed'
  operations.forwardStream('s', { chunk: 'x' }); result.resolve({ stopReason: 'end_turn' }); await pending
  operations.forwardStream('s', { chunk: 'late' })
  assert.deepEqual(events, [{ conversationId: 'original', sessionId: 's' }])
  operations.dispose()
})

test('cancelled preparation cannot start a late prompt or release a newer operation', async () => {
  const binding = deferred<void>(), result = deferred<PromptResponse>()
  const streams = createAssistantStream({ send: () => {}, emit: () => {} })
  let prompted = 0, cancelled = 0, finished = 0
  const operations = createAcpOperations({ streams, cancelPermissions: () => {}, streamUpdate: () => {},
    connection: () => ({ prompt: () => { prompted++; return result.promise }, cancel: async () => {} }) })
  const first = operations.run({ sessionId: 'session', prompt, prepare: () => binding.promise, onEnd: fail, onError: fail })
  assert.equal(operations.has('session'), true)
  assert.equal(operations.cancelPreparing('session', () => { cancelled++ }), true)
  const next = operations.run({ sessionId: 'session', prompt, onEnd: () => { finished++ }, onError: fail })
  await flush()
  binding.resolve(); await first
  assert.equal(prompted, 1, 'only the new request may prompt')
  assert.equal(operations.has('session'), true)
  assert.equal(cancelled, 1)
  result.resolve({ stopReason: 'end_turn' }); await next
  assert.equal(finished, 1)
})

test('a prompt failure still settles once when gated output recovery fails too', async () => {
  const failure = new Error('Native prompt failed')
  const errors: unknown[] = []
  const streams = createAssistantStream({ send: () => {}, emit: () => {}, allowAcpFallback: false })
  const operations = createAcpOperations({ streams, cancelPermissions: () => {}, streamUpdate: () => {},
    connection: () => ({ prompt: async () => { throw failure }, cancel: async () => {} }) })
  await operations.run({ sessionId: 'session', prompt, onEnd: fail, onError: error => errors.push(error) })
  assert.deepEqual(errors, [failure])
  assert.equal(operations.has('session'), false)
})
