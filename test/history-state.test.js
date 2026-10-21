import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { formatListTime } from '../src/renderer/selectors.js'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(deepFreeze)
  }
  return value
}

const run = (actions, start = initialState) => actions.reduce((state, action) => reduce(deepFreeze(state), action), start)
const NOW = new Date(2026, 9, 18, 15, 0).getTime()
const at = (month, day, hour = 10, year = 2026) => new Date(year, month - 1, day, hour).getTime()
const opened = {
  type: 'conversation_opened',
  conversation: { id: 'b', title: '对话 b', updatedAt: at(10, 18, 9), messages: [{ role: 'user', text: '旧问题', receipt: null }] },
  info: { mode: 'live', model: 'V4', remembersHistory: true },
}

test('the search panel opens over the island and the model menu, closes, and toggles', () => {
  const opened = run([{ type: 'toggle_island' }, { type: 'history_open' }])
  const closed = reduce(opened, { type: 'history_close' })

  assert.deepEqual([opened.history.open, opened.island], [true, false])
  assert.equal(closed.history.open, false)
  assert.equal(reduce(closed, { type: 'history_toggle' }).history.open, true)
})

test('search results only apply to the query that is still typed', () => {
  const typed = run([{ type: 'history_open' }, { type: 'history_query', query: '联调' }])
  const answered = reduce(typed, { type: 'history_results', query: '联调', results: [{ segmentId: 'c', seq: 0 }] })
  const stale = reduce(typed, { type: 'history_results', query: '联', results: [] })
  const cleared = reduce(answered, { type: 'history_query', query: '  ' })

  assert.deepEqual(answered.history.results.map((r) => r.segmentId), ['c'])
  assert.equal(stale, typed)
  assert.deepEqual([cleared.history.query, cleared.history.results], ['  ', null])
})

test('opening a conversation replaces the thread, closes the panel, and waits for its trace', () => {
  const busy = run([
    { type: 'history_open' },
    { type: 'user_prompt', text: '现在的问题', at: NOW },
    { type: 'toast_show', toast: { key: 1, text: '已导出' } },
  ])

  const state = reduce(busy, opened)

  assert.deepEqual(state.messages.map((m) => [m.text, m.restored]), [['旧问题', true]])
  assert.deepEqual([state.conversationId, state.phase, state.restoredTrace, state.info.remembersHistory], ['b', 'idle', 'loading', true])
  assert.equal(state.history.open, false)
  assert.equal(state.toast.text, '已导出')
  assert.equal(reduce(state, { type: 'new_session', info: null }).conversationId, null)
})

test('a restored trace goes before anything the live session adds; a missing one is reported', () => {
  const restoredTrace = {
    thoughts: [{ id: 'log-1', text: '旧的思考', open: false, at: 1 }],
    tools: { 's:c1': { id: 's:c1', title: '读取 a.md', kind: 'read', status: 'completed', locations: [], at: 2 } },
    timeline: [{ kind: 'thought', ref: 'log-1', at: 1 }, { kind: 'tool', ref: 's:c1', at: 2 }],
  }
  const live = run([opened, { type: 'user_prompt', text: '新问题', at: NOW }, { type: 'acp_update', at: NOW, update: { sessionUpdate: 'tool_call', toolCallId: 'live', title: '新工具' } }])

  const merged = reduce(live, { type: 'trace_restored', conversationId: 'b', trace: restoredTrace, available: true })
  const missing = reduce(live, { type: 'trace_restored', conversationId: 'b', trace: { thoughts: [], tools: {}, timeline: [] }, available: false })
  const elsewhere = reduce(live, { type: 'trace_restored', conversationId: 'other', trace: restoredTrace, available: true })

  assert.deepEqual(merged.timeline.map((e) => e.ref), ['log-1', 's:c1', 'live'])
  assert.deepEqual(Object.keys(merged.tools).sort(), ['live', 's:c1'])
  assert.equal(merged.restoredTrace, 'loaded')
  assert.equal(missing.restoredTrace, 'unavailable')
  assert.equal(elsewhere, live)
})

test('history_loaded at launch remembers which conversation is on screen', () => {
  const state = run([{ type: 'history_loaded', conversationId: 'b', messages: opened.conversation.messages, savedAt: NOW }])
  assert.deepEqual([state.conversationId, state.restoredTrace], ['b', 'loading'])
  assert.equal(run([{ type: 'conversation_saved', id: 'z' }]).conversationId, 'z')
})

test('toasts show one at a time and only the matching one is hidden', () => {
  const shown = run([{ type: 'toast_show', toast: { key: 2, text: '已删除' } }])
  assert.equal(reduce(shown, { type: 'toast_hide', key: 1 }), shown)
  assert.equal(reduce(shown, { type: 'toast_hide', key: 2 }).toast, null)
})

test('formatListTime is short: time today, then 昨天, then the date', () => {
  assert.equal(formatListTime(at(10, 18, 9), NOW), '09:00')
  assert.equal(formatListTime(at(10, 17), NOW), '昨天')
  assert.equal(formatListTime(at(9, 1), NOW), '9月1日')
  assert.equal(formatListTime(at(12, 31, 10, 2025), NOW), '2025/12/31')
})
