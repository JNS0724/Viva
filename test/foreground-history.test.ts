import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { createForegroundHistory } from '../src/backend/foreground-history.ts'
import { openHistoryDb, type Conversation } from '../src/backend/history-db.ts'
import { HistoryValidationError } from '../src/backend/history-schema.ts'
import { createReportRecords } from '../src/backend/report-records.ts'
import { createRendererStream } from '../src/backend/renderer-stream.ts'
import { CONVERSATION_WINDOW_MESSAGES } from '../src/shared/renderer-sync.ts'
import { SILENT_REPLY } from '../src/shared/task-report.ts'
import { CONVERSATION_WINDOW_LIMIT, initialState, reduce } from '../src/renderer/state.ts'
import type { ConversationUpdate } from '../src/renderer/conversation-types.ts'
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

  // 1. User prompt with images and idempotent duplicate sourceId; identical text after a legacy sourceId-less user row still appends a new row
  const legacy = history.create({ sessionId: 's-legacy', mode: 'live', model: 'V4', cwd: '/w' })
  history.save(legacy, [{ role: 'user', text: '重复提问', receipt: null }])
  const freshSource = randomUUID()
  history.commit(legacy, [{ kind: 'append_user', message: { role: 'user', text: '重复提问', receipt: null, sourceId: freshSource } }])
  const legacyAfter = history.get(legacy.id)!.messages
  assert.equal(legacyAfter.length, 2, 'normal append_user must not merge into an older user row that has no sourceId')
  assert.equal(legacyAfter[0]?.sourceId, undefined)
  assert.equal(legacyAfter[1]?.sourceId, freshSource)

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
        folds: [
          { id: 'f-root', at: 0, count: 3, kind: 'path' },
          { id: 'f-before', at: 120, count: 2, kind: 'path' },
          { id: 'f-1', at: 401, count: 2, kind: 'path' },
        ],
      },
    },
  })
  assert.equal(state.historyOffset, 400)
  assert.equal(state.restored?.count, 402)
  assert.equal(state.messages[0]?.id, 'm400')
  assert.deepEqual(rewindTarget(state, 'm400'), { words: '旧问题', occurrence: 0, keep: 400 })
  assert.deepEqual(foldAfter(state)['']?.map(f => f.id), ['f-root', 'f-before'], 'root and pre-window folds stay anchored at top of visible window')
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

  // 2. Very long keyed viva_stream reply (> 2_000_000 chars) persists cleanly and survives rewind copy via db.save()
  const longText = 'y'.repeat(2_050_000)
  history.bindGeneratedCopy('s-err', 'k-long', 'assistant', longText, [{ sources: [], fileRanges: [] }])
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-long', kind: 'settle', blocks: [{ type: 'text', text: longText }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]) { stream.send(event); writer.receive(event) }
  assert.equal(history.get(current.id)!.messages.at(-1)?.text.length, 2_050_000)

  // Rewinding a later user message copies the long assistant reply through db.save() without failing validation
  const keptBeforeRewind = history.get(current.id)!.messages
  const forked = history.create({ sessionId: 's-fork', mode: 'live', model: 'V4', cwd: '/w', parentId: current.id })
  const copied = history.save(forked, [...keptBeforeRewind, { role: 'user', text: '重说这句', receipt: null }], {
    copy: { from: current.id, count: keptBeforeRewind.length },
  })
  assert.equal(history.get(copied.id)!.messages.at(-2)?.text.length, 2_050_000)
  assert.equal(history.get(copied.id)!.messages.at(-1)?.text, '重说这句')

  // 3. Permanently invalid payload (HistoryValidationError, e.g. stream key > 1000 chars) never poisons pendingWrites AND pins checkpoint behind the gap
  const invalidKey = 'k'.repeat(1001)
  const beforeInvalidCheckpoints = checkpoints
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: invalidKey, kind: 'settle', blocks: [{ type: 'text', text: '异常键回复' }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]) { stream.send(event); writer.receive(event) }
  assert.equal(errors.length, 3)
  assert.equal(checkpoints, beforeInvalidCheckpoints, 'validation failure never advances checkpoint')
  assert.equal(writer.hasPendingWrites(), false, 'permanent validation failure does not poison pendingWrites')
  assert.equal(stream.snapshot(current.id, context).replay.length, 3, 'unpersisted invalid turn remains in replay buffer')

  // Subsequent user prompt and assistant reply still persist to SQLite, while checkpoint stays pinned behind the gap!
  writer.userPrompt({ text: '后续正常提问', advanceCheckpoint: true })
  history.bindGeneratedCopy('s-err', 'k-next', 'assistant', '后续正常回复', [{ sources: [], fileRanges: [] }])
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-next', kind: 'settle', blocks: [{ type: 'text', text: '后续正常回复' }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]) { stream.send(event); writer.receive(event) }
  const afterRecovery = history.get(current.id)!.messages
  assert.equal(afterRecovery.at(-2)?.text, '后续正常提问')
  assert.equal(afterRecovery.at(-1)?.text, '后续正常回复')
  assert.equal(checkpoints, beforeInvalidCheckpoints, 'later turns never advance checkpoint past an unpersisted gap')
  assert.ok(stream.snapshot(current.id, context).replay.length >= 3, 'unpersisted turn is never silently skipped by later checkpoints')
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

