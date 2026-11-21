import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { createForegroundHistory } from '../src/backend/foreground-history.ts'
import { openHistoryDb, type Conversation } from '../src/backend/history-db.ts'
import { MAX_ASSISTANT_TEXT_CHARS } from '../src/backend/history-schema.ts'
import { createRendererStream } from '../src/backend/renderer-stream.ts'
import { CONVERSATION_WINDOW_MESSAGES } from '../src/shared/renderer-sync.ts'
import { SILENT_REPLY } from '../src/shared/task-report.ts'
import { CONVERSATION_WINDOW_LIMIT, initialState, reduce } from '../src/renderer/state.ts'
import { foldAfter, rewindTarget } from '../src/renderer/rewind-state.ts'
import { recordsAt } from '../src/renderer/report-state.ts'
import { placeOf } from '../src/renderer/stars.ts'
import { hitTarget } from '../src/renderer/timeline-search.ts'
import { restoredTaskAnchors } from '../src/renderer/view/task-card.ts'

function openMemoryHistory(t: TestContext) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  let clock = 1_000_000
  const history = openHistoryDb({ db, now: () => (clock += 1000) })
  return { db, history, advance: (ms: number) => { clock += ms } }
}

test('foreground history persists prompts, steers, authenticated streams, receipts, silent tasks and cancels incrementally', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-1', mode: 'live', model: 'V4', cwd: '/w' })
  let clock = 10_000
  let delegated = false
  const writer = createForegroundHistory({
    commit: history.commit,
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    checkpoint: id => stream.checkpoint(id),
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    delegatedDuringTurn: () => delegated,
    onError: err => { throw err },
    now: () => clock,
  })
  const context = { conversationId: current.id, sessionId: 's-1' }

  // 1. User prompt with images and idempotent duplicate sourceId
  const promptId = randomUUID()
  const picId = `${'a'.repeat(64)}.png`
  writer.userPrompt({ text: '帮我看下这张图', images: [{ id: picId }], sourceId: promptId, advanceCheckpoint: true })
  writer.userPrompt({ text: '帮我看下这张图', images: [{ id: picId }], sourceId: promptId })
  assert.equal(history.get(current.id)!.messages.length, 1)
  assert.deepEqual(history.get(current.id)!.messages[0]!.images, [{ id: picId }])
  assert.equal(current.title, '帮我看下这张图')

  // 2. Turn with tool call, reasoning block, settled authenticated stream, and receipt
  stream.send({ type: 'turn_started', by: 'user', context })
  writer.receive({ type: 'turn_started', by: 'user', context })
  clock += 1500
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read' } })
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-1', kind: 'delta', index: 0, blockType: 'reasoning', text: '思考中' } })
  history.bindGeneratedCopy('s-1', 'k-1', 'assistant', '这是图片分析结果', [{ sources: [promptId], fileRanges: [] }])
  writer.receive({
    type: 'update', context,
    update: { sessionUpdate: 'viva_stream', key: 'k-1', kind: 'settle', blocks: [{ type: 'reasoning', text: '思考中' }, { type: 'text', text: '这是图片分析结果' }] },
  })
  clock += 500
  stream.send({ type: 'turn_end', stopReason: 'end_turn', finalReply: true, context })
  writer.receive({ type: 'turn_end', stopReason: 'end_turn', finalReply: true, context })

  const afterTurn1 = history.get(current.id)!.messages
  assert.equal(afterTurn1.length, 2)
  assert.equal(afterTurn1[1]!.text, '这是图片分析结果')
  assert.equal(afterTurn1[1]!.key, 'k-1')
  assert.deepEqual(afterTurn1[1]!.receipt, { ms: 2000, tools: 1, thoughts: 1, stopReason: 'end_turn' })
  assert.deepEqual(stream.snapshot(current.id, context).replay, [], 'turn_end advances backend checkpoint')

  // 3. Unauthenticated assistant key is still blanked by the production proof gate
  history.commit(current, [{ kind: 'upsert_assistant', message: { role: 'assistant', text: '未认证回复', receipt: null, key: 'forged-key' } }], { sourceSession: 's-1' })
  assert.equal(history.get(current.id)!.messages.at(-1)?.text, '')
  history.commit(current, [{ kind: 'remove_stream', key: 'forged-key' }], { sourceSession: 's-1' })
  assert.equal(history.get(current.id)!.messages.length, 2)

  // 4. Silent background task report removes SILENT_REPLY without leaving a note
  writer.receive({ type: 'turn_started', by: 'task', context })
  history.bindGeneratedCopy('s-1', 'k-silent', 'assistant', SILENT_REPLY, [{ sources: [], fileRanges: [] }])
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-silent', kind: 'settle', blocks: [{ type: 'text', text: SILENT_REPLY }] } })
  writer.receive({ type: 'turn_end', stopReason: 'end_turn', finalReply: true, context })
  assert.equal(history.get(current.id)!.messages.length, 2)

  // 5. Question answered mid-turn persists immediately and flags replay for reload deduplication
  const qSource = randomUUID()
  writer.receive({ type: 'turn_started', by: 'user', context })
  writer.receive({ type: 'question', questionId: 'q-1', questions: [{ id: 'city', question: '哪个城市？' }], context })
  const answerEvent = { type: 'question_answered', questionId: 'q-1', answers: [{ id: 'city', selected: ['深圳'], custom: '南山' }], sourceIds: { city: qSource }, context }
  stream.send(answerEvent)
  writer.receive(answerEvent)
  const replayed = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.equal(replayed.at(-1)?.inHistory, true)
  assert.equal(history.get(current.id)!.messages.at(-1)?.text, '深圳、南山')
  assert.equal(history.get(current.id)!.messages.at(-1)?.sourceId, qSource)

  // 6. Cancelled turn appends a stop note even when an assistant stream settled earlier in the turn
  history.bindGeneratedCopy('s-1', 'k-partial', 'assistant', '说了一半', [{ sources: [], fileRanges: [] }])
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-partial', kind: 'settle', blocks: [{ type: 'text', text: '说了一半' }] } })
  writer.receive({ type: 'turn_end', stopReason: 'cancelled', context })
  const afterCancel = history.get(current.id)!.messages
  assert.equal(afterCancel.at(-2)?.text, '说了一半')
  assert.equal(afterCancel.at(-2)?.receipt, null)
  assert.equal(afterCancel.at(-1)?.role, 'note')
  assert.equal(afterCancel.at(-1)?.receipt?.stopReason, 'cancelled')

  // 7. Delegated turn without finalReply does not degrade to no_response
  delegated = true
  writer.receive({ type: 'turn_started', by: 'user', context })
  history.bindGeneratedCopy('s-1', 'k-del', 'assistant', '已交给后台处理', [{ sources: [], fileRanges: [] }])
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-del', kind: 'settle', blocks: [{ type: 'text', text: '已交给后台处理' }] } })
  writer.receive({ type: 'turn_end', stopReason: 'end_turn', finalReply: false, context })
  assert.equal(history.get(current.id)!.messages.at(-1)?.receipt?.stopReason, 'end_turn')
})

