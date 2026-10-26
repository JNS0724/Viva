import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAssistantStream } from '../src/main/assistant-stream.ts'
import { apply } from '../plugins/stream/index.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

function setup({ ready = true, ack = true } = {}) {
  const sent = [], updates = []
  const desk = createAssistantStream({ timeoutMs: 15, send: message => {
    sent.push(message)
    if (ack && message.type === 'assistant_stream_bind') desk.receive({ type: 'assistant_stream_bound', version: 1, operation: message.operation })
    if (ack && message.type === 'assistant_stream_flush') desk.receive({ type: 'assistant_stream_flushed', version: 1, operation: message.operation })
  }, emit: (sessionId, update) => updates.push({ sessionId, update }) })
  if (ready) desk.receive({ type: 'assistant_stream_ready', version: 1 })
  const frame = (op, kind, values = {}) => desk.receive({ type: 'assistant_stream', version: 1, sessionId: op.sessionId, operation: op.id, key: op.id + ':1', kind, ...values })
  return { desk, frame, sent, updates }
}

test('bridge recreation cannot reuse the identity of a committed answer after a dsh crash', async () => {
  const first = setup(), restarted = setup()
  const old = await first.desk.begin('same-session')
  const next = await restarted.desk.begin('same-session')
  assert.notEqual(old.id, next.id)
  first.desk.finish(old); restarted.desk.finish(next)
})

test('source is selected before a prompt, late ready applies to the next operation; tools and usage remain ACP', async () => {
  const { desk } = setup({ ready: false })
  const op = await desk.begin('s')
  desk.receive({ type: 'assistant_stream_ready', version: 1 })
  assert.equal(desk.suppress('s', { sessionUpdate: 'agent_message_chunk' }), false)
  desk.finish(op)
  const next = await desk.begin('s')
  assert.equal(desk.suppress('s', { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }), true)
  assert.equal(desk.suppress('s', { sessionUpdate: 'tool_call' }), false)
  assert.equal(desk.suppress('s', { sessionUpdate: 'usage_update' }), false)
  desk.finish(next)
})

test('both ACP/IPC arrival orders yield canonical text once; first block-end wins and late frames cannot reach a reused session', async () => {
  for (const acpFirst of [true, false]) {
    const { desk, frame, updates } = setup()
    const op = await desk.begin('s')
    const acp = () => desk.suppress('s', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'final' } })
    if (acpFirst) acp()
    frame(op, 'start')
    frame(op, 'delta', { index: 7, blockType: 'text', text: 'draft' })
    frame(op, 'block', { index: 7, blockType: 'text', text: 'corrected' })
    frame(op, 'delta', { index: 7, blockType: 'text', text: 'ignored' })
    frame(op, 'block', { index: 7, blockType: 'text', text: 'ignored too' })
    frame(op, 'settle', { blocks: [{ type: 'text', text: 'final' }] })
    if (!acpFirst) acp()
    await desk.complete(op)
    let state = reduce(initialState, { type: 'user_prompt', text: 'question', at: 0 })
    for (const { update } of updates) state = reduce(state, { type: 'acp_update', update, at: 1 })
    assert.deepEqual(state.messages.map(m => m.text), ['question', 'final'])
    const next = await desk.begin('s')
    const count = updates.length
    frame(op, 'start'); frame(op, 'delta', { index: 0, blockType: 'text', text: 'stale' })
    assert.equal(updates.length, count)
    desk.finish(next)
  }
})

test('interleaved delta-only blocks, failed attempt, retry and partial cancel settle without stale content', () => {
  let state = reduce(initialState, { type: 'user_prompt', text: 'q', at: 0 })
  const update = (key, kind, values) => { state = reduce(state, { type: 'acp_update', at: 1, update: { sessionUpdate: 'viva_stream', key, kind, ...values } }) }
  update('failed', 'delta', { index: 0, blockType: 'text', text: 'wrong' })
  update('failed', 'delta', { index: 1, blockType: 'reasoning', text: 'wrong thought' })
  update('failed', 'settle', { blocks: [] })
  assert.equal(state.thoughts.length, 0)
  assert.equal(state.timeline.length, 0)
  update('retry', 'delta', { index: 3, blockType: 'text', text: 'A' })
  update('retry', 'delta', { index: 9, blockType: 'text', text: 'B' })
  update('retry', 'delta', { index: 3, blockType: 'text', text: 'C' })
  assert.equal(state.messages.at(-1).text, 'ACB')
  update('retry', 'settle', { blocks: [{ type: 'text', text: 'AC' }] })
  assert.deepEqual(state.messages.map(m => m.text), ['q', 'AC'])
  assert.equal(state.messages.at(-1).open, false)
})

test('plugin projects actual live events, settles from matching session/event, and omits tool arguments and replay state', () => {
  const ctx = new EventEmitter(); ctx.effect = () => {}
  const port = new EventEmitter(); const sent = []; port.connected = true; port.send = m => sent.push(m)
  apply(ctx, {}, port)
  port.emit('message', { type: 'assistant_stream_bind', version: 1, sessionId: 's', operation: 'op1' })
  const session = { id: 's' }, agent = { session }
  const publish = frame => ctx.emit('agent/assistant-stream', { agent, frame: { attemptId: 'a1', revision: 1, ...frame } })
  publish({ type: 'start', turn: 1, step: 0 })
  publish({ type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'early' } })
  publish({ type: 'chunk', chunk: { type: 'tool-call-delta', index: 1, argumentsDelta: 'private' } })
  ctx.emit('session/event', session, { seq: 4, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'canonical' }, { type: 'tool-call', arguments: 'private' }] }, stream: 'not sent' } })
  publish({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } })
  assert.equal(sent.find(m => m.kind === 'delta').text, 'early')
  assert.deepEqual(sent.at(-1).blocks, [{ type: 'text', text: 'canonical' }])
  assert.doesNotMatch(JSON.stringify(sent), /private|not sent/)
})

test('lost stream channel rolls back provisional output before using complete ACP output', async () => {
  const { desk, frame, updates } = setup()
  const op = await desk.begin('s')
  frame(op, 'start'); frame(op, 'delta', { index: 0, blockType: 'text', text: 'partial' })
  desk.suppress('s', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'complete' } })
  await desk.complete(op)
  let state = reduce(initialState, { type: 'user_prompt', text: 'q', at: 0 })
  for (const { update } of updates) state = reduce(state, { type: 'acp_update', update, at: 1 })
  assert.deepEqual(state.messages.map(m => m.text), ['q', 'complete'])
})