test('retrying an earlier pending write advances checkpoint and plain dedup only to the queued cursor', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-cur', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-cur' }
  let failWrites = false
  const committed: string[] = []
  const writer = createForegroundHistory({
    commit: (conv, ops) => {
      if (failWrites) throw new Error('sqlite busy')
      for (const op of ops) {
        if (op.kind === 'upsert_assistant' || op.kind === 'append_user') committed.push(`${op.message.role}:${op.message.text}`)
      }
      return conv
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    markPlainPersisted: (id, upToCursor) => stream.markPlainPersisted(id, upToCursor),
    onError: () => {},
  })

  // 1. Turn 1 ends and fails transiently at turn_end -> checkpointPending captures Turn 1's cursor
  failWrites = true
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一轮回复' } } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]) { stream.send(event); writer.receive(event) }

  // Turn 2 starts and streams plain text that is still buffered in active.plainText (unpersisted!)
  for (const event of [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二轮进行中' } } },
  ]) { stream.send(event); writer.receive(event) }

  // Disk recovers and retryPending() commits Turn 1: checkpoint advances ONLY to Turn 1's cursor!
  failWrites = false
  assert.equal(writer.retryPending(), true)
  assert.deepEqual(committed, ['assistant:第一轮回复'])
  const replayAfterTurn1Retry = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.equal(replayAfterTurn1Retry.length, 2, 'Turn 2 events remain replayable after Turn 1 retry')
  assert.equal(replayAfterTurn1Retry[0]?.type, 'turn_started')
  assert.equal(((replayAfterTurn1Retry[1]?.update as Record<string, unknown>)?.content as Record<string, unknown>)?.text, '第二轮进行中')

  // 2. Mid-turn userSteer fails transiently while draining '第二轮进行中' -> plainPersistedPending captures C1
  failWrites = true
  writer.userSteer({ text: '插话' })
  // Later plain chunk arrives at C2 > C1
  const laterPlain = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '插话后的新文本' } } }
  stream.send(laterPlain)
  writer.receive(laterPlain)

  // Retry commits '第二轮进行中' + '插话' and skips ONLY plain chunks <= C1; '插话后的新文本' stays replayable!
  failWrites = false
  assert.equal(writer.retryPending(), true)
  assert.deepEqual(committed, ['assistant:第一轮回复', 'assistant:第二轮进行中', 'user:插话'])
  const replayAfterSteerRetry = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  const plainTexts = replayAfterSteerRetry
    .filter(e => e.type === 'update' && (e.update as Record<string, unknown>)?.sessionUpdate === 'agent_message_chunk')
    .map(e => ((e.update as Record<string, unknown>).content as Record<string, unknown>).text)
  assert.deepEqual(plainTexts, ['插话后的新文本'])
})

