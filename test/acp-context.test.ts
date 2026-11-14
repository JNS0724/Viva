import { decodeAgentEvent } from '../src/renderer/agent-event-decoder.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import { AgentSideConnection, ndJsonStream, type Agent } from '@agentclientprotocol/sdk'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { createConversationSession } from '../src/backend/conversation-session.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createConversationIngress } from '../src/renderer/conversation-ingress.ts'
import { createEventActions, type EventEnvelope } from '../src/renderer/agent-event-actions.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { testRequests, withPluginSide } from './fixtures/request-routing.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('a routing bind arriving after its session retires cannot prompt the closed session', { timeout: 5000 }, async () => {
  const input = new PassThrough(), output = new PassThrough(), entered = deferred(), retired = deferred()
  const calls: string[] = []
  let serial = 0, binding: { id: string } | undefined
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: new PassThrough(), exitCode: null as number | null,
    signalCode: null, connected: true, kill: () => true,
    send: (message: { type: string, id: string }) => { if (message.type === 'routing_bind') { binding = message; entered.resolve() } } })
  new AgentSideConnection(() => ({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }), authenticate: () => ({}),
    newSession: () => ({ sessionId: `session-${++serial}` }), cancel: () => {},
    closeSession: params => { calls.push(`close:${params.sessionId}`); retired.resolve(); return {} },
    prompt: params => { calls.push(`prompt:${params.sessionId}`); return { stopReason: 'end_turn' } },
  } satisfies Agent), ndJsonStream(Writable.toWeb(output), Readable.toWeb(input) as ReadableStream<Uint8Array>))
  const bridge = createAcpBridge({ routing: testRequests(), dshBin: '/fixture/dsh', profile: 'viva', cwd: process.cwd(), env: {},
    spawnFn: (() => child as unknown as ChildProcess) as typeof spawn, emit: () => {} })
  try {
    await bridge.start()
    const pending = bridge.prompt('Analyze the repository')
    await entered.promise
    await bridge.newSession()
    await retired.promise
    child.emit('message', { type: 'routing_bound', version: 1, id: binding!.id })
    await pending
    assert.ok(calls.includes('close:session-1'))
    assert.equal(calls.some(call => call.startsWith('prompt:')), false)
  } finally { child.exitCode = 0; bridge.dispose(); input.destroy(); output.destroy() }
})

for (const failure of [false, true]) test(`foreground ${failure ? 'error' : 'completion'} retains the originating history segment`, async () => {
  const entered = deferred(), finish = deferred()
  const old = { conversationId: 'old', sessionId: 'reused-session' }
  let context = old
  let remote!: AgentSideConnection
  const input = new PassThrough(), output = new PassThrough()
  const child = withPluginSide(Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, kill: () => true }), { says: 'original answer' })
  const events: Array<{ type: string, [field: string]: unknown }> = []
  const stream = ndJsonStream(Writable.toWeb(output), Readable.toWeb(input) as ReadableStream<Uint8Array>)
  new AgentSideConnection(client => {
    remote = client
    return {
      initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
      authenticate: () => ({}), newSession: () => ({ sessionId: old.sessionId }), cancel: () => {},
      async prompt() {
        entered.resolve(); await finish.promise
        await client.sessionUpdate({ sessionId: old.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'original answer' } } })
        if (failure) throw new Error('original prompt failed')
        return { stopReason: 'end_turn' }
      },
    } satisfies Agent
  }, stream)
  const bridge = createAcpBridge({ routing: testRequests(),
    dshBin: '/fixture/dsh', profile: 'viva', cwd: process.cwd(), env: {},
    // Only the stdio/EventEmitter subset of a child process is exercised by this protocol fixture.
    spawnFn: (() => child as unknown as ChildProcess) as typeof spawn,
    conversationContext: () => context, emit: event => { events.push(event) },
  })
  try {
    await bridge.start()
    const asked = bridge.prompt('hello')
    await entered.promise
    context = { conversationId: 'new', sessionId: old.sessionId }
    finish.resolve(); await asked
    const pieces = events.filter(event => event.type === 'update' || event.type === 'turn_end' || event.type === 'error')
    assert.deepEqual(pieces.map(event => event.type), ['update', failure ? 'error' : 'turn_end'])
    assert.deepEqual(pieces.map(event => event.context), [old, old])
    const before = events.length
    await remote.sessionUpdate({ sessionId: old.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unowned late answer' } } })
    // Notifications are written asynchronously; an ACP request acts as an ordering barrier.
    await remote.requestPermission({ sessionId: old.sessionId, toolCall: { toolCallId: 'late', title: 'late' }, options: [] })
    assert.equal(events.length, before)
  } finally {
    child.exitCode = 0
    await bridge.dispose()
    input.end(); output.end()
  }
})

test('a cold MCP reattachment publishes the reconciled context before its next foreground answer', async t => {
  const db = openHistoryDb({ file: ':memory:' }); t.after(() => db.close())
  const input = new PassThrough(), output = new PassThrough()
  const child = withPluginSide(Object.assign(new EventEmitter(), { stdin: input, stdout: output, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, kill: () => true }), { says: 'answer after reload' })
  let serial = 0
  new AgentSideConnection(client => ({
    initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
    authenticate: () => ({}), newSession: () => ({ sessionId: `session-${++serial}` }), cancel: () => {}, closeSession: () => ({}),
    async prompt(params) {
      await client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer after reload' } } })
      return { stopReason: 'end_turn' }
    },
  } satisfies Agent), ndJsonStream(Writable.toWeb(output), Readable.toWeb(input) as ReadableStream<Uint8Array>))
  let state: State = initialState, view: AgentInfo = { mode: 'connecting', cwd: process.cwd(), model: '' }
  const map = createEventActions()
  const ingress = createConversationIngress<EventEnvelope>({
    current: () => ({ pending: false, context: { conversationId: state.conversationId ?? state.info.conversationId ?? null, sessionId: state.info.sessionId ?? null } }),
    deliver: event => { const action = map(event); if (action) state = reduce(state, action) },
  })
  const bridge = createAcpBridge({ routing: testRequests(),
    dshBin: '/fixture/dsh', profile: 'viva', cwd: process.cwd(), env: {},
    spawnFn: (() => child as unknown as ChildProcess) as typeof spawn,
    conversationContext: id => { const context = sessions.context(); return context.sessionId === id ? context : { conversationId: null, sessionId: id } },
    emit: value => { const event = decodeAgentEvent(value); if (event) ingress.receive(event) },
  })
  const sessions = createConversationSession({
    history: () => db, agent: () => bridge, info: () => view, setInfo: value => { view = value },
    isBusy: () => false, folderExists: () => true, selectedModel: () => null, changed: () => {},
  })
  sessions.open(process.cwd())
  try {
    view = sessions.ready(await bridge.start(), process.cwd())
    state = reduce(state, { type: 'new_session', info: view })
    const segment = sessions.current().id
    await sessions.withSelection(async selection => {
      const info = await selection.reloadAgent()
      ingress.receive({ type: 'config', info })
    })
    assert.equal(sessions.current().id, segment)
    assert.equal(sessions.current().sessionId, 'session-2')
    assert.equal(state.info.sessionId, 'session-2')
    state = reduce(state, { type: 'user_prompt', text: 'hello', at: 1 })
    await bridge.prompt('hello')
    assert.deepEqual(state.messages.map(message => message.text), ['hello', 'answer after reload'])
    assert.equal(state.phase, 'idle')
  } finally {
    child.exitCode = 0; await bridge.dispose(); input.end(); output.end()
  }
})
