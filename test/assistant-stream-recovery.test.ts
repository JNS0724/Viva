import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantStream } from '../src/backend/assistant-stream.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import type { ConversationUpdate } from '../src/renderer/conversation-types.ts'
import { EventEmitter } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../plugins/stream/index.ts'
import { decodeUpdate } from '../src/renderer/agent-event-decoder.ts'
import { historyMessages } from '../src/renderer/selectors.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { DatabaseSync } from 'node:sqlite'
import { createTaskRegistry } from '../src/backend/task-registry.ts'

test('completion recovers canonical ACP output when a settled live channel omits the final answer', async () => {
  for (const missing of ['attempt', 'settlement', 'text-block', 'none']) {
    const updates: ConversationUpdate[] = []
    const stream = createAssistantStream({
      send: message => {
        const command = message as { type: string, operation: string }
        if (command.type === 'assistant_stream_bind') stream.receive({ type: 'assistant_stream_bound', version: 1, operation: command.operation })
        if (command.type === 'assistant_stream_flush') stream.receive({ type: 'assistant_stream_flushed', version: 1, operation: command.operation })
      },
      emit: (_sessionId, update: ConversationUpdate) => updates.push(update),
    })
    stream.receive({ type: 'assistant_stream_ready', version: 1 })
    const operation = await stream.begin('session')
    const frame = (key: string, kind: string, blocks?: Array<{ type: string, text: string }>) => stream.receive({
      type: 'assistant_stream', version: 1, sessionId: 'session', operation: operation.id, key, kind, blocks,
    })
    frame('preparation', 'start')
    frame('preparation', 'settle', [{ type: 'text', text: 'I will check.' }, { type: 'reasoning', text: 'Thinking.' }])
    stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will check.' } })
    stream.suppress('session', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking.' } })
    if (missing !== 'attempt') {
      frame('answer', 'start')
      const blocks = missing === 'settlement' ? [] : [{ type: 'reasoning', text: 'Final thought.' }]
      if (missing === 'none') blocks.push({ type: 'text', text: 'Complete final answer.' })
      frame('answer', 'settle', blocks)
    }
    stream.suppress('session', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Final thought.' } })
    stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Complete final ' } })
    stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer.' } })
    await stream.complete(operation)

    let state = reduce(initialState, { type: 'user_prompt', text: 'Question', at: 0 })
    for (const update of updates) state = reduce(state, { type: 'acp_update', update, at: 1 })
    state = reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: 2 })
    assert.equal(state.messages.filter(message => message.role === 'assistant').map(message => message.text).join(''), 'I will check.Complete final answer.', missing)
    assert.equal(state.thoughts.map(thought => thought.text).join(''), 'Thinking.Final thought.', missing)
    assert.equal(state.phase, 'idle')
    assert.equal(updates.some(update => update.sessionUpdate === 'agent_message_chunk'), missing !== 'none', 'healthy native output keeps its identities without replaying ACP')
  }
})

test('the committed session recovers a final answer missing from both delivery channels without duplicating earlier messages', async () => {
  const events: Array<{ seq: number, type: string, data: { turn: number, step: number, message: { content: Array<{ type: string, text?: string, arguments?: string }> } } }> = []
  const session = { id: 'session', seq: 0, snapshotEvents: () => events }
  const agent = { session }
  const ctx = Object.assign(new EventEmitter(), { agents: { get: () => agent }, effect: () => {} })
  const updates: ConversationUpdate[] = []
  const port = Object.assign(new EventEmitter(), { connected: true, send: (message: object) => stream.receive(message) })
  const stream = createAssistantStream({ send: message => { port.emit('message', message) }, emit: (_id, update: ConversationUpdate) => updates.push(update) })
  apply(ctx as unknown as Context, {}, port as unknown as NodeJS.Process)
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

test('canonical ACP tracks whether text follows the last tool even when the live channel is unavailable', async () => {
  const stream = createAssistantStream({ send: () => {}, emit: () => {} })
  const empty = await stream.begin('session')
  assert.equal(await stream.complete(empty), false, 'an empty ACP turn has no final reply')
  const operation = await stream.begin('session')
  assert.equal(stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will inspect.' } }), false)
  stream.suppress('session', { sessionUpdate: 'tool_call' })
  stream.suppress('session', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking.' } })
  assert.equal(await stream.complete(operation), false)
  const next = await stream.begin('session')
  stream.suppress('session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final analysis.' } })
  assert.equal(await stream.complete(next), true)
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