test('mid-turn reload with >200 settled viva_stream messages skips out-of-window stream text without losing thoughts', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-wide', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-wide' }
  const writer = createForegroundHistory({
    commit: history.commit,
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    markPlainPersisted: (id, upToCursor) => stream.markPlainPersisted(id, upToCursor),
    onError: err => { throw err },
  })

  const total = CONVERSATION_WINDOW_MESSAGES + 5
  const startEvent = { type: 'turn_started', by: 'user', context }
  stream.send(startEvent)
  writer.receive(startEvent)
  for (let i = 0; i < total; i += 1) {
    const key = `k-${i}`
    const text = `第 ${i} 条`
    history.bindGeneratedCopy('s-wide', key, 'assistant', text, [{ sources: [], fileRanges: [] }])
    const blocks = i === 0
      ? [{ type: 'reasoning', text: '首条推理' }, { type: 'text', text }]
      : [{ type: 'text', text }]
    const settle = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key, kind: 'settle', blocks } }
    stream.send(settle)
    writer.receive(settle)
  }

  // Reload mid-turn before turn_end: snapshot returns the trailing 200 messages + filtered replay
  const tail = history.getTail(current.id, CONVERSATION_WINDOW_MESSAGES)!
  assert.equal(tail.offset, 5)
  assert.equal(tail.total, total)
  const hiddenKeys = history.streamKeysBefore(current.id, tail.offset)
  assert.deepEqual([...hiddenKeys].sort(), ['k-0', 'k-1', 'k-2', 'k-3', 'k-4'])

  const snap = stream.snapshot(current.id, context, false, hiddenKeys)
  // Out-of-window k-1..k-4 have no reasoning blocks and are omitted; k-0 retains ONLY its reasoning block
  assert.equal(snap.replay.some(e => e.type === 'update' && (e.update as Record<string, unknown>)?.key === 'k-1'), false)
  const k0Replay = snap.replay.find(e => e.type === 'update' && (e.update as Record<string, unknown>)?.key === 'k-0')
  assert.ok(k0Replay, 'out-of-window stream with reasoning still replays its reasoning block')
  assert.deepEqual(((k0Replay.update as Record<string, unknown>).blocks as Array<Record<string, unknown>>).map(b => b.type), ['reasoning'])

  // Reduce snapshot + replay in renderer state: no out-of-window text is re-appended and thoughts stay intact
  let state: State = reduce(initialState, {
    type: 'initialization_snapshot',
    snapshot: {
      streamGeneration: snap.streamGeneration,
      cutoverCursor: snap.cutoverCursor,
      context,
      info: { mode: 'live', model: 'V4', cwd: '/w', conversationId: current.id, sessionId: 's-wide' },
      replay: [],
      history: {
        id: tail.conversation.id,
        createdAt: tail.conversation.createdAt,
        updatedAt: tail.conversation.updatedAt,
        parentId: tail.conversation.parentId,
        offset: tail.offset,
        total: tail.total,
        messages: tail.messages,
        records: tail.records,
        folds: [],
      },
    },
  })
  for (const event of snap.replay) {
    if (event.type === 'turn_started') state = reduce(state, { type: 'agent_turn_started', by: 'user', at: 100 })
    else if (event.type === 'update') state = reduce(state, { type: 'acp_update', update: event.update as ConversationUpdate, at: 101 })
  }
  assert.equal(state.historyOffset, 5)
  assert.equal(state.messages.length, CONVERSATION_WINDOW_MESSAGES)
  assert.equal(state.historyOffset + state.messages.length, total, 'total count stays exact without duplicate appends')
  assert.equal(state.messages[0]?.text, '第 5 条')
  assert.equal(state.messages.at(-1)?.text, `第 ${total - 1} 条`)
  assert.equal(state.thoughts.length, 1)
  assert.equal(state.thoughts[0]?.text, '首条推理')
})

test('userPrompt queued mid-turn after assistant output updates lastTurnMessage so turn_end appends a note like renderer', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-report', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-report' }
  const writer = createForegroundHistory({
    commit: history.commit,
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    onError: err => { throw err },
  })

  // Background report turn outputs assistant text, then user submits a queued image prompt before report turn ends
  writer.receive({ type: 'turn_started', by: 'task', context })
  history.bindGeneratedCopy('s-report', 'k-rep', 'assistant', '后台报告正文', [{ sources: [], fileRanges: [] }])
  writer.receive({
    type: 'update', context,
    update: { sessionUpdate: 'viva_stream', key: 'k-rep', kind: 'settle', blocks: [{ type: 'text', text: '后台报告正文' }] },
  })
  const picId = `${'b'.repeat(64)}.png`
  const queuedSource = randomUUID()
  writer.userPrompt({ text: '顺便看下这张图', images: [{ id: picId }], sourceId: queuedSource })
  writer.receive({ type: 'turn_end', stopReason: 'end_turn', finalReply: true, context })

  const stored = history.get(current.id)!.messages
  assert.equal(stored.length, 3, 'backend appends a turn note after the queued user message, matching renderer')
  assert.equal(stored[0]?.role, 'assistant')
  assert.equal(stored[0]?.receipt, null, 'earlier assistant message does not steal the receipt after a queued user prompt')
  assert.equal(stored[1]?.role, 'user')
  assert.equal(stored[1]?.text, '顺便看下这张图')
  assert.deepEqual(stored[1]?.images, [{ id: picId }])
  assert.equal(stored[2]?.role, 'note')
  assert.equal(stored[2]?.receipt?.stopReason, 'end_turn')
})