test('incremental commit handles beforeKey insertion shifting stars and report records, and scales past 5000 messages', t => {
  const { history } = openMemoryHistory(t)
  let conv = history.create({ sessionId: 's-long', mode: 'live', model: 'V4', cwd: '/w' })
  conv = history.commit(conv, [{ kind: 'append_user', message: { role: 'user', text: '第一句', receipt: null } }])
  history.bindGeneratedCopy('s-long', 'k-second', 'assistant', '后到的第二段', [{ sources: [], fileRanges: [] }])
  conv = history.commit(conv, [{ kind: 'upsert_assistant', message: { role: 'assistant', text: '后到的第二段', receipt: null, key: 'k-second' } }])
  history.setStar(conv.id, 1, true)
  history.addRecord({ conversationId: conv.id, reportId: 'r-1', at: 100, text: '后台汇报' }) // after_seq = 2

  // Insert an earlier committed stream before k-second
  history.bindGeneratedCopy('s-long', 'k-first', 'assistant', '补回的第一段', [{ sources: [], fileRanges: [] }])
  conv = history.commit(conv, [{ kind: 'upsert_assistant', message: { role: 'assistant', text: '补回的第一段', receipt: null, key: 'k-first' }, beforeKey: 'k-second' }])
  assert.deepEqual(history.get(conv.id)!.messages.map(m => m.text), ['第一句', '补回的第一段', '后到的第二段'])
  assert.deepEqual(history.starsIn([conv.id]), [{ segmentId: conv.id, seq: 2 }], 'star moved with k-second')
  assert.equal(history.recordsOf(conv.id)[0]?.after, 3, 'report anchor shifted after insertion')

  // Verify no 5000-message cliff and O(window) tail read
  const batch = Array.from({ length: 5_050 }, (_, index) => ({
    kind: 'append_user' as const,
    message: { role: 'user' as const, text: `msg-${index}`, receipt: null },
  }))
  conv = history.commit(conv, batch)
  const tail = history.getTail(conv.id, CONVERSATION_WINDOW_MESSAGES)!
  assert.equal(tail.total, 5_053)
  assert.equal(tail.offset, 5_053 - CONVERSATION_WINDOW_MESSAGES)
  assert.equal(tail.messages.length, CONVERSATION_WINDOW_MESSAGES)
  assert.equal(tail.messages[0]?.text, `msg-${5_050 - CONVERSATION_WINDOW_MESSAGES}`)
  assert.equal(tail.messages.at(-1)?.text, 'msg-5049')
})

