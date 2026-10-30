import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { begunEarlier, readOn, reviewDays, topicKey, type ReviewTopic } from '../src/renderer/review-state.ts'

/** 回顾: the topics by day of when each was last talked in; filtered, read in place, opened from a link, starred. */

const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).getTime()
const topic = (id: string, fields: Partial<ReviewTopic> = {}): ReviewTopic => ({
  id, title: id, startedAt: at(25), lastAt: at(25), turns: 1, hasFiles: false, stars: 0, cwds: ['/w'], segments: [id], head: id, tasks: [], ...fields,
})

test('topics are grouped by month and day of when each was last talked in, today and yesterday by name', () => {
  const now = at(27, 15)
  const topics = [topic('t', { lastAt: at(27, 9) }), topic('y', { lastAt: at(26) }), topic('o', { lastAt: at(20) }), topic('s', { lastAt: new Date(2026, 8, 30).getTime(), startedAt: new Date(2026, 8, 30).getTime() })]
  const months = reviewDays(topics, now)
  assert.deepEqual(months.map((month) => month.label), ['2026年10月', '2026年9月'])
  assert.deepEqual(months[0].days.map((day) => day.label), ['今天', '昨天', '10月20日 周二'])
  assert.deepEqual(months[1].days[0].topics.map((item) => item.id), ['s'])
})

test('a topic talked in again on a later day says when it began', () => {
  assert.equal(begunEarlier(topic('a', { startedAt: at(20), lastAt: at(27) })), true)
  assert.equal(begunEarlier(topic('b', { startedAt: at(27, 9), lastAt: at(27, 18) })), false)
})

test('pages add topics; a fresh load starts over; another filter clears them to be read again', () => {
  let state = reduce(initialState, { type: 'review_loaded', topics: [topic('b')], hasMore: true, fresh: true })
  state = reduce(state, { type: 'review_loaded', topics: [topic('a'), topic('b')], hasMore: false })
  assert.deepEqual(state.review.topics.map((t) => t.id), ['b', 'a'])
  assert.equal(state.review.hasMore, false)

  state = reduce(state, { type: 'review_filter', filter: 'files' })
  assert.deepEqual([state.review.filter, state.review.topics.length, state.review.loaded, state.review.hasMore], ['files', 0, false, true])
  state = reduce(state, { type: 'review_loaded', topics: [topic('z')], hasMore: false, fresh: true })
  state = reduce(state, { type: 'review_filter', filter: 'stars' })
  assert.deepEqual(state.review.topics.map((t) => t.id), ['z'], '收藏 keeps the topics; it lists the stars instead')
})

test('reading a topic opens it, again closes it; a late answer for another is dropped', () => {
  let state = reduce(initialState, { type: 'review_open', key: topicKey('z') })
  assert.equal(state.review.open, 't:z')
  state = reduce(state, { type: 'review_read', key: 't:z', messages: [{ segmentId: 'z', seq: 0, role: 'user', text: '问' }] })
  assert.equal(state.review.reading?.messages.length, 1)
  state = reduce(state, { type: 'review_read', key: 't:other', messages: [] })
  assert.equal(state.review.reading?.key, 't:z')
  state = reduce(state, { type: 'review_open', key: 't:z' })
  assert.equal(state.review.open, null)
})

test('a message opened from a link is read at the top until closed; opening a row of the list closes it', () => {
  let state = reduce(initialState, { type: 'review_focus', key: 't:old', title: '审一下合同', at: at(1), head: 'seg-2', found: 'seg-1-3', notice: null })
  assert.deepEqual(state.review.focus, { key: 't:old', title: '审一下合同', at: at(1), head: 'seg-2', found: 'seg-1-3', notice: null })
  assert.equal(state.review.open, 't:old')
  state = reduce(state, { type: 'review_open', key: 't:other' })
  assert.deepEqual([state.review.focus, state.review.open], [null, 't:other'])
  state = reduce(state, { type: 'review_focus', key: 's:task', title: '后台', notice: '原文已经不在了' })
  state = reduce(state, { type: 'review_unfocus' })
  assert.deepEqual([state.review.focus, state.review.open, state.review.reading], [null, null, null])
})

test('a star changed anywhere is counted on its topic and its task, and leaves the 收藏 list when taken off', () => {
  let state = reduce(initialState, { type: 'review_loaded', topics: [topic('a', { segments: ['a', 'a2'], tasks: [{ id: 'task', createdAt: 1, title: '后台', turns: 1, hasFiles: false, stars: 0 }] })], hasMore: false, fresh: true })
  state = reduce(state, { type: 'review_starred', items: [{ segmentId: 'a', seq: 1, text: '答' }] })
  state = reduce(state, { type: 'star_changed', segmentId: 'a2', seq: 2, starred: true })
  state = reduce(state, { type: 'star_changed', segmentId: 'task', seq: 0, starred: true })
  assert.deepEqual([state.review.topics[0].stars, state.review.topics[0].tasks[0].stars], [2, 1])
  state = reduce(state, { type: 'star_changed', segmentId: 'a', seq: 1, starred: false })
  assert.equal(state.review.topics[0].stars, 1)
  assert.deepEqual(state.review.starred, [])
})

test('a part that does not join on at its end is not taken', () => {
  const seqs = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ segmentId: 'a', seq: from + i, role: 'user', text: '' }))
  const window = { key: 't:a', read: 1, whole: false, total: 2000, from: 1450, messages: seqs(1450, 100), loading: 'before' as const }
  const stale = readOn(window, 'before', { total: 2000, from: 470, messages: seqs(470, 30) })
  assert.deepEqual([stale.from, stale.messages.length, stale.loading], [1450, 100, null])
  const joined = readOn(window, 'before', { total: 2000, from: 1420, messages: seqs(1420, 30) })
  assert.deepEqual([joined.from, joined.messages[0].seq, joined.messages.length], [1420, 1420, 130])
})

test('a star the history already had marks the message but does not count twice', () => {
  let state = reduce(initialState, { type: 'review_loaded', topics: [topic('a', { stars: 1 })], hasMore: false, fresh: true })
  state = reduce(state, { type: 'star_changed', segmentId: 'a', seq: 1, starred: true, changed: false })
  assert.equal(state.review.topics[0].stars, 1)
  assert.equal(state.review.starKeys.includes('a:1'), true)
})