test('long unfinished turn reclaims persisted viva_stream events so mid-turn reload avoids false replay gaps', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-long', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-long' }
  const writer = createForegroundHistory({
    commit: history.commit,
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markQuestionPersisted: (id, qid) => stream.markQuestionPersisted(id, qid),
    markPlainPersisted: (id, upToCursor) => stream.markPlainPersisted(id, upToCursor),
    markStreamPersisted: (id, key, upToCursor) => stream.markStreamPersisted(id, key, upToCursor),
    onError: err => { throw err },
  })

  const startEvent = { type: 'turn_started', by: 'user', context }
  stream.send(startEvent)
  writer.receive(startEvent)

  // Emit 260 settled messages * (4 deltas + 1 settle) = 1,300 events and >2.6 MiB of text in one unfinished turn.
  // Message 250 also carries a reasoning block (in-window); message 0 carries a reasoning block (out-of-window);
  // plus a reasoning-only stream with deltas.
  const total = 260
  const chunk = '长文片段'.repeat(650) // ~2.6 KiB per delta (~10.4 KiB per settled message, >2.6 MiB across 260 messages)
  for (let i = 0; i < total; i += 1) {
    const key = `long-${i}`
    const fullText = `第${i}条:${chunk}${chunk}${chunk}${chunk}`
    for (let d = 0; d < 4; d += 1) {
      const delta = {
        type: 'update', context,
        update: { sessionUpdate: 'viva_stream', key, kind: 'delta', index: 0, blockType: 'text', text: d === 0 ? `第${i}条:${chunk}` : chunk },
      }
      stream.send(delta)
      writer.receive(delta)
    }
    history.bindGeneratedCopy('s-long', key, 'assistant', fullText, [{ sources: [], fileRanges: [] }])
    const blocks = (i === 0 || i === 250)
      ? [{ type: 'reasoning', text: `推理-${i}` }, { type: 'text', text: fullText }]
      : [{ type: 'text', text: fullText }]
    const settle = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key, kind: 'settle', blocks } }
    stream.send(settle)
    writer.receive(settle)
  }
  // Reasoning-only tool step with deltas should also collapse to a single durable settle
  for (let d = 0; d < 10; d += 1) {
    const delta = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'r-only', kind: 'delta', index: 0, blockType: 'reasoning', text: '思考' } }
    stream.send(delta)
    writer.receive(delta)
  }
  const rSettle = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'r-only', kind: 'settle', blocks: [{ type: 'reasoning', text: '仅推理' }] } }
  stream.send(rSettle)
  writer.receive(rSettle)

  // Mid-turn reload succeeds without throwing 'unreplayable gap'
  const tail = history.getTail(current.id, CONVERSATION_WINDOW_MESSAGES)!
  assert.equal(tail.offset, total - CONVERSATION_WINDOW_MESSAGES)
  assert.equal(tail.total, total)
  const hiddenKeys = history.streamKeysBefore(current.id, tail.offset)
  const snap = stream.snapshot(current.id, context, false, hiddenKeys)
  assert.equal(snap.replay[0]?.type, 'turn_started', 'turn_started stays intact in replay buffer')

  let state: State = reduce(initialState, {
    type: 'initialization_snapshot',
    snapshot: {
      streamGeneration: snap.streamGeneration,
      cutoverCursor: snap.cutoverCursor,
      context,
      info: { mode: 'live', model: 'V4', cwd: '/w', conversationId: current.id, sessionId: 's-long' },
      replay: [],
      history: {
        id: tail.conversation.id,
        createdAt: tail.conversation.createdAt,
        updatedAt: tail.conversation.updatedAt,
        parentId: tail.conversation.parentId,
        offset: tail.offset,
        total: tail.total,
        messages: tail.messages,
        records: tail.records,
        folds: [],
      },
    },
  })
  for (const event of snap.replay) {
    if (event.type === 'turn_started') state = reduce(state, { type: 'agent_turn_started', by: 'user', at: 100 })
    else if (event.type === 'update') state = reduce(state, { type: 'acp_update', update: event.update as ConversationUpdate, at: 101 })
  }
  assert.equal(state.phase, 'working')
  assert.equal(state.messages.length, CONVERSATION_WINDOW_MESSAGES)
  assert.equal(state.messages.some(m => m.streamKey === 'long-250' && m.text.startsWith('第250条:')), true,
    'in-window persisted message with reasoning block is NOT deleted when its reasoning-only settle replays')
  assert.deepEqual(state.thoughts.map(item => item.text), ['推理-0', '推理-250', '仅推理'])
})

test('unpersisted stream overflow when commit fails still triggers unreplayable gap on mid-turn reload', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-gap', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-gap' }
  const writer = createForegroundHistory({
    commit: () => { throw new Error('sqlite busy') },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markStreamPersisted: (id, key, upToCursor) => stream.markStreamPersisted(id, key, upToCursor),
    onError: () => {},
  })

  const startEvent = { type: 'turn_started', by: 'user', context }
  stream.send(startEvent)
  writer.receive(startEvent)
  for (let i = 0; i < 1050; i += 1) {
    const settle = {
      type: 'update', context,
      update: { sessionUpdate: 'viva_stream', key: `fail-${i}`, kind: 'settle', blocks: [{ type: 'text', text: `未落盘-${i}` }] },
    }
    stream.send(settle)
    writer.receive(settle)
  }
  assert.throws(() => stream.snapshot(current.id, context), /unreplayable gap/)
})

test('evicting >1024 durable reasoning settles drops oldest durable thoughts without losing turn_started', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-durable', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-durable' }
  const writer = createForegroundHistory({
    commit: history.commit,
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markStreamPersisted: (id, key, upToCursor) => stream.markStreamPersisted(id, key, upToCursor),
    onError: err => { throw err },
  })

  const startEvent = { type: 'turn_started', by: 'user', context }
  stream.send(startEvent)
  writer.receive(startEvent)
  for (let i = 0; i < 1050; i += 1) {
    const settle = {
      type: 'update', context,
      update: { sessionUpdate: 'viva_stream', key: `r-${i}`, kind: 'settle', blocks: [{ type: 'reasoning', text: `r-${i}` }] },
    }
    stream.send(settle)
    writer.receive(settle)
  }
  const snap = stream.snapshot(current.id, context)
  assert.equal(snap.replay[0]?.type, 'turn_started', 'non-durable turn_started is preserved while oldest durable thoughts evict')
  assert.equal(snap.replay.length, 1024)
})