test('renderer sliding window trims long sessions on idle turn_end and preserves absolute seq across rewind, stars, search, records and anchors', () => {
  // 1. Load a windowed snapshot with offset > 0
  let state: State = reduce(initialState, {
    type: 'initialization_snapshot',
    snapshot: {
      streamGeneration: 'g-1',
      cutoverCursor: 0,
      context: { conversationId: 'seg-long', sessionId: 's-1' },
      info: { mode: 'live', model: 'V4', cwd: '/w', conversationId: 'seg-long', sessionId: 's-1' },
      replay: [],
      history: {
        id: 'seg-long',
        createdAt: 1,
        updatedAt: 2,
        parentId: null,
        offset: 400,
        total: 402,
        messages: [
          { role: 'user', text: '旧问题', receipt: null },
          { role: 'assistant', text: '旧回答', receipt: null },
        ],
        records: [{ reportId: 'r-401', at: 10, text: '汇报', after: 401 }],
        folds: [{ id: 'f-1', at: 401, count: 2, kind: 'path' }],
      },
    },
  })
  assert.equal(state.historyOffset, 400)
  assert.equal(state.restored?.count, 402)
  assert.equal(state.messages[0]?.id, 'm400')
  assert.deepEqual(rewindTarget(state, 'm400'), { words: '旧问题', occurrence: 0, keep: 400 })
  assert.deepEqual(foldAfter(state)['m400']?.map(f => f.id), ['f-1'])
  assert.deepEqual(placeOf(state, 'm401', 'thread'), { segmentId: 'seg-long', seq: 401 })
  assert.equal(hitTarget(state, { segmentId: 'seg-long', seq: 399, messageId: 1 }), null, 'messages before window open in Review')
  assert.deepEqual(hitTarget(state, { segmentId: 'seg-long', seq: 401, messageId: 2 }), { msgId: 'm401' })
  assert.deepEqual(recordsAt(state, 401).map(r => r.reportId), ['r-401'])

  // Report delivered in a windowed session records absolute after offset
  const withReport = reduce(state, {
    type: 'report_delivered', conversationId: 'seg-long', sessionId: 's-1', reportId: 'r-402', text: '新汇报', at: 20,
  })
  assert.equal(withReport.records.at(-1)?.after, 402)

  // Restored task anchors clamp against total (historyOffset + messages.length)
  const anchored = restoredTaskAnchors({
    ...state,
    tasks: { ...state.tasks, list: [{ id: 't-1', title: 'T', status: 'done', host: { conversationId: 'seg-long', at: 401, order: 1 }, view: state } as unknown as BackgroundTask] },
  })
  assert.deepEqual(anchored, [{ taskId: 't-1', at: 401 }])

  // 2. Question answered replay with inHistory: true closes question without duplicating message
  const asked = reduce(state, { type: 'question_request', questionId: 'q-replay', questions: [{ id: 'a', question: '确认？', options: [] }], at: 30 })
  const replayed = reduce(asked, { type: 'question_answered', questionId: 'q-replay', answers: [{ id: 'a', selected: ['好'] }], at: 31, inHistory: true })
  assert.equal(replayed.question, null)
  assert.equal(replayed.messages.length, state.messages.length, 'inHistory replay does not duplicate user reply')
  assert.equal(replayed.timeline.at(-1)?.kind, 'answer')

  // 3. Sliding window trims when exceeding CONVERSATION_WINDOW_LIMIT on idle turn_end
  let grown = state
  for (let i = 0; i < CONVERSATION_WINDOW_LIMIT; i += 2) {
    grown = reduce(grown, { type: 'user_prompt', text: `q-${i}`, at: 100 + i })
    grown = reduce(grown, { type: 'acp_update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `a-${i}` } }, at: 101 + i })
    grown = reduce(grown, { type: 'turn_end', stopReason: 'end_turn', at: 102 + i })
  }
  assert.ok(grown.messages.length <= CONVERSATION_WINDOW_LIMIT)
  assert.ok(grown.historyOffset > 400, 'historyOffset advanced when older messages were trimmed')
  assert.equal(grown.messages.length + grown.historyOffset, 402 + Math.ceil(CONVERSATION_WINDOW_LIMIT / 2) * 2)
})

test('foreground history keeps replay checkpoint intact on write failures and retries pending writes in order', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-err', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-err' }
  let failWrites = false
  const errors: unknown[] = []
  let checkpoints = 0
  const writer = createForegroundHistory({
    commit: (conv, ops, options) => {
      if (failWrites) throw new Error('disk full')
      return history.commit(conv, ops, options)
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    checkpoint: id => { checkpoints += 1; stream.checkpoint(id) },
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    onError: err => { errors.push(err) },
  })

  // 1. Transient disk failure during viva_stream + turn_end must NOT advance checkpoint and must retain ops for retry
  writer.userPrompt({ text: '第一问', advanceCheckpoint: true })
  const beforeTurnCheckpoints = checkpoints
  failWrites = true
  history.bindGeneratedCopy('s-err', 'k-reply', 'assistant', '完整回复', [{ sources: [], fileRanges: [] }])
  const startEvent = { type: 'turn_started', by: 'user', context }
  const streamEvent = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-reply', kind: 'settle', blocks: [{ type: 'text', text: '完整回复' }] } }
  const endEvent = { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context }
  for (const event of [startEvent, streamEvent, endEvent]) { stream.send(event); writer.receive(event) }
  assert.equal(errors.length, 2)
  assert.equal(checkpoints, beforeTurnCheckpoints, 'failed turn_end never advances checkpoint')
  assert.equal(stream.snapshot(current.id, context).replay.length, 3, 'unpersisted turn remains replayable on reload')
  assert.equal(history.get(current.id)!.messages.length, 1)

  // Recover disk: flush retries retained ops in order (upsert_assistant then attach_receipt)
  failWrites = false
  assert.equal(writer.flush(), true)
  const afterRetry = history.get(current.id)!.messages
  assert.deepEqual(afterRetry.map(m => m.text), ['第一问', '完整回复'])
  assert.equal(afterRetry[1]?.receipt?.stopReason, 'end_turn')

  // 2. Long assistant reply above 200_000 chars (within MAX_ASSISTANT_TEXT_CHARS) persists cleanly
  const longText = 'y'.repeat(250_000)
  history.bindGeneratedCopy('s-err', 'k-long', 'assistant', longText, [{ sources: [], fileRanges: [] }])
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-long', kind: 'settle', blocks: [{ type: 'text', text: longText }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]) { stream.send(event); writer.receive(event) }
  assert.equal(history.get(current.id)!.messages.at(-1)?.text.length, 250_000)

  // 3. Permanently invalid reply (> MAX_ASSISTANT_TEXT_CHARS) leaves checkpoint behind WITHOUT blocking subsequent turns
  const oversized = 'x'.repeat(MAX_ASSISTANT_TEXT_CHARS + 1)
  const beforeOversizedCheckpoints = checkpoints
  const oversizedStart = { type: 'turn_started', by: 'user', context }
  const oversizedChunk = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: oversized } } }
  const oversizedEnd = { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context }
  for (const event of [oversizedStart, oversizedChunk, oversizedEnd]) { stream.send(event); writer.receive(event) }
  assert.equal(errors.length, 3)
  assert.equal(checkpoints, beforeOversizedCheckpoints, 'validation failure never advances checkpoint')
  assert.equal(writer.hasPendingWrites(), false, 'permanent validation failure does not poison pendingWrites')
  assert.throws(() => stream.snapshot(current.id, context), /unreplayable gap/, 'unpersisted evicted reply exposes an explicit gap instead of silently advancing checkpoint')

  // Subsequent user prompt and assistant reply in the same conversation still persist normally!
  writer.userPrompt({ text: '后续正常提问' })
  history.bindGeneratedCopy('s-err', 'k-next', 'assistant', '后续正常回复', [{ sources: [], fileRanges: [] }])
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-next', kind: 'settle', blocks: [{ type: 'text', text: '后续正常回复' }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]) { stream.send(event); writer.receive(event) }
  const afterRecovery = history.get(current.id)!.messages
  assert.equal(afterRecovery.at(-2)?.text, '后续正常提问')
  assert.equal(afterRecovery.at(-1)?.text, '后续正常回复')
  assert.equal(checkpoints, beforeOversizedCheckpoints + 1)
})

