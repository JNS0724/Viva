import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState } from '../src/renderer/state.ts'
import { traceItems, traceTail } from '../src/renderer/selectors.ts'
import { isStarred, placeOf } from '../src/renderer/stars.ts'

test('the trace tail preserves visible rows and original keys across missing references', () => {
  const state: State = { ...initialState,
    thoughts: [{ id: 't', text: 'first' }, { id: 't', text: 'duplicate' }],
    tools: { read: { title: 'Read', status: 'completed' } },
    timeline: [
      { kind: 'thought', ref: 't', at: 1 },
      { kind: 'tool', ref: 'read', at: 2 },
      { kind: 'permission', ref: 'p', title: 'Allow', at: 3 },
      { kind: 'question', ref: 'q', title: 'Which?', at: 4 },
      { kind: 'answer', ref: 'a', title: 'A', answered: true, at: 5 },
      { kind: 'tool', ref: 'missing', at: 6 },
      { kind: 'thought', ref: 'missing', at: 7 },
    ],
  }
  for (const count of [1, 4, 10]) assert.deepEqual(traceTail(state, count), traceItems(state).slice(-count))
  assert.deepEqual(traceTail(state, 0), [])
  assert.equal(traceItems(state)[0].detail, 'first')
  const changed = { ...state, thoughts: [{ id: 't', text: 'updated' }] }
  assert.equal(traceItems(changed)[0].detail, 'updated')
  assert.equal(traceItems(state)[0].detail, 'first')
})

test('thought lookup is linear and a tool-only tail reads only the last four timeline entries', () => {
  let idReads = 0
  const thoughts = Array.from({ length: 1000 }, (_, index) => ({
    get id() { idReads += 1; return String(index) }, text: 'thinking',
  }))
  const state: State = { ...initialState, thoughts,
    timeline: thoughts.map((_, index) => ({ kind: 'thought', ref: String(index), at: index })),
  }
  assert.equal(traceItems(state).length, 1000)
  assert.ok(idReads <= 2000, `thought IDs were read ${idReads} times`)
  let entriesRead = 0
  const timeline = new Proxy<State['timeline']>(Array.from({ length: 10_000 }, (_, index) => ({ kind: 'tool', ref: 'read', at: index })), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) entriesRead += 1
      return Reflect.get(target, key, receiver)
    },
  })
  assert.equal(traceTail({ ...initialState, timeline, tools: { read: { title: 'Read' } } }, 4).length, 4)
  assert.equal(entriesRead, 4)
})

test('saved message indexes count only finished messages and refresh on immutable replacement', () => {
  const state: State = { ...initialState, conversationId: 'one', messages: [
    { id: 'a', role: 'user', text: 'hi' },
    { id: 'b', role: 'assistant', text: 'typing', open: true },
    { id: 'a', role: 'assistant', text: 'duplicate' },
    { id: 'c', role: 'assistant', text: 'done' },
  ] }
  assert.deepEqual(placeOf(state, 'a', 'thread'), { segmentId: 'one', seq: 0 })
  assert.equal(placeOf(state, 'b', 'thread'), null)
  assert.deepEqual(placeOf(state, 'c', 'thread'), { segmentId: 'one', seq: 2 })
  const completed = { ...state, conversationId: 'two', messages: state.messages.map(message => ({ ...message, open: false })) }
  assert.deepEqual(placeOf(completed, 'b', 'thread'), { segmentId: 'two', seq: 1 })
  assert.equal(placeOf(state, 'b', 'thread'), null)
  const starred = { ...state, review: { ...state.review, starKeys: ['one:0'] } }
  assert.equal(isStarred(starred, { segmentId: 'one', seq: 0 }), true)
  assert.equal(isStarred({ ...starred, review: { ...starred.review, starKeys: [] } }, { segmentId: 'one', seq: 0 }), false)
})
