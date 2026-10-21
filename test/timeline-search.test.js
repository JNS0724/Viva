import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.js'
import { hitTarget } from '../src/renderer/timeline-search.js'
import { createTimelineActions } from '../src/renderer/timeline-actions.js'

const segment = (id, seqs) => ({ id, cwd: '/w', parentId: null, createdAt: 1, messages: seqs.map((seq) => ({ seq, role: 'user', text: `${id}-${seq}`, receipt: null, at: 1 })) })
const hit = (segmentId, seq) => ({ segmentId, seq, role: 'user', at: 1, cwd: '/w', snippet: { before: '', hit: 'x', after: '' } })
const withState = (changes) => ({ ...initialState, ...changes })

test('a hit in the conversation on screen points at its message, counting only finished ones', () => {
  const state = withState({
    conversationId: 'now',
    messages: [{ id: 'm1', role: 'user' }, { id: 'm2', role: 'assistant' }, { id: 'm3', role: 'assistant', open: true }],
  })

  assert.deepEqual(hitTarget(state, hit('now', 1)), { msgId: 'm2' })
  assert.equal(hitTarget(state, hit('now', 2)), null)
})

test('a hit in an earlier segment points at its row there, or asks for more pages until it is in', () => {
  const loaded = withState({ earlier: { segments: [segment('old', [0, 1])], hasMore: true, loading: false } })
  const done = withState({ earlier: { segments: [segment('old', [0])], hasMore: false, loading: false } })

  assert.deepEqual(hitTarget(loaded, hit('old', 1)), { msgId: 'old-1' })
  assert.deepEqual(hitTarget(loaded, hit('older', 0)), { load: true })
  assert.equal(hitTarget(done, hit('gone', 0)), null)
})

test('jumpTo loads earlier pages until the hit is on screen, then reveals it', async () => {
  let state = withState({ conversationId: 'now', earlier: { segments: [], hasMore: true, loading: false } })
  const pages = [{ segments: [segment('b', [0])], hasMore: true }, { segments: [segment('a', [0, 1])], hasMore: false }]
  const revealed = []
  const actions = createTimelineActions({
    api: { earlierSegments: async () => pages.shift() },
    getState: () => state,
    dispatch: (action) => { state = reduce(state, action) },
    scroll: { scrollHeight: 0, scrollTop: 0 },
    reveal: (msgId) => revealed.push(msgId),
  })

  const found = await actions.jumpTo(hit('a', 1))

  assert.equal(found, true)
  assert.deepEqual(revealed, ['a-1'])
  assert.deepEqual(state.earlier.segments.map((s) => s.id), ['a', 'b'])
})

test('jumpTo gives up when the hit is nowhere in the timeline', async () => {
  const state = withState({ earlier: { segments: [], hasMore: false, loading: false } })
  const revealed = []
  const actions = createTimelineActions({
    api: { earlierSegments: async () => ({ segments: [], hasMore: false }) },
    getState: () => state, dispatch: () => {}, scroll: { scrollHeight: 0, scrollTop: 0 }, reveal: (id) => revealed.push(id),
  })

  assert.equal(await actions.jumpTo(hit('gone', 0)), false)
  assert.deepEqual(revealed, [])
})
