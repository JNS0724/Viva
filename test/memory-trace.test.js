import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { memoryTrace, traceItems } from '../src/renderer/selectors.ts'

/** What the memory plugin sent with a question, as the 过程 tab shows it. */
const T0 = new Date(2026, 9, 18, 14, 20, 0).getTime()
const toolCall = (at) => ({ type: 'acp_update', at, update: { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: '读取文件', kind: 'read', status: 'completed' } })

test('injected memory goes into the trace at its own time, ahead of the steps it informed', () => {
  const injected = [{ turn: 1, at: T0, fixed: 'first', pushed: [{ text: '周报每周五交给张三', names: ['周报', '张三'] }] }]
  const state = [toolCall(T0 + 1000), { type: 'memory_context', injected }].reduce(reduce, initialState)

  const rows = traceItems(state)
  assert.deepEqual(rows.map((row) => row.title), ['带上记忆', '读取文件'])
  assert.equal(rows[0].detail, '画像、偏好和记忆规则（会话开始时）\n因为提到「周报、张三」：周报每周五交给张三')
  assert.equal(reduce(initialState, { type: 'memory_context', injected: [] }), initialState, 'nothing sent, nothing shown')
})

test('each reason for sending the profile reads differently, and pushed-only turns say why', () => {
  assert.match(memoryTrace({ fixed: 'compacted', pushed: [] }).detail, /对话压缩后重新带上/)
  assert.equal(memoryTrace({ fixed: 'changed', pushed: [] }).detail, '更新后的画像和偏好')
  assert.equal(memoryTrace({ fixed: null, pushed: [{ text: '张三是直属上级', names: ['张三'] }] }).detail, '因为提到「张三」：张三是直属上级')
})