test('transient write failure on final turn_end retries automatically with backoff and cancels timer on success or close', async t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-backoff', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-backoff' }
  let attempts = 0
  const checkpoints: Array<{ id: string, cursor?: number }> = []
  const writer = createForegroundHistory({
    commit: (conv, ops, opts) => {
      attempts += 1
      if (attempts <= 3) throw new Error('sqlite busy')
      return history.commit(conv, ops, opts)
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, cursor) => { checkpoints.push({ id, cursor }); stream.checkpoint(id, cursor) },
    onError: () => {},
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 40,
  })
  t.after(() => writer.close())

  // Simulate a complete turn whose final turn_end commit fails transiently, followed by zero user activity.
  history.bindGeneratedCopy('s-backoff', 'k-backoff', 'assistant', '延迟重试落盘回复', [{ sources: [], fileRanges: [] }])
  const events = [
    { type: 'turn_started', by: 'user', context },
    { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-backoff', kind: 'settle', blocks: [{ type: 'text', text: '延迟重试落盘回复' }] } },
    { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context },
  ]
  for (const event of events) { stream.send(event); writer.receive(event) }
  assert.equal(writer.hasPendingWrites(), true)
  assert.equal(attempts, 2, 'settle + turn_end both failed transiently while SQLite was busy')
  assert.equal(checkpoints.length, 0)

  // Wait for automatic backoff retry without calling retryPending() or flush().
  const deadline = Date.now() + 1000
  while (writer.hasPendingWrites() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(writer.hasPendingWrites(), false, 'automatic backoff retry drains pending writes while idle')
  assert.equal(attempts, 4, 'multi-step backoff retries commit the queued settle + receipt automatically')
  assert.equal(checkpoints.length, 1, 'checkpoint advances once the automatic retry commits')
  const stored = history.get(current.id)!.messages
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.text, '延迟重试落盘回复')
  assert.equal(stored[0]?.receipt?.stopReason, 'end_turn')

  // Verify close() cancels any pending retry timer so no further attempts fire after close.
  let postCloseAttempts = 0
  const closingWriter = createForegroundHistory({
    commit: () => { postCloseAttempts += 1; throw new Error('still busy') },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    onError: () => {},
    retryBaseDelayMs: 15,
    retryMaxDelayMs: 30,
  })
  closingWriter.userPrompt({ text: '关闭前失败' })
  assert.equal(postCloseAttempts, 1)
  closingWriter.close()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(postCloseAttempts, 1, 'close() cancels scheduled retry timer')
})

test('HistoryValidationError isolates only invalid ops while preserving carried and sibling valid ops in order', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-iso', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-iso' }
  let failTransient = true
  let transientOnValid3 = false
  const errors: unknown[] = []
  const checkpoints: string[] = []
  const writer = createForegroundHistory({
    commit: (conv, ops, opts) => {
      if (failTransient) throw new Error('sqlite busy')
      if (transientOnValid3 && ops.length === 1 && ops[0]?.kind === 'append_user' && ops[0].message.text.includes('有效回答3')) {
        transientOnValid3 = false
        throw new Error('sqlite busy mid-isolation')
      }
      return history.commit(conv, ops, opts)
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: id => { checkpoints.push(id); stream.checkpoint(id) },
    onError: err => { errors.push(err) },
    retryBaseDelayMs: 1000,
  })
  t.after(() => writer.close())

  // 1. Queue a valid userPrompt behind a transient SQLite failure
  writer.userPrompt({ text: '先前排队的问题' })
  assert.equal(writer.hasPendingWrites(), true)
  assert.equal(history.get(current.id), null)

  // 2. DB recovers, and a question_answered batch arrives with [valid1, oversized invalid2, valid3]
  //    plus a transient hiccup on valid3 mid-isolation to exercise partial tail queueing too.
  failTransient = false
  transientOnValid3 = true
  const qEvent = {
    type: 'question', context, questionId: 'q-iso',
    questions: [
      { id: 'q1', header: 'Q1', question: '第一题' },
      { id: 'q2', header: 'Q2', question: '第二题' },
      { id: 'q3', header: 'Q3', question: '第三题' },
    ],
  }
  const ansEvent = {
    type: 'question_answered', context, questionId: 'q-iso',
    sourceIds: { q1: randomUUID(), q2: randomUUID(), q3: randomUUID() },
    answers: [
      { id: 'q1', selected: ['有效回答1'] },
      { id: 'q2', selected: ['超长'.repeat(120_000)] },
      { id: 'q3', selected: ['有效回答3'] },
    ],
  }
  for (const event of [qEvent, ansEvent]) { stream.send(event); writer.receive(event) }

  // Carried userPrompt + valid1 committed immediately; invalid2 isolated; only valid3 stays queued for retry!
  assert.deepEqual(
    history.get(current.id)!.messages.map(m => m.text),
    ['先前排队的问题', '有效回答1'],
  )
  assert.equal(writer.hasPendingWrites(), true, 'only the unexecuted tail after mid-isolation transient error remains queued')

  // Retry commits ONLY valid3 without duplicating carried userPrompt or valid1, and keeps checkpoint pinned behind the gap
  assert.equal(writer.retryPending(), true)
  assert.equal(writer.hasPendingWrites(), false)
  assert.deepEqual(
    history.get(current.id)!.messages.map(m => m.text),
    ['先前排队的问题', '有效回答1', '有效回答3'],
    'carried and sibling valid ops persist in exact order while invalid op is isolated',
  )
  writer.receive({ type: 'turn_end', stopReason: 'end_turn', finalReply: true, context })
  assert.equal(checkpoints.length, 0, 'checkpoint stays pinned behind the isolated validation gap')
  assert.equal(errors.some(err => err instanceof HistoryValidationError), true)
})