test('silent task turns persist earlier plain assistant segments and drop only the trailing silent reply', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-silent', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-silent' }
  let failWrites = false
  let checkpoints = 0
  const committedTexts: string[] = []
  const writer = createForegroundHistory({
    commit: (conv, ops) => {
      if (failWrites) throw new Error('sqlite busy')
      for (const op of ops) {
        if (op.kind === 'upsert_assistant') committedTexts.push(op.message.text)
      }
      return conv
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    checkpoint: id => { checkpoints += 1; stream.checkpoint(id) },
    onError: () => {},
  })

  // Plain assistant text -> tool_call boundary -> trailing SILENT_REPLY
  const events = [
    { type: 'turn_started', by: 'task', context },
    { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先看一下任务输出' } } },
    { type: 'update', context, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read' } },
    { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: SILENT_REPLY } } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]

  // When persistence fails, checkpoint stays put and earlier plain segment is retained for retry
  failWrites = true
  for (const event of events) { stream.send(event); writer.receive(event) }
  assert.equal(checkpoints, 0, 'failed silent-task flush does not advance checkpoint')
  assert.deepEqual(committedTexts, [])
  assert.equal(stream.snapshot(current.id, context).replay.length, events.length)

  failWrites = false
  assert.equal(writer.flush(), true)
  assert.equal(checkpoints, 1, 'deferred checkpoint advances once retry succeeds')
  assert.deepEqual(committedTexts, ['先看一下任务输出'])

  // Normal silent task with earlier plain segment persists earlier text and advances checkpoint
  const nextEvents = [
    { type: 'turn_started', by: 'task', context },
    { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二段可见说明' } } },
    { type: 'update', context, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'Read' } },
    { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: SILENT_REPLY } } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]
  for (const event of nextEvents) { stream.send(event); writer.receive(event) }
  assert.equal(checkpoints, 2)
  assert.deepEqual(committedTexts, ['先看一下任务输出', '第二段可见说明'])
  assert.deepEqual(stream.snapshot(current.id, context).replay, [])
})

