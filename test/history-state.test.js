import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { formatListTime, historyGroups } from '../src/renderer/selectors.js'

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
const item = (id, updatedAt, pinned = false) => ({ id, title: `对话 ${id}`, updatedAt, model: 'V4', pinned })
const ITEMS = [item('a', at(10, 1), true), item('b', at(10, 18, 9)), item('c', at(10, 17)), item('d', at(10, 13)), item('e', at(9, 1))]
const opened = {
  type: 'conversation_opened',
  conversation: { id: 'b', title: '对话 b', updatedAt: at(10, 18, 9), messages: [{ role: 'user', text: '旧问题', receipt: null }] },
  info: { mode: 'live', model: 'V4', remembersHistory: true },
}

test('history panel opens, lists, pages and closes, forgetting its menus', () => {
  const listed = run([
    { type: 'history_open' },
    { type: 'history_listed', items: ITEMS.slice(0, 2), hasMore: true, append: false },
    { type: 'history_listed', items: ITEMS.slice(2), hasMore: false, append: true },
    { type: 'history_menu', id: 'c' },
  ])
  const closed = reduce(listed, { type: 'history_close' })

  assert.deepEqual([listed.history.open, listed.history.items.length, listed.history.hasMore, listed.history.menuFor], [true, 5, false, 'c'])
  assert.deepEqual([closed.history.open, closed.history.menuFor, closed.history.items.length], [false, null, 5])
  assert.equal(reduce(closed, { type: 'history_toggle' }).history.open, true)
})

test('search results only apply to the query that is still typed', () => {
  const typed = run([{ type: 'history_open' }, { type: 'history_query', query: '联调' }])
  const answered = reduce(typed, { type: 'history_results', query: '联调', results: [item('c', NOW)] })
  const stale = reduce(typed, { type: 'history_results', query: '联', results: [] })
  const cleared = reduce(answered, { type: 'history_query', query: '  ' })

  assert.deepEqual(answered.history.results.map((r) => r.id), ['c'])
  assert.equal(stale, typed)
  assert.deepEqual([cleared.history.query, cleared.history.results], ['  ', null])
})

test('renaming and removing update the list', () => {
  const base = run([
    { type: 'history_listed', items: ITEMS, hasMore: false, append: false },
    { type: 'history_rename_start', id: 'c' },
  ])

  const renamed = reduce(base, { type: 'history_item_changed', id: 'c', changes: { title: '新标题' } })
  const removed = reduce(renamed, { type: 'history_item_removed', id: 'c' })

  assert.equal(base.history.renaming, 'c')
  assert.deepEqual([renamed.history.items[2].title, renamed.history.renaming], ['新标题', null])
  assert.deepEqual([removed.history.items.some((i) => i.id === 'c'), removed.history.results], [false, null])
})

test('opening a conversation replaces the thread, keeps panel data, and waits for its trace', () => {
  const busy = run([
    { type: 'history_open' },
    { type: 'history_listed', items: ITEMS, hasMore: false, append: false },
    { type: 'user_prompt', text: '现在的问题', at: NOW },
    { type: 'toast_show', toast: { key: 1, text: '已导出' } },
  ])

  const state = reduce(busy, opened)

  assert.deepEqual(state.messages.map((m) => [m.text, m.restored]), [['旧问题', true]])
  assert.deepEqual([state.conversationId, state.phase, state.restoredTrace, state.info.remembersHistory], ['b', 'idle', 'loading', true])
  assert.deepEqual([state.history.open, state.history.items.length], [false, 5])
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
  const shown = run([{ type: 'toast_show', toast: { key: 2, text: '已删除', undoId: 'c' } }])
  assert.equal(reduce(shown, { type: 'toast_hide', key: 1 }), shown)
  assert.equal(reduce(shown, { type: 'toast_hide', key: 2 }).toast, null)
})

test('historyGroups puts pinned first, then today, yesterday, this week and earlier', () => {
  const groups = historyGroups(ITEMS, NOW)
  assert.deepEqual(groups.map((g) => [g.label, g.items.map((i) => i.id)]), [
    ['置顶', ['a']], ['今天', ['b']], ['昨天', ['c']], ['7 天内', ['d']], ['更早', ['e']],
  ])
  assert.deepEqual(historyGroups([], NOW), [])
})

test('formatListTime is short: time today, then 昨天, then the date', () => {
  assert.equal(formatListTime(at(10, 18, 9), NOW), '09:00')
  assert.equal(formatListTime(at(10, 17), NOW), '昨天')
  assert.equal(formatListTime(at(9, 1), NOW), '9月1日')
  assert.equal(formatListTime(at(12, 31, 10, 2025), NOW), '2025/12/31')
})