test('single long viva_stream overflowing before settle clears its loss once persisted while keeping other stream gaps', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-single-big', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-single-big' }
  const writer = createForegroundHistory({
    commit: history.commit,
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => current.sessionId,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markStreamPersisted: (id, key, upToCursor) => stream.markStreamPersisted(id, key, upToCursor),
    onError: err => { throw err },
  })
  t.after(() => writer.close())

  const startEvent = { type: 'turn_started', by: 'user', context }
  stream.send(startEvent)
  writer.receive(startEvent)

  // 1. Stream k-1 emits 1,100 deltas (>1024 count & >2 MiB bytes) before settling, plus k-2 also overflows provisional deltas
  const piece = '长流片'.repeat(400)
  for (let i = 0; i < 1100; i += 1) {
    const delta = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-1', kind: 'delta', index: 0, blockType: 'text', text: piece } }
    stream.send(delta)
    writer.receive(delta)
  }
  for (let i = 0; i < 1100; i += 1) {
    const delta = { type: 'update', context, update: { sessionUpdate: 'viva_stream', key: 'k-2', kind: 'delta', index: 0, blockType: 'text', text: piece } }
    stream.send(delta)
    writer.receive(delta)
  }

  // Before either stream settles, mid-turn reload MUST still detect an unreplayable gap
  assert.throws(() => stream.snapshot(current.id, context), /unreplayable gap/)

  // Settling k-1 clears k-1's loss, but k-2's unsettled loss MUST keep snapshot failing
  const k1Text = '最终长回复-1'
  history.bindGeneratedCopy('s-single-big', 'k-1', 'assistant', k1Text, [{ sources: [], fileRanges: [] }])
  const settle1 = {
    type: 'update', context,
    update: { sessionUpdate: 'viva_stream', key: 'k-1', kind: 'settle', blocks: [{ type: 'reasoning', text: '完整推理-1' }, { type: 'text', text: k1Text }] },
  }
  stream.send(settle1)
  writer.receive(settle1)
  assert.throws(() => stream.snapshot(current.id, context), /unreplayable gap/, 'unsettled k-2 loss remains active')

  // Once k-2 settles and persists, both stream losses are cleared and turn_started is still intact
  const k2Text = '最终长回复-2'
  history.bindGeneratedCopy('s-single-big', 'k-2', 'assistant', k2Text, [{ sources: [], fileRanges: [] }])
  const settle2 = {
    type: 'update', context,
    update: { sessionUpdate: 'viva_stream', key: 'k-2', kind: 'settle', blocks: [{ type: 'text', text: k2Text }] },
  }
  stream.send(settle2)
  writer.receive(settle2)

  const snapAfterBoth = stream.snapshot(current.id, context)
  assert.equal(snapAfterBoth.replay[0]?.type, 'turn_started')
  assert.deepEqual(history.get(current.id)!.messages.map(m => m.text), [k1Text, k2Text])

  // 2. A single >2 MiB settle itself triggers eviction inside stream.send() before writer.receive();
  //    once writer.receive() commits it, its stream loss clears and turn_started stays intact.
  const hugeText = '超长回复'.repeat(300_000) // ~1.2M chars -> ~2.4 MiB UTF-16 > 2 MiB replay byte limit
  history.bindGeneratedCopy('s-single-big', 'k-huge', 'assistant', hugeText, [{ sources: [], fileRanges: [] }])
  const hugeSettle = {
    type: 'update', context,
    update: { sessionUpdate: 'viva_stream', key: 'k-huge', kind: 'settle', blocks: [{ type: 'text', text: hugeText }] },
  }
  stream.send(hugeSettle)
  assert.throws(() => stream.snapshot(current.id, context), /unreplayable gap/, 'oversized settle is gated before commit')
  writer.receive(hugeSettle)
  const snapAfterHuge = stream.snapshot(current.id, context)
  assert.equal(snapAfterHuge.replay[0]?.type, 'turn_started')
  assert.equal(history.get(current.id)!.messages.at(-1)?.text.length, hugeText.length)
})

