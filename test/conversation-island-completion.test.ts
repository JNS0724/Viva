import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from './fixtures/task-window.ts'
import { islandView } from '../src/renderer/island-view.ts'
import { historyMessages, catMood } from '../src/renderer/selectors.ts'
import { decodeAgentEvent } from '../src/renderer/agent-event-decoder.ts'
import { createEventActions } from '../src/renderer/agent-event-actions.ts'

const start = () => reduce(reduce(initialState, {
  type: 'ready', info: { mode: 'live', sessionId: 'main-session', model: 'test-model', cwd: '/test', reason: '' },
}), { type: 'user_prompt', text: 'Complete the multi-step task', at: 100 })

const task = (state: State) => reduce(state, {
  type: 'task_started', at: 110,
  task: { id: 'background-task', title: 'Multi-step task', words: 'Synthetic test data' },
})

test('delegation stays working through background execution and result delivery until the final reply ends', () => {
  let state = reduce(task(start()), { type: 'turn_end', stopReason: 'end_turn', at: 120 })
  assert.equal(islandView(state).form, 'working', 'ending the delegation turn does not complete the task')
  assert.equal(islandView(state).label, '后台执行中')

  state = reduce(state, { type: 'task_end', taskId: 'background-task', stopReason: 'end_turn', at: 130 })
  assert.equal(islandView(state).form, 'working', 'the report-queue gap must not flash a completed state')
  assert.equal(islandView(state).label, '正在整理结果')

  state = reduce(state, { type: 'agent_turn_started', by: 'task', at: 140 })
  state = reduce(state, { type: 'report_delivered', conversationId: state.conversationId, sessionId: state.info.sessionId ?? null,
    reportId: 'background-task:run-1', text: 'Synthetic background result', at: 141 })
  assert.equal(islandView(state).form, 'working')
  state = reduce(state, { type: 'acp_update', at: 145, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The final result is ready.' } } })
  state = reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: 150 })
  assert.equal(islandView(state).form, 'done')
  assert.equal(islandView(state).detail, 'The final result is ready.')
})

test('a fast task ending before the delegation turn still waits for its report to be delivered', () => {
  let state = reduce(task(start()), { type: 'task_end', taskId: 'background-task', stopReason: 'end_turn', at: 115 })
  state = reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: 120 })
  assert.equal(islandView(state).label, '正在整理结果')
  state = reduce(state, { type: 'report_delivered', conversationId: state.conversationId, sessionId: state.info.sessionId ?? null,
    reportId: 'background-task:run-1', text: 'Synthetic background result', at: 121 })
  assert.equal(islandView(state).form, 'working', 'delivery alone does not complete the final reply')
  state = reduce(state, { type: 'agent_turn_started', by: 'task', at: 140 })
  state = reduce(state, { type: 'turn_end', stopReason: 'end_turn', at: 150 })
  assert.equal(islandView(state).form, 'done')
})

test('historical tasks do not keep a later answer working, and cancellation and errors keep their priority', () => {
  const ended = reduce(task(start()), { type: 'task_end', taskId: 'background-task', stopReason: 'end_turn', at: 115 })
  const later = reduce(reduce(ended, { type: 'user_prompt', text: 'A later question', at: 200 }), { type: 'turn_end', stopReason: 'end_turn', at: 210 })
  assert.equal(islandView(later).form, 'done')
  assert.equal(reduce(later, { type: 'new_session', at: 220 }).completedTurn, null)
  const cancelled = reduce(task(start()), { type: 'turn_end', stopReason: 'cancelled', at: 120 })
  assert.equal(islandView(cancelled).label, '已停止')
  assert.equal(islandView(reduce(cancelled, { type: 'error', message: 'Test error' })).form, 'error')
})

test('a preliminary explanation cannot stand in for a missing final reply, including after history reload', () => {
  let state = reduce(start(), { type: 'acp_update', at: 105, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我先分析代码仓。' } } })
  state = reduce(state, { type: 'acp_update', at: 110, update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read repository' } })
  const event = decodeAgentEvent({ type: 'turn_end', context: { conversationId: null, sessionId: 'main-session' }, stopReason: 'end_turn', finalReply: false })
  assert.ok(event)
  const action = createEventActions()(event, 120)
  assert.ok(action)
  state = reduce(state, action)
  assert.equal(state.lastReceipt?.stopReason, 'no_response')
  assert.equal(islandView(state).form, 'error')
  assert.equal(islandView(state).label, '未完成')
  assert.equal(catMood(state), 'error')
  assert.equal(state.messages.at(-2)?.text, '我先分析代码仓。')
  assert.equal(state.messages.at(-2)?.receipt, null)
  assert.equal(state.messages.at(-1)?.role, 'note')
  assert.match(state.messages.at(-1)!.text, /没有生成最终回复/)
  const restored = reduce(initialState, { type: 'history_loaded', conversationId: 'saved', messages: historyMessages(state), savedAt: 120 })
  assert.equal(restored.messages.at(-1)?.text, state.messages.at(-1)?.text)
})

test('output limits retain partial text and explain the incomplete result, while cancellation keeps its status', () => {
  const partial = reduce(start(), { type: 'acp_update', at: 110, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial analysis' } } })
  const limited = reduce(partial, { type: 'turn_end', stopReason: 'max_tokens', finalReply: true, at: 120 })
  assert.equal(islandView(limited).form, 'error')
  assert.equal(limited.messages.at(-2)?.text, 'Partial analysis')
  assert.match(limited.messages.at(-1)!.text, /输出上限/)
  const stopped = reduce(partial, { type: 'turn_end', stopReason: 'cancelled', finalReply: false, at: 120 })
  assert.equal(islandView(stopped).label, '已停止')
  assert.equal(stopped.lastReceipt?.stopReason, 'cancelled')
})

test('a delegation with no final reply waits for its task and report instead of reporting an incomplete result', () => {
  const state = reduce(task(start()), { type: 'turn_end', stopReason: 'end_turn', finalReply: false, at: 120 })
  assert.equal(islandView(state).label, '后台执行中')
  assert.equal(state.lastReceipt?.stopReason, 'end_turn')
})