test('pending writes survive conversation switches and reset until committed for their own conversation', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let convA: Conversation = history.create({ sessionId: 's-a', mode: 'live', model: 'V4', cwd: '/w' })
  const convB: Conversation = history.create({ sessionId: 's-b', mode: 'live', model: 'V4', cwd: '/w' })
  let current: Conversation = convA
  let failWrites = false
  const checkpointed: string[] = []
  const writer = createForegroundHistory({
    commit: (conv, ops, options) => {
      if (failWrites) throw new Error('disk full')
      return history.commit(conv, ops, options)
    },
    current: () => current,
    setCurrent: next => {
      if (current.id === next.id) current = next
      if (convA.id === next.id) convA = next
    },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    checkpoint: id => { checkpointed.push(id); stream.checkpoint(id) },
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    markPlainPersisted: id => stream.markPlainPersisted(id),
    onError: () => {},
  })

  // Conversation A fails to persist its reply at turn_end
  const ctxA = { conversationId: convA.id, sessionId: 's-a' }
  writer.userPrompt({ text: 'A 的问题', advanceCheckpoint: true })
  failWrites = true
  history.bindGeneratedCopy('s-a', 'k-a', 'assistant', 'A 的回复', [{ sources: [], fileRanges: [] }])
  for (const event of [
    { type: 'turn_started', by: 'user', context: ctxA },
    { type: 'update', context: ctxA, update: { sessionUpdate: 'viva_stream', key: 'k-a', kind: 'settle', blocks: [{ type: 'text', text: 'A 的回复' }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context: ctxA },
  ]) { stream.send(event); writer.receive(event) }
  assert.equal(writer.hasPendingWrites(), true)
  assert.equal(history.get(convA.id)!.messages.length, 1)

  // Switching to Conversation B and calling reset() must NOT drop A's pending writes
  current = convB
  writer.reset()
  assert.equal(writer.hasPendingWrites(), true)
  assert.equal(writer.retryPending(), false, 'still failing while disk is full')
  assert.equal(writer.hasPendingWrites(), true)

  // Once disk recovers, writing to Conversation B also retries and commits Conversation A + advances A's checkpoint
  failWrites = false
  writer.userPrompt({ text: 'B 的问题', advanceCheckpoint: true })
  assert.equal(writer.hasPendingWrites(), false)
  assert.deepEqual(history.get(convA.id)!.messages.map(m => m.text), ['A 的问题', 'A 的回复'])
  assert.equal(history.get(convA.id)!.messages[1]?.receipt?.stopReason, 'end_turn')
  assert.deepEqual(history.get(convB.id)!.messages.map(m => m.text), ['B 的问题'])
  assert.equal(checkpointed.filter(id => id === convA.id).length, 2, 'deferred checkpoint for A fires on retry success')
  assert.deepEqual(stream.snapshot(convA.id, ctxA).replay, [])
})

test('mid-turn plain text persisted before question_answered or userSteer is excluded from reload replay', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-mid', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-mid' }
  let failWrites = false
  const committed: string[] = []
  const writer = createForegroundHistory({
    commit: (conv, ops) => {
      if (failWrites) throw new Error('disk full')
      for (const op of ops) {
        if (op.kind === 'upsert_assistant' || op.kind === 'append_user') committed.push(`${op.message.role}:${op.message.text}`)
      }
      return conv
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    checkpoint: id => stream.checkpoint(id),
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    markPlainPersisted: id => stream.markPlainPersisted(id),
    onError: () => {},
  })

  // Plain assistant text -> tool_call -> question -> question_answered
  const turnStart = { type: 'turn_started', by: 'user', context }
  const plain1 = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先确认城市' } } }
  const tool1 = { type: 'update', context, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Lookup' } }
  const q1 = { type: 'question', questionId: 'q-mid', questions: [{ id: 'city', question: '哪个城市？' }], context }
  const ans1 = { type: 'question_answered', questionId: 'q-mid', answers: [{ id: 'city', selected: ['上海'] }], context }
  for (const event of [turnStart, plain1, tool1, q1, ans1]) { stream.send(event); writer.receive(event) }

  assert.deepEqual(committed, ['assistant:先确认城市', 'user:上海'])
  const replayAfterAnswer = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.equal(replayAfterAnswer.some(e => e.type === 'update' && (e.update as Record<string, unknown>)?.sessionUpdate === 'agent_message_chunk'), false,
    'already-persisted plain assistant chunks are excluded from mid-turn replay')
  assert.equal(replayAfterAnswer.some(e => e.type === 'update' && (e.update as Record<string, unknown>)?.sessionUpdate === 'tool_call'), true,
    'tool_call events remain in replay to rebuild tool state')
  assert.equal(replayAfterAnswer.find(e => e.type === 'question_answered')?.inHistory, true)

  // Another plain chunk followed by userSteer excludes that chunk too, while later chunks remain replayable
  const plain2 = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在整理' } } }
  stream.send(plain2)
  writer.receive(plain2)
  writer.userSteer({ text: '顺便看下天气' })
  const plain3 = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，继续' } } }
  stream.send(plain3)
  writer.receive(plain3)

  assert.deepEqual(committed, ['assistant:先确认城市', 'user:上海', 'assistant:正在整理', 'user:顺便看下天气'])
  const replayAfterSteer = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  const replayedPlainTexts = replayAfterSteer
    .filter(e => e.type === 'update' && (e.update as Record<string, unknown>)?.sessionUpdate === 'agent_message_chunk')
    .map(e => ((e.update as Record<string, unknown>).content as Record<string, unknown>).text)
  assert.deepEqual(replayedPlainTexts, ['好的，继续'], 'only unpersisted post-steer plain chunks remain in replay')

  // If persisting fails during userSteer, the plain chunk stays replayable until retry succeeds
  failWrites = true
  writer.userSteer({ text: '失败的插话' })
  const replayAfterFail = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.ok(replayAfterFail.some(e => e.type === 'update' && ((e.update as Record<string, unknown>).content as Record<string, unknown>)?.text === '好的，继续'))

  // Transient failure on question_answered followed by later events and retry still marks question_answered inHistory: true
  const q2 = { type: 'question', questionId: 'q-retry', questions: [{ id: 'confirm', question: '继续？' }], context }
  const ans2 = { type: 'question_answered', questionId: 'q-retry', answers: [{ id: 'confirm', selected: ['继续'] }], context }
  const laterTool = { type: 'update', context, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'Next' } }
  for (const event of [q2, ans2, laterTool]) { stream.send(event); writer.receive(event) }
  const beforeRetry = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.equal(beforeRetry.find(e => e.type === 'question_answered' && e.questionId === 'q-retry')?.inHistory, undefined,
    'unpersisted question_answered is not yet marked inHistory')

  failWrites = false
  assert.equal(writer.retryPending(), true)
  const afterRetry = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.equal(afterRetry.find(e => e.type === 'question_answered' && e.questionId === 'q-retry')?.inHistory, true,
    'retrying question_answered marks its earlier replay event inHistory: true by questionId')
})