test('report_delivered flushes and closes buffered plain assistant text before recording report, matching renderer', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: null, mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-rep-split' }
  const committedTexts: string[] = []
  const attachedReceipts: Array<string | undefined> = []
  const writer = createForegroundHistory({
    commit: (conv, ops) => {
      for (const op of ops) {
        if (op.kind === 'upsert_assistant') committedTexts.push(op.message.text)
        if (op.kind === 'attach_receipt') attachedReceipts.push(op.receipt.stopReason)
      }
      return history.commit(conv, ops, { sourceSession: null })
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => null,
    streamCursor: () => stream.cursor(),
    checkpoint: (id, upToCursor) => stream.checkpoint(id, upToCursor),
    markPlainPersisted: (id, upToCursor) => stream.markPlainPersisted(id, upToCursor),
    onError: err => { throw err },
  })
  t.after(() => writer.close())

  // 1. Assistant streams plain text before report arrives
  const startEvent = { type: 'turn_started', by: 'user', context }
  const chunk1 = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回报前的第一段' } } }
  for (const event of [startEvent, chunk1]) { stream.send(event); writer.receive(event) }

  // 2. report_delivered arrives (e.g. written -> drawOn): must persist & close first segment BEFORE addRecord runs
  const report1 = {
    type: 'report_delivered', conversationId: current.id, sessionId: 's-rep-split',
    reportId: 'rep-1', text: '后台任务完成', at: 500, context,
  }
  stream.send(report1)
  writer.receive(report1)
  assert.deepEqual(committedTexts, ['回报前的第一段'])
  assert.equal(history.get(current.id)!.messages.length, 1)

  // Mid-turn reload right after report_delivered does not replay already-persisted first segment
  const replayAfterReport1 = stream.snapshot(current.id, context).replay as Array<Record<string, unknown>>
  assert.equal(
    replayAfterReport1.some(e => e.type === 'update' && (e.update as Record<string, unknown>)?.sessionUpdate === 'agent_message_chunk'),
    false,
    'persisted plain chunk before report is reclaimed from replay',
  )

  // 3. Assistant starts streaming second segment; then read() records rep-1 and emits duplicate report_delivered(rep-1)
  const chunk2a = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回报后前半' } } }
  stream.send(chunk2a)
  writer.receive(chunk2a)
  writer.beforeReportRecord(current.id, 'rep-1')
  history.addRecord({ conversationId: current.id, reportId: 'rep-1', at: 500, text: '后台任务完成' })
  stream.send(report1)
  writer.receive(report1) // duplicate reportId must NOT split the open second segment!
  const chunk2b = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回报后后半' } } }
  stream.send(chunk2b)
  writer.receive(chunk2b)

  // 4. Direct read() path without prior written(): beforeReportRecord flushes second segment before addRecord
  writer.beforeReportRecord(current.id, 'rep-2')
  history.addRecord({ conversationId: current.id, reportId: 'rep-2', at: 600, text: '第二条后台汇报' })
  const report2 = {
    type: 'report_delivered', conversationId: current.id, sessionId: 's-rep-split',
    reportId: 'rep-2', text: '第二条后台汇报', at: 600, context,
  }
  stream.send(report2)
  writer.receive(report2)
  const chunk3 = { type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '最终收尾段' } } }
  const endEvent = { type: 'turn_end', stopReason: 'end_turn', finalReply: true, context }
  for (const event of [chunk3, endEvent]) { stream.send(event); writer.receive(event) }

  // Compare persisted SQLite message count + committed segments/receipt + report records against renderer reducer output
  const stored = history.get(current.id)!
  assert.deepEqual(committedTexts, ['回报前的第一段', '回报后前半回报后后半', '最终收尾段'])
  assert.deepEqual(attachedReceipts, ['end_turn'])
  assert.equal(stored.messages.length, 3)
  assert.deepEqual(stored.records.map(r => ({ reportId: r.reportId, after: r.after })), [
    { reportId: 'rep-1', after: 1 },
    { reportId: 'rep-2', after: 2 },
  ])

  let viewState: State = { ...initialState, conversationId: current.id, info: { ...initialState.info, sessionId: 's-rep-split' } }
  viewState = reduce(viewState, { type: 'agent_turn_started', by: 'user', at: 100 })
  viewState = reduce(viewState, { type: 'acp_update', update: chunk1.update as ConversationUpdate, at: 110 })
  viewState = reduce(viewState, { type: 'report_delivered', conversationId: current.id, sessionId: 's-rep-split', reportId: 'rep-1', text: '后台任务完成', at: 500 })
  viewState = reduce(viewState, { type: 'acp_update', update: chunk2a.update as ConversationUpdate, at: 510 })
  viewState = reduce(viewState, { type: 'report_delivered', conversationId: current.id, sessionId: 's-rep-split', reportId: 'rep-1', text: '后台任务完成', at: 500 })
  viewState = reduce(viewState, { type: 'acp_update', update: chunk2b.update as ConversationUpdate, at: 520 })
  viewState = reduce(viewState, { type: 'report_delivered', conversationId: current.id, sessionId: 's-rep-split', reportId: 'rep-2', text: '第二条后台汇报', at: 600 })
  viewState = reduce(viewState, { type: 'acp_update', update: chunk3.update as ConversationUpdate, at: 610 })
  viewState = reduce(viewState, { type: 'turn_end', stopReason: 'end_turn', finalReply: true, at: 700 })
  assert.deepEqual(viewState.messages.map(m => m.text), committedTexts)
  assert.deepEqual(
    viewState.records.map(r => ({ reportId: r.reportId, after: r.after })),
    stored.records.map(r => ({ reportId: r.reportId, after: r.after })),
  )
})

