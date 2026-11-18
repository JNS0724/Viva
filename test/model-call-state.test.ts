import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeUpdate } from '../src/renderer/agent-event-decoder.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { traceItems } from '../src/renderer/selectors.ts'
import { createTraceActions } from '../src/renderer/trace-actions.ts'
import { modelCallId, type ModelCallDetail, type ModelCallSummary } from '../src/shared/trace.ts'

const call: ModelCallSummary = {
  sessionId: '11111111-2222-3333-4444-555555555555', turn: 1, step: 1, at: 1000, status: 'running',
  provider: 'deepseek', model: 'deepseek-v4', attempts: 1, inputTokens: null, outputTokens: null, durationMs: null,
}
const update = { sessionUpdate: 'viva_model_call' as const, call }

test('model call events are validated and retries update one timeline node', () => {
  assert.deepEqual(decodeUpdate(update), update)
  assert.equal(decodeUpdate({ ...update, call: { ...call, attempts: -1 } }), null)
  let state = reduce(initialState, { type: 'acp_update', update, at: 1000 })
  state = reduce(state, { type: 'acp_update', at: 1400, update: { sessionUpdate: 'viva_model_call',
    call: { ...call, status: 'completed', attempts: 2, inputTokens: 1200, outputTokens: 90, durationMs: 400 } } })

  assert.deepEqual(state.timeline.map(item => item.kind), ['model'])
  assert.equal(state.modelCalls[modelCallId(call)].attempts, 2)
  assert.deepEqual(traceItems(state).map(item => [item.title, item.detail, item.tone]), [['模型调用', 'deepseek-v4 · 输入 1200 · 输出 90', 'done']])
})

test('opening a model detail loads its request once and keeps stale responses out of a newer detail', async () => {
  let state: State = { ...initialState, conversationId: 'conversation', modelCalls: { [modelCallId(call)]: call },
    timeline: [{ kind: 'model', ref: modelCallId(call), at: call.at }] }
  const detail: ModelCallDetail = { call: { ...call, status: 'completed' }, request: { provider: 'deepseek', model: 'v4', config: {}, messages: [], tools: [] } }
  let resolve: ((value: ModelCallDetail) => void) | undefined
  let reads = 0
  const actions = createTraceActions({
    api: { loadModelRequest: () => { reads++; return new Promise<ModelCallDetail>(done => { resolve = done }) } },
    getState: () => state,
    dispatch: action => { state = reduce(state, action) },
    errorMessage: String,
    showToast: () => {},
  })
  const item = traceItems(state)[0]
  const opening = actions.open(item)
  assert.equal(state.traceDetail?.loading, true)
  assert.equal(state.traceDetail?.key, item.key)
  resolve!(detail)
  await opening
  assert.equal(state.traceDetail?.request, detail)
  assert.equal(state.traceDetail?.loading, false)
  assert.equal(reads, 1)
  const previous = actions.open(item)
  state = reduce(state, { type: 'trace_invalidated', currentSession: true })
  assert.equal(state.traceDetail, null)
  // The same item can be reopened from a later restored session before the old IPC resolves.
  state = reduce(state, { type: 'trace_detail_open', key: item.key, conversationId: 'conversation', loading: true })
  resolve!(detail)
  await previous
  assert.equal(state.traceDetail?.loading, true)
  assert.equal(state.traceDetail?.request, null)
})

test('copy uses the complete detail text and reports success', async () => {
  let copied = '', notice = ''
  const actions = createTraceActions({
    api: { loadModelRequest: async () => null },
    getState: () => initialState,
    dispatch: () => {}, errorMessage: String, showToast: text => { notice = text },
    copyText: async text => { copied = text },
  })
  await actions.copy('完整提示词')
  assert.equal(copied, '完整提示词')
  assert.equal(notice, '已复制完整内容')
})
