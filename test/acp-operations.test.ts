import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import { createAcpOperations } from '../src/backend/acp-operations.ts'
import { createAssistantStream } from '../src/backend/assistant-stream.ts'
import { STOP_GRACE_MS } from '../src/backend/stop-in-time.ts'
import { installDiagnosticPort } from '../src/diagnostics/node/context.ts'
import type { DiagnosticEvent } from '../src/diagnostics/contracts.ts'
import { recordingDiagnosticPort } from './fixtures/diagnostic-port.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const fail = (value: unknown) => assert.fail(String(value))
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const prompt = [{ type: 'text' as const, text: 'work' }]
/** The app's side of the stream, its plugin side confirming every bind and flush with nothing shown. */
function confirmedStreams() {
  const streams = createAssistantStream({ emit: () => {}, send: message => {
    const { type, operation } = message as { type: string, operation: string }
    if (type === 'assistant_stream_bind') streams.receive({ type: 'assistant_stream_bound', version: 1, operation })
    if (type === 'assistant_stream_flush') streams.receive({ type: 'assistant_stream_flushed', version: 1, operation, messages: [], finalReply: false })
  } })
  streams.receive({ type: 'assistant_stream_ready', version: 1 })
  return streams
}

test('cancel deadline revokes one operation, and its late response/finally cannot end a newer operation of the same session', async t => {
  const events: DiagnosticEvent[] = []
  t.after(installDiagnosticPort(recordingDiagnosticPort(event => { events.push(event); return undefined })))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = deferred<PromptResponse>(), second = deferred<PromptResponse>(), ended: string[] = [], cancelled: string[] = []
  let requested = 0, forced = 0
  const streams = confirmedStreams()
  const operations = createAcpOperations({
    streams, connection: () => ({ prompt: () => (++requested === 1 ? first.promise : second.promise), cancel: () => new Promise(() => {}) }),
    cancelPermissions: id => { cancelled.push(id) }, streamUpdate: () => {},
  })
  const old = operations.run({ sessionId: 'same', prompt, context: { conversationId: 'old', sessionId: 'same' }, onEnd: () => { ended.push('old') }, onError: fail })
  await flush(); await operations.cancelInTime('same', () => { forced++ })
  t.mock.timers.tick(STOP_GRACE_MS); assert.equal(forced, 1); assert.equal(operations.isReleased('same'), true)
  assert.equal(events.filter(event => event.operation === 'conversation.send' && event.event === 'operation.end').length, 0,
    'a forced UI cancellation is not actual prompt settlement')
  const next = operations.run({ sessionId: 'same', prompt, context: { conversationId: 'new', sessionId: 'same' }, onEnd: () => { ended.push('new') }, onError: fail })
  await flush(); first.resolve({ stopReason: 'end_turn' }); await old
  assert.ok(events.some(event => event.operation === 'conversation.send' && event.outcome === 'late_completed'))
  assert.equal(operations.has('same'), true)
  assert.deepEqual(operations.context('same'), { conversationId: 'new', sessionId: 'same' })
  t.mock.timers.tick(STOP_GRACE_MS); assert.equal(forced, 1)
  second.resolve({ stopReason: 'end_turn' }); await next
  assert.deepEqual(ended, ['new']); assert.deepEqual(cancelled, ['same'])
  assert.equal(operations.has('same'), false)
  operations.dispose()
})