test('report-records defers recording when foreground plain flush fails transiently, then anchors after retry succeeds', t => {
  const { db, history } = openMemoryHistory(t)
  const stream = createRendererStream(() => {}, db)
  let current: Conversation = history.create({ sessionId: 's-rep-defer', mode: 'live', model: 'V4', cwd: '/w' })
  const context = { conversationId: current.id, sessionId: 's-rep-defer' }
  let failCommit = true
  let drainedCount = 0
  const writer = createForegroundHistory({
    commit: (conv, ops) => {
      if (failCommit) throw new Error('sqlite busy')
      return history.commit(conv, ops, { sourceSession: null })
    },
    current: () => current,
    setCurrent: next => { current = next },
    agentInfo: () => ({ mode: 'live', model: 'V4' }),
    sourceSession: () => null,
    streamCursor: () => stream.cursor(),
    messageCount: id => history.getTail(id, 0)?.total ?? 0,
    onPendingDrained: () => { drainedCount += 1 },
    onError: () => {},
    retryBaseDelayMs: 1000,
  })
  t.after(() => writer.close())

  // Minimal in-memory effect stub for createReportRecords.read()
  let finished = false
  const effect = {
    id: 1, kind: 'task.report', key: 'rep-defer', generation: 1,
    payload: {
      taskId: 't-1', runId: 'r-1', status: 'done', title: '报告', host: current.id,
      output: '汇总完成', token: 'a'.repeat(32), deliveredTo: 's-rep-defer', via: 'steer' as const,
    },
    attempts: 0, nextAt: 0, createdAt: 100, updatedAt: 100,
  }
  const effects = {
    get: () => (finished ? null : effect),
    holds: () => !finished,
    finishGeneration: () => { finished = true; return true },
    amend: () => true,
  }
  const shown: unknown[] = []
  const records = createReportRecords({
    history: () => history,
    effects: () => effects,
    apply: (_kind, _payload, run) => ({ seq: 1, value: run() }),
    current: () => current,
    show: event => { shown.push(event) },
    beforeRecord: (conversationId, reportId) => writer.beforeReportRecord(conversationId, reportId),
    now: () => 500,
  })

  // 1. Assistant emits plain text A before report arrives, then SQLite is transiently busy during report read
  writer.receive({ type: 'turn_started', by: 'user', context })
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回报前的正文A' } } })

  assert.throws(
    () => records.read(effect as never),
    /pending writes/,
    'report-records defers recording instead of anchoring at after_seq=0 while preceding text failed to persist',
  )
  assert.equal(finished, false, 'effect stays queued for retry')
  assert.equal(history.recordsOf(current.id).length, 0, 'no premature report record written at seq 0')
  assert.equal(writer.hasPendingWrites(), true)

  // 2. Database recovers and assistant text B commits BEFORE records.read() retries:
  //    A commits first (resolving rep-defer's anchor at seq 1), then B commits (total = 2).
  failCommit = false
  writer.receive({ type: 'update', context, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回报后的正文B' } } })
  writer.receive({ type: 'turn_end', stopReason: 'end_turn', finalReply: true, context })
  assert.equal(writer.hasPendingWrites(), false)
  assert.equal(drainedCount, 1, 'onPendingDrained wakes effects once pending writes clear')
  assert.equal(history.get(current.id)!.messages.length, 2, 'both A and B are persisted before report retry runs')

  // 3. Report retry runs AFTER B is already persisted -> must still anchor at after_seq = 1 (A -> report -> B)!
  records.read(effect as never)
  assert.equal(finished, true)
  assert.equal(shown.length, 1)
  assert.deepEqual(
    history.recordsOf(current.id).map(r => ({ reportId: r.reportId, after: r.after })),
    [{ reportId: 'rep-defer', after: 1 }],
    'report record keeps its original anchor (after A, before B) even when B commits before report retry',
  )
})
