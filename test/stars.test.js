import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { isStarred, placeOf, rowPlace, starKey } from '../src/renderer/stars.ts'

/** 收藏: a star on a message, wherever the message is shown: by its segment and its place in it. */

test('an earlier row or a 回顾 row is found by its <segment>-<seq> mark, segment ids with dashes included', () => {
  assert.deepEqual(rowPlace('3f2a-77c1-9e-12'), { segmentId: '3f2a-77c1-9e', seq: 12 })
  assert.equal(rowPlace('no-seq-x'), null)
  assert.equal(rowPlace('12'), null)
})

test('a message of the conversation on screen counts only the finished ones, and needs the conversation saved', () => {
  const messages = [{ id: 'm1', role: 'user' }, { id: 'm2', role: 'assistant', open: true }, { id: 'm3', role: 'assistant' }]
  const saved = { ...initialState, conversationId: 'conv-1', messages }
  assert.deepEqual(placeOf(saved, 'm3', 'thread'), { segmentId: 'conv-1', seq: 1 })
  assert.equal(placeOf(saved, 'm2', 'thread'), null, 'still being typed out')
  assert.equal(placeOf({ ...saved, conversationId: null }, 'm1', 'thread'), null)
  assert.deepEqual(placeOf(saved, 'seg-a-4', 'row'), { segmentId: 'seg-a', seq: 4 })
})

test('stars read back are added; one put on or taken off changes only itself', () => {
  let state = reduce(initialState, { type: 'stars_loaded', places: [{ segmentId: 'a', seq: 1 }, { segmentId: 'b', seq: 0 }] })
  assert.equal(isStarred(state, { segmentId: 'a', seq: 1 }), true)
  state = reduce(state, { type: 'star_changed', segmentId: 'a', seq: 1, starred: false })
  state = reduce(state, { type: 'star_changed', segmentId: 'c', seq: 2, starred: true })
  assert.deepEqual(state.review.starKeys.toSorted(), [starKey({ segmentId: 'b', seq: 0 }), starKey({ segmentId: 'c', seq: 2 })].toSorted())
})
