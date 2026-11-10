import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantStream } from '../src/backend/assistant-stream.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { ConversationUpdate } from '../src/renderer/conversation-types.ts'
import { EventEmitter } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { decodeUpdate } from '../src/renderer/agent-event-decoder.ts'
import { historyMessages } from '../src/renderer/selectors.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { DatabaseSync } from 'node:sqlite'
import { createTaskRegistry } from '../src/backend/task-registry.ts'
import { installAssistantStream } from '../plugins/routing/lib/assistant-stream.ts'

test('the committed session recovers a final answer missing from both delivery channels without duplicating earlier messages', async () => {
  const events: Array<{ seq: number, type: string, data: { turn: number, step: number, message: { content: Array<{ type: string, text?: string, arguments?: string }> } } }> = []
  const session = { id: 'session', seq: 0, snapshotEvents: () => events }
  const agent = { session }
  const ctx = Object.assign(new EventEmitter(), { agents: { get: () => agent }, effect: () => {} })
  const updates: ConversationUpdate[] = []
  const port = Object.assign(new EventEmitter(), { connected: true, send: (message: object) => stream.receive(message) })
  const stream = createAssistantStream({ send: message => { port.emit('message', message) }, emit: (_id, update: ConversationUpdate) => updates.push(update) })
  installAssistantStream(ctx as unknown as Context, port as unknown as NodeJS.Process, () => true)
  const operation = await stream.begin('session')
  const emit = (frame: object) => ctx.emit('agent/assistant-stream', { agent, frame: { attemptId: 'intro', turn: 1, step: 1, ...frame } })
  const commit = (content: typeof events[number]['data']['message']['content'], step: number) => {
    const event = { seq: session.seq++, type: 'assistant/message', data: { turn: 1, step, message: { content } } }
    events.push(event)
    ctx.emit('session/event', session, event)
    return event
  }
  emit({ type: 'start' })
  const intro = commit([{ type: 'text', text: 'I will inspect the repository.' }, { type: 'tool-call', arguments: 'private-tool-input' }], 1)
  emit({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: intro.seq } })
  stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will inspect the repository.' } })
  stream.suppress('session', { sessionUpdate: 'tool_call' })
  commit([{ type: 'reasoning', text: 'Checked all modules.' }, { type: 'text', text: 'The complete final analysis.' }], 2)
  const finalReply = await stream.complete(operation)
  let state = reduce(initialState, { type: 'user_prompt', text: 'Analyze the repository', at: 1 })
  for (const update of updates) state = reduce(state, { type: 'acp_update', update, at: 2 })
  state = reduce(state, { type: 'turn_end', stopReason: 'end_turn', finalReply, at: 3 })
  assert.equal(finalReply, true)
  assert.deepEqual(state.messages.map(message => message.text), ['Analyze the repository', 'I will inspect the repository.', 'The complete final analysis.'])
  assert.doesNotMatch(JSON.stringify(updates), /private-tool-input/)
  const next = await stream.begin('session')
  assert.equal(await stream.complete(next), false, 'a new operation cannot borrow the previous answer')
})

