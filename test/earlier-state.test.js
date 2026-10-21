import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { earlierRows } from '../src/renderer/selectors.js'

/** The one timeline in the window: the segments before the current one, and how they read. */

const DAY = 86_400_000
const NOW = new Date(2026, 9, 21, 15, 0).getTime()
const msg = (seq, role, text, at) => ({ seq, role, text, receipt: null, at })
const segment = (id, cwd, messages) => ({ id, cwd, parentId: null, createdAt: messages[0]?.at ?? 0, messages })

test('earlier segments arrive in pages and go before those already shown, each once', () => {
  const loading = reduce(initialState, { type: 'earlier_loading' })
  assert.equal(loading.earlier.loading, true)
  const b = segment('b', '/w', [msg(0, 'user', '二', NOW - DAY)])
  const first = reduce(loading, { type: 'earlier_loaded', segments: [b], hasMore: true })
  assert.deepEqual([first.earlier.segments.map((s) => s.id), first.earlier.hasMore, first.earlier.loading], [['b'], true, false])
  const a = segment('a', '/w', [msg(0, 'user', '一', NOW - 2 * DAY)])
  const more = reduce(first, { type: 'earlier_loaded', segments: [a, b], hasMore: false })
  assert.deepEqual([more.earlier.segments.map((s) => s.id), more.earlier.hasMore], [['a', 'b'], false])
})

test('when the conversation goes on in another folder, what was said so far stays above, and the new part starts empty', () => {
  const talking = {
    ...initialState,
    conversationId: 'c1',
    info: { ...initialState.info, mode: 'live', cwd: '/w/viva' },
    messages: [{ id: 'm0', role: 'user', text: '做周报', shown: 4, open: false, receipt: null }],
  }
  const moved = reduce(talking, { type: 'workdir_switched', cwd: '/w/site', info: { mode: 'live', cwd: '/w/site', sessionId: 's2' } })
  assert.deepEqual(moved.messages, [])
  assert.equal(moved.conversationId, null)
  assert.equal(moved.info.cwd, '/w/site')
  const kept = moved.earlier.segments.at(-1)
  assert.deepEqual([kept.id, kept.cwd, kept.messages.map((m) => [m.role, m.text])], ['c1', '/w/viva', [['user', '做周报']]])
  assert.ok(Number.isFinite(kept.messages[0].at))
  assert.deepEqual(talking.earlier.segments, [], 'the state given is left as it was')
})

test('the timeline reads by day, says where the folder changed, and the current part follows on', () => {
  const earlier = {
    segments: [
      segment('a', '/w/viva', [msg(0, 'user', '周报', NOW - DAY), msg(1, 'assistant', '写好了', NOW - DAY + 1000)]),
      segment('b', '/w/site', [msg(0, 'user', '首页按钮', NOW - 1000)]),
    ],
    hasMore: false,
  }
  const rows = earlierRows(earlier, { currentCwd: '/w/site', now: NOW })
  assert.deepEqual(rows.map((row) => row.kind === 'message' ? `${row.role}:${row.text}` : `${row.kind}:${row.label ?? row.cwd}`), [
    'day:昨天', 'user:周报', 'assistant:写好了', 'workdir:/w/site', 'day:今天', 'user:首页按钮',
  ])
  assert.ok(rows.filter((row) => row.kind === 'message').every((row) => typeof row.id === 'string'), 'each message keyed for the view')

  const switchedSince = earlierRows(earlier, { currentCwd: '/w/other', now: NOW })
  assert.deepEqual(switchedSince.at(-1), { kind: 'workdir', cwd: '/w/other' }, 'the folder the current part is in, when it changed')
  const older = earlierRows({ segments: [segment('x', null, [msg(0, 'user', '很久以前', NOW - 30 * DAY)])] }, { currentCwd: '/w', now: NOW })
  assert.equal(older[0].label, '9 月 21 日')
})
