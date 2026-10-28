import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState } from '../src/renderer/state.ts'
import { hitTarget, timelinePlace } from '../src/renderer/timeline-search.ts'

/** A search hit or a link: the message on screen in the timeline, if it is there (else 回顾 reads it). */

const segment = (id: string, seqs: number[]): Segment => ({
  id, cwd: '/w', parentId: null, createdAt: 1, messages: seqs.map((seq) => ({ id: 100 + seq, seq, role: 'user', text: `${id}-${seq}`, receipt: null, at: 1 })),
})
const hit = (segmentId: string, seq: number, messageId = 100 + seq) => ({ segmentId, seq, messageId })
const withState = (changes: Partial<State>): State => ({ ...initialState, ...changes } as State)

test('a viva://timeline link names a message of the timeline, with its id when the answer has one', () => {
  assert.deepEqual(timelinePlace('viva://timeline/3f2a-bc/12'), { segmentId: '3f2a-bc', seq: 12 })
  assert.deepEqual(timelinePlace('viva://timeline/3f2a-bc/12/4051'), { segmentId: '3f2a-bc', seq: 12, messageId: 4051 })
  assert.equal(timelinePlace('viva://timeline/3f2a-bc'), null)
  assert.equal(timelinePlace('viva://timeline/../etc/1'), null)
  assert.equal(timelinePlace('https://example.com/timeline/a/1'), null)
})

test('a hit in the conversation on screen points at its message, counting only finished ones', () => {
  const state = withState({
    conversationId: 'now',
    messages: [{ id: 'm1', role: 'user', text: '' }, { id: 'm2', role: 'assistant', text: '' }, { id: 'm3', role: 'assistant', text: '', open: true }],
  })
  assert.deepEqual(hitTarget(state, hit('now', 1)), { msgId: 'm2' })
  assert.equal(hitTarget(state, hit('now', 2)), null)
})

test('a message found in an earlier segment on screen is its row only when the row read back is that very message', () => {
  const withoutIds = { ...segment('bare', [0]), messages: [{ seq: 0, role: 'user', text: 'x', receipt: null, at: 1 }] }
  const state = withState({ earlier: { ...initialState.earlier, segments: [segment('old', [0, 1]), withoutIds], hasMore: true } })
  assert.deepEqual(hitTarget(state, hit('old', 1)), { msgId: 'old-1' })
  assert.equal(hitTarget(state, hit('old', 1, 999)), null, 'read back before it was said again differently: another message there')
  assert.deepEqual(hitTarget(state, hit('bare', 0)), { msgId: 'bare-0' }, 'the window’s own conversation moved up: its place, as the history confirmed')
  assert.equal(hitTarget(state, hit('older', 0)), null, 'not read back: 回顾 reads it, no paging back for it')
})