test('recovering earlier and middle messages preserves final order, saved identities, stars, report anchors and task previews', async () => {
  const updates: ConversationUpdate[] = []
  const messages = [
    { key: 'intro', blocks: [{ type: 'text', text: 'Earlier explanation.' }] },
    { key: 'middle', blocks: [{ type: 'text', text: 'Middle explanation.' }] },
    { key: 'final', blocks: [{ type: 'text', text: 'Final result.' }] },
  ]
  const stream = createAssistantStream({ send: message => {
    const command = message as { type: string, operation: string }
    if (command.type === 'assistant_stream_bind') stream.receive({ type: 'assistant_stream_bound', version: 1, operation: command.operation })
    if (command.type === 'assistant_stream_flush') stream.receive({ type: 'assistant_stream_flushed', version: 1, operation: command.operation, messages, finalReply: true })
  }, emit: (_id, update: ConversationUpdate) => updates.push(update) })
  stream.receive({ type: 'assistant_stream_ready', version: 1 })
  const operation = await stream.begin('session')
  stream.receive({ type: 'assistant_stream', version: 1, sessionId: 'session', operation: operation.id, key: 'final', kind: 'start' })
  stream.receive({ type: 'assistant_stream', version: 1, sessionId: 'session', operation: operation.id, key: 'final', kind: 'settle', blocks: messages[2].blocks })
  let state = reduce(reduce(initialState, { type: 'ready', info: { mode: 'live', sessionId: 'session', model: 'test', cwd: '/test', reason: '' } }),
    { type: 'user_prompt', text: 'Question', at: 1 })
  state = reduce(state, { type: 'acp_update', update: updates.shift()!, at: 2 })
  state = reduce(state, { type: 'report_delivered', conversationId: null, sessionId: state.info.sessionId ?? null, reportId: 'report', text: 'Task output', at: 3 })
  const sqlite = new DatabaseSync(':memory:')
  const history = openHistoryDb({ db: sqlite })
  try {
    const conversation = history.create({ sessionId: 'session' })
    history.save(conversation, historyMessages(state, { keys: true }))
    history.addRecord({ conversationId: conversation.id, reportId: 'report', text: 'Task output', at: 3 })
    history.setStar(conversation.id, 1, true)
    const originalId = sqlite.prepare('SELECT id FROM messages WHERE conversation_id = ? AND seq = 1').get(conversation.id)!.id
    state = reduce(state, { type: 'user_steer', text: 'Additional instruction' })
    history.save(conversation, historyMessages(state, { keys: true }))
    const registry = createTaskRegistry()
    registry.put({ id: 'task', title: 'Analysis' })
    registry.receive({ type: 'task_update', taskId: 'task', update: { sessionUpdate: 'viva_stream', key: 'final', kind: 'settle', blocks: messages[2].blocks } })
    const finalReply = await stream.complete(operation)
    for (const update of updates) {
      const decoded = decodeUpdate(update)
      assert.ok(decoded)
      state = reduce(state, { type: 'acp_update', update: decoded, at: 4 })
      registry.receive({ type: 'task_update', taskId: 'task', update: decoded })
    }
    assert.deepEqual(state.messages.map(message => message.text), ['Question', 'Earlier explanation.', 'Middle explanation.', 'Final result.', 'Additional instruction'])
    assert.equal(state.records[0].after, 4)
    assert.equal(registry.snapshotOf('task')?.resultPreview, 'Final result.')
    state = reduce(state, { type: 'turn_end', stopReason: 'end_turn', finalReply, at: 5 })
    history.save(conversation, historyMessages(state, { keys: true }))
    assert.deepEqual(history.get(conversation.id)!.messages.map(message => message.text), state.messages.map(message => message.text))
    assert.equal(history.get(conversation.id)!.records[0].after, 4)
    assert.equal(sqlite.prepare('SELECT id FROM messages WHERE conversation_id = ? AND seq = 3').get(conversation.id)!.id, originalId)
    assert.equal(sqlite.prepare('SELECT seq FROM stars WHERE conversation_id = ?').get(conversation.id)!.seq, 3)
  } finally { sqlite.close() }
})

test('committed identities distinguish recovered text with the same prefix or identical text and move side-task anchors', () => {
  for (const explanation of ['Result analysis', 'Result']) {
    const sqlite = new DatabaseSync(':memory:')
    const history = openHistoryDb({ db: sqlite })
    try {
      const conversation = history.create({ sessionId: 'session' })
      const question = { role: 'user', text: 'Question' }
      const final = { role: 'assistant', text: 'Result', key: 'final' }
      history.save(conversation, [question, final])
      history.setStar(conversation.id, 1, true)
      history.addRecord({ conversationId: conversation.id, reportId: 'report', text: 'Task output', at: 1 })
      const side = history.create({ sessionId: 'side' })
      history.save(side, [question])
      history.fold(side.id, { into: conversation.id, at: 2, kind: 'side' })
      const id = sqlite.prepare('SELECT id FROM messages WHERE conversation_id = ? AND seq = 1').get(conversation.id)!.id
      history.save(conversation, [question, { role: 'assistant', text: explanation, key: 'intro' }, final])
      const stored = history.get(conversation.id)!
      assert.deepEqual(stored.messages.map(message => message.text), ['Question', explanation, 'Result'])
      assert.equal(stored.messages[2].key, 'final')
      assert.equal(stored.records[0].after, 3)
      assert.equal(history.sideTaskHost(side.id)!.at, 3)
      assert.equal(sqlite.prepare('SELECT id FROM messages WHERE conversation_id = ? AND seq = 2').get(conversation.id)!.id, id)
      assert.equal(sqlite.prepare('SELECT seq FROM stars WHERE conversation_id = ?').get(conversation.id)!.seq, 2)
      const restored = reduce(initialState, { type: 'history_loaded', conversationId: conversation.id, messages: stored.messages, savedAt: 2 })
      assert.equal(restored.messages[2].streamKey, 'final')
      const rewound = reduce(initialState, { type: 'rewound', conversation: { id: conversation.id, messages: stored.messages }, info: restored.info, folds: [] })
      assert.equal(rewound.messages[2].streamKey, 'final')
      history.save(conversation, [question, { role: 'assistant', text: explanation, key: 'intro' }, { ...final, text: 'Canonical correction' }])
      assert.equal(sqlite.prepare('SELECT id FROM messages WHERE conversation_id = ? AND seq = 2').get(conversation.id)!.id, id)
      assert.equal(sqlite.prepare('SELECT seq FROM stars WHERE conversation_id = ?').get(conversation.id)!.seq, 2)
    } finally { sqlite.close() }
  }
})