test('prompt diagnostics record only the first response and preserve updates, results and errors with a broken sink', async t => {
  const events: DiagnosticEvent[] = []
  const restore = installDiagnosticPort(recordingDiagnosticPort(event => { events.push(event); return undefined }))
  t.after(restore)
  const result = deferred<PromptResponse>(), updates: unknown[] = [], errors: unknown[] = []
  let streamId = '', recover = false
  const streams = createAssistantStream({
    emit: (id, update) => operations.forwardStream(id, update),
    send(message) {
      const { type, operation } = message as { type: string, operation: string }
      if (type === 'assistant_stream_bind') {
        streamId = operation
        streams.receive({ type: 'assistant_stream_bound', version: 1, operation })
      }
      if (type === 'assistant_stream_flush') {
        const messages = recover ? [{ key: 'recovered', blocks: [{ type: 'text', text: 'SECRET_RECOVERY' }] }] : []
        streams.receive({ type: 'assistant_stream_flushed', version: 1, operation, messages, finalReply: recover })
      }
    },
  })
  streams.receive({ type: 'assistant_stream_ready', version: 1 })
  const frame = (kind: string, extra: object = {}) => streams.receive({ type: 'assistant_stream', version: 1,
    sessionId: 's', operation: streamId, key: 'assistant', kind, ...extra })
  const failure = new Error('SECRET_NATIVE_ERROR')
  let nextFails = false
  const operations = createAcpOperations({ streams, cancelPermissions: () => {}, streamUpdate: (_id, update) => updates.push(update),
    connection: () => ({ prompt: () => nextFails ? Promise.reject(failure) : result.promise, cancel: async () => {} }) })
  t.after(() => operations.dispose())
  let ended = 0
  const run = () => operations.run({ sessionId: 's', prompt: [{ type: 'text', text: 'SECRET_PROMPT_BODY' }], onEnd: () => { ended++ }, onError: error => errors.push(error) })
  const pending = run(); await flush()
  const strange = Object.defineProperty({}, 'sessionUpdate', { get() { throw new Error('diagnostic getter must never run') } })
  operations.forwardStream('s', strange)
  assert.equal(streams.suppress('s', { sessionUpdate: 'agent_message_chunk' }), true)
  frame('start')
  frame('delta', { index: 0, blockType: 'text', text: '' })
  frame('delta', { index: 0, blockType: 'tool', text: 'SECRET_TOOL_BODY' })
  assert.equal(events.filter(event => event.stage === 'first-response').length, 0)
  frame('delta', { index: 0, blockType: 'reasoning', text: 'SECRET_THOUGHT' })
  assert.equal(events.filter(event => event.stage === 'first-response').length, 1)
  for (let index = 0; index < 500; index++) frame('delta', { index: 1, blockType: 'text', text: 'SECRET_OUTPUT_BODY' })
  result.resolve({ stopReason: 'end_turn' }); await pending
  assert.equal(updates.length, 504)
  assert.equal(ended, 1)
  assert.equal(events.filter(event => event.stage === 'first-response').length, 1)
  assert.ok(events.length < 10)
  recover = true
  await run()
  assert.equal(events.filter(event => event.stage === 'first-response').length, 2, 'a turn may first show committed output during stream recovery')
  assert.doesNotMatch(JSON.stringify(events), /SECRET_/)
  restore()
  const broken = installDiagnosticPort({ emit() { throw new Error('broken sink') } })
  try {
    nextFails = true
    await run()
    assert.deepEqual(errors, [failure])
    assert.equal(operations.has('s'), false)
  } finally { broken() }
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
  const streams = confirmedStreams()
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

test('cancelled preparation cannot start a late prompt or release a newer operation', async t => {
  const events: DiagnosticEvent[] = []
  t.after(installDiagnosticPort(recordingDiagnosticPort(e => { events.push(e); return undefined })))
  const binding = deferred<void>(), result = deferred<PromptResponse>()
  const streams = confirmedStreams()
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
  assert.deepEqual(events.filter(e => e.event === 'operation.end').map(e => e.outcome), ['cancelled'])
  result.resolve({ stopReason: 'end_turn' }); await next
  assert.equal(finished, 1)
})

test('a prompt failure still settles once when gated output recovery fails too', async () => {
  const failure = new Error('Native prompt failed')
  const errors: unknown[] = []
  const streams = createAssistantStream({ send: () => {}, emit: () => {} })
  const operations = createAcpOperations({ streams, cancelPermissions: () => {}, streamUpdate: () => {},
    connection: () => ({ prompt: async () => { throw failure }, cancel: async () => {} }) })
  await operations.run({ sessionId: 'session', prompt, onEnd: fail, onError: error => errors.push(error) })
  assert.deepEqual(errors, [failure])
  assert.equal(operations.has('session'), false)
})



test('native cancellation and revoked unsent admission each settle once as cancelled', async t => {
  const events: DiagnosticEvent[] = []
  t.after(installDiagnosticPort(recordingDiagnosticPort(event => { events.push(event); return undefined })))
  let sends = 0
  const operations = createAcpOperations({ streams: confirmedStreams(), cancelPermissions() {}, streamUpdate() {},
    connection: () => ({ prompt: async () => { sends++; return { stopReason: 'cancelled' } }, cancel: async () => {} }) })
  t.after(() => operations.dispose())
  for (const held of [false, true]) {
    const results: string[] = []
    await operations.run({ sessionId: 's', prompt, held: () => held, onEnd: r => results.push(r.stopReason), onError: fail })
    assert.deepEqual(results, ['cancelled'])
  }
  assert.equal(sends, 1)
  assert.deepEqual(events.filter(e => e.event === 'operation.end').map(e => e.outcome), ['cancelled', 'cancelled'])
})
