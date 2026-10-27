import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { reviewDays, reviewTopics, shownTopics } from '../src/renderer/review-state.ts'

/** 回顾: the timeline by day, newest first, a topic a line; filtered, read in place, starred. */

const at = (day, hour = 9) => new Date(2026, 9, day, hour).getTime()
const seg = (id, fields = {}) => ({ id, parentId: null, createdAt: at(25), title: id, cwd: '/w', kind: 'talk', turns: 1, hasFiles: false, stars: 0, ...fields })

test('segments that go on from the one before read as one topic, named by its first; a background task stands alone', () => {
  const segments = [
    seg('c', { parentId: 'b', createdAt: at(25, 12), turns: 2, stars: 1 }),
    seg('task', { kind: 'task', createdAt: at(25, 11), parentId: 'b' }),
    seg('b', { createdAt: at(25, 10), hasFiles: true, title: '整理周报' }),
    seg('a', { createdAt: at(24) }),
  ]
  const topics = reviewTopics(segments)
  assert.deepEqual(topics.map((topic) => topic.key), ['task', 'c', 'a'])
  const [, weekly] = topics
  assert.deepEqual(weekly.segments.map((s) => s.id), ['b', 'c'])
  assert.deepEqual([weekly.title, weekly.turns, weekly.hasFiles, weekly.stars, weekly.at], ['整理周报', 3, true, 1, at(25, 10)])
})

test('topics are grouped by month and day, newest first, today and yesterday by name', () => {
  const now = at(27, 15)
  const topics = reviewTopics([seg('t', { createdAt: at(27, 9) }), seg('y', { createdAt: at(26) }), seg('o', { createdAt: at(20) }), seg('s', { createdAt: new Date(2026, 8, 30).getTime() })])
  const months = reviewDays(topics, now)
  assert.deepEqual(months.map((month) => month.label), ['2026年10月', '2026年9月'])
  assert.deepEqual(months[0].days.map((day) => day.label), ['今天', '昨天', '10月20日 周二'])
  assert.deepEqual(months[1].days[0].topics.map((topic) => topic.key), ['s'])
})

test('the filters keep background tasks, or topics with files', () => {
  const topics = reviewTopics([seg('t', { kind: 'task' }), seg('f', { hasFiles: true }), seg('p')])
  assert.deepEqual(shownTopics(topics, 'all').map((t) => t.key), ['t', 'f', 'p'])
  assert.deepEqual(shownTopics(topics, 'tasks').map((t) => t.key), ['t'])
  assert.deepEqual(shownTopics(topics, 'files').map((t) => t.key), ['f'])
})

test('pages add older segments; a fresh load starts over; reading a topic opens it, again closes it', () => {
  let state = reduce(initialState, { type: 'review_loaded', segments: [seg('b')], hasMore: true, fresh: true })
  state = reduce(state, { type: 'review_loaded', segments: [seg('a'), seg('b')], hasMore: false })
  assert.deepEqual(state.review.segments.map((s) => s.id), ['b', 'a'])
  assert.equal(state.review.hasMore, false)
  state = reduce(state, { type: 'review_loaded', segments: [seg('z')], hasMore: true, fresh: true })
  assert.deepEqual(state.review.segments.map((s) => s.id), ['z'])

  state = reduce(state, { type: 'review_open', key: 'z' })
  assert.equal(state.review.open, 'z')
  state = reduce(state, { type: 'review_read', key: 'z', messages: [{ segmentId: 'z', seq: 0, role: 'user', text: '问' }] })
  assert.equal(state.review.reading.messages.length, 1)
  state = reduce(state, { type: 'review_read', key: 'other', messages: [] })
  assert.equal(state.review.reading.key, 'z', 'a late answer for a topic no longer open is dropped')
  state = reduce(state, { type: 'review_open', key: 'z' })
  assert.equal(state.review.open, null)
})

test('a star changed anywhere is counted on its topic and leaves the 收藏 list when taken off', () => {
  let state = reduce(initialState, { type: 'review_loaded', segments: [seg('a')], hasMore: false, fresh: true })
  state = reduce(state, { type: 'review_starred', items: [{ segmentId: 'a', seq: 1, text: '答' }] })
  state = reduce(state, { type: 'star_changed', segmentId: 'a', seq: 2, starred: true })
  assert.equal(state.review.segments[0].stars, 1)
  state = reduce(state, { type: 'star_changed', segmentId: 'a', seq: 1, starred: false })
  assert.equal(state.review.segments[0].stars, 0)
  assert.deepEqual(state.review.starred, [])
})

test('a star the history already had marks the message but does not count twice', () => {
  let state = reduce(initialState, { type: 'review_loaded', segments: [seg('a', { stars: 1 })], hasMore: false, fresh: true })
  state = reduce(state, { type: 'star_changed', segmentId: 'a', seq: 1, starred: true, changed: false })
  assert.equal(state.review.segments[0].stars, 1)
  assert.equal(state.review.starKeys.includes('a:1'), true)
})