test('legacy history without committed identities opens and retains its existing messages', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const original = openHistoryDb({ db: sqlite })
    const conversation = original.create({ sessionId: 'legacy' })
    original.save(conversation, [{ role: 'user', text: 'Legacy question' }])
    sqlite.exec('ALTER TABLE messages DROP COLUMN source_key')
    const reopened = openHistoryDb({ db: sqlite })
    assert.equal(reopened.get(conversation.id)!.messages[0].text, 'Legacy question')
    assert.ok(sqlite.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'source_key'))
  } finally { sqlite.close() }
})

test('routing recovery respects each attempt gate while recovering an allowed final reply', async () => {
  for (const allowFinal of [false, true]) {
    const events: Array<{ seq: number, type: string, data: { turn: number, step: number, message: { content: Array<{ type: string, text: string }> } } }> = []
    const session = { id: 'session', seq: 0, snapshotEvents: () => events }
    const agent = { session }
    const ctx = Object.assign(new EventEmitter(), { agents: { get: () => agent }, effect: () => {} })
    const updates: ConversationUpdate[] = []
    const port = Object.assign(new EventEmitter(), { connected: true, send: (message: { type: string }) => {
      // Drop all native frames. The committed flush must still apply the routing gate.
      if (message.type !== 'assistant_stream') stream.receive(message)
    } })
    const stream = createAssistantStream({ send: message => { port.emit('message', message) }, emit: (_id, update: ConversationUpdate) => updates.push(update) })
    installAssistantStream(ctx as unknown as Context, port as unknown as NodeJS.Process, (_session, step) => allowFinal && step === 2)
    const operation = await stream.begin('session')
    for (const [step, text] of [[1, 'Hidden planning text'], [2, 'Allowed final reply']] as const) {
      const frame = { attemptId: `attempt-${step}`, turn: 1, step }
      ctx.emit('agent/assistant-stream', { agent, frame: { ...frame, type: 'start' } })
      const event = { seq: session.seq++, type: 'assistant/message', data: { turn: 1, step, message: { content: [{ type: 'text', text }] } } }
      events.push(event)
      ctx.emit('session/event', session, event)
      ctx.emit('agent/assistant-stream', { agent, frame: { ...frame, type: 'end', outcome: { kind: 'committed', eventType: event.type, seq: event.seq } } })
      stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    }
    assert.equal(await stream.complete(operation), allowFinal)
    assert.doesNotMatch(JSON.stringify(updates), /Hidden planning text/)
    assert.equal(JSON.stringify(updates).includes('Allowed final reply'), allowFinal)
  }
})

test('routing keeps ACP behind its gate when ready, bind or flush confirmation is missing', async () => {
  for (const failure of ['ready', 'bound', 'flushed']) for (const allowed of [false, true]) {
    const event = { seq: 0, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Gated text' }] } } }
    const events: Array<typeof event> = []
    const session = { id: 'session', seq: 0, snapshotEvents: () => events }
    const agent = { session }
    const ctx = Object.assign(new EventEmitter(), { agents: { get: () => agent }, effect: () => {} })
    const updates: ConversationUpdate[] = []
    const port = Object.assign(new EventEmitter(), { connected: true, send: (message: { type: string }) => {
      if (message.type !== `assistant_stream_${failure}`) stream.receive(message)
    } })
    const stream = createAssistantStream({ timeoutMs: 5,
      send: message => { port.emit('message', message) }, emit: (_id, update: ConversationUpdate) => updates.push(update) })
    installAssistantStream(ctx as unknown as Context, port as unknown as NodeJS.Process, () => allowed)
    const operation = await stream.begin('session')
    const frame = { attemptId: 'attempt', turn: 1, step: 1 }
    ctx.emit('agent/assistant-stream', { agent, frame: { ...frame, type: 'start' } })
    events.push(event); session.seq++
    ctx.emit('session/event', session, event)
    ctx.emit('agent/assistant-stream', { agent, frame: { ...frame, type: 'end', outcome: { kind: 'committed', eventType: event.type, seq: event.seq } } })
    assert.equal(stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Gated text' } }), true)
    await assert.rejects(stream.complete(operation), /确认|confirm/i)
    assert.equal(JSON.stringify(updates).includes('Gated text'), allowed && failure === 'flushed')
    assert.equal(updates.some(update => update.sessionUpdate === 'agent_message_chunk'), false)
  }
})
