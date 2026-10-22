import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { foldAfter, rewindTarget } from '../src/renderer/rewind-state.ts'

const msg = (id, role, text, extra = {}) => ({ id, role, text, open: false, receipt: null, ...extra })
const withMessages = (messages, changes = {}) => ({ ...initialState, conversationId: 'now', messages, ...changes })

test('what the user said can be gone back to: where it is among what is saved, and which repeat from the end', () => {
  const state = withMessages([
    msg('m0', 'user', '再说一遍'), msg('m1', 'assistant', '好'),
    msg('m2', 'user', '换个问题'), msg('m3', 'assistant', '好的', { open: true }),
  ])
  const repeated = withMessages([msg('m0', 'user', '再说一遍'), msg('m1', 'assistant', '好'), msg('m2', 'user', '再说一遍')])

  assert.deepEqual(rewindTarget(state, 'm2'), { words: '换个问题', occurrence: 0, keep: 2 })
  assert.deepEqual(rewindTarget(repeated, 'm0'), { words: '再说一遍', occurrence: 1, keep: 0 })
  assert.equal(rewindTarget(state, 'm1'), null, 'not the agent’s answers')
})

test('words said into a running turn, answers to its questions, words not sent, or anything while it works are not', () => {
  const state = withMessages([
    msg('m0', 'user', '做周报'), msg('m1', 'user', '顺便加个表', { steered: true }),
    msg('m2', 'user', '上海', { asked: '哪个城市？' }), msg('m3', 'user', '没送出', { failed: true }),
  ])
  for (const id of ['m1', 'm2', 'm3']) assert.equal(rewindTarget(state, id), null, id)
  assert.equal(rewindTarget({ ...state, phase: 'working' }, 'm0'), null)
  assert.equal(rewindTarget({ ...state, conversationId: null }, 'm0'), null, 'nothing saved yet')
})

test('editing one message at a time; going back shows what came before it with the folded path, the earlier timeline kept', () => {
  const earlier = { segments: [{ id: 'old', cwd: '/w', parentId: null, createdAt: 1, messages: [] }], hasMore: false, loading: false }
  const state = withMessages([msg('m0', 'user', '做周报'), msg('m1', 'assistant', '写好了'), msg('m2', 'user', '太正式了')], { earlier })

  const editing = reduce(state, { type: 'rewind_edit', id: 'm2' })
  assert.equal(editing.rewind.editing, 'm2')
  assert.equal(reduce(editing, { type: 'rewind_cancel' }).rewind.editing, null)

  const going = reduce(editing, { type: 'rewind_busy' })
  assert.equal(going.rewind.busy, true)
  assert.equal(reduce(going, { type: 'rewind_failed' }).rewind.busy, false)

  const done = reduce(going, {
    type: 'rewound',
    conversation: { id: 'next', messages: [{ role: 'user', text: '做周报', receipt: null }, { role: 'assistant', text: '写好了', receipt: null }] },
    info: { sessionId: 's2', cwd: '/w' },
    folds: [{ id: 'now', at: 2, count: 1 }],
  })
  assert.deepEqual([done.conversationId, done.rewind.editing, done.rewind.busy], ['next', null, false])
  assert.deepEqual(done.messages.map((m) => [m.text, m.shown, m.restored ?? false]), [['做周报', 3, false], ['写好了', 3, false]])
  assert.deepEqual(done.folds, [{ id: 'now', at: 2, count: 1 }])
  assert.equal(done.earlier, earlier)
  assert.equal(done.restored, null, 'no 「以上是历史消息」 line: this is the conversation going on')
})

test('a fold hangs after the message just before it; one at the very start hangs before everything', () => {
  const state = withMessages([msg('m0', 'user', '做周报'), msg('m1', 'assistant', '写好了'), msg('m2', 'user', '口语一点')], {
    folds: [{ id: 'a', at: 2, count: 2 }, { id: 'b', at: 0, count: 4 }],
  })
  assert.deepEqual(foldAfter(state), { m1: [{ id: 'a', at: 2, count: 2 }], '': [{ id: 'b', at: 0, count: 4 }] })
})

test('a folded path opens in place to be read, and closes; going another way closes them all', () => {
  const state = withMessages([msg('m0', 'user', '做周报')], { folds: [{ id: 'a', at: 1, count: 2 }] })
  const opened = reduce(state, { type: 'fold_opened', id: 'a', messages: [{ role: 'user', text: '太正式了', receipt: null }] })

  assert.deepEqual(opened.rewind.open.a.map((m) => m.text), ['太正式了'])
  assert.deepEqual(reduce(opened, { type: 'fold_closed', id: 'a' }).rewind.open, {})
  const moved = reduce(opened, { type: 'rewound', conversation: { id: 'a', messages: [] }, info: {}, folds: [] })
  assert.deepEqual(moved.rewind.open, {})
})

test('going back over changes to the computer waits for the user to say they know; cancelling forgets it', () => {
  const state = withMessages([msg('m0', 'user', '做周报')])
  const effects = { files: [{ path: '/w/a.md', times: 2 }], commands: [] }
  const asking = reduce(state, { type: 'rewind_confirm', id: 'm0', text: '口语一点', effects })

  assert.deepEqual(asking.rewind.confirm, { id: 'm0', text: '口语一点', effects })
  assert.equal(reduce(asking, { type: 'rewind_confirm_cancel' }).rewind.confirm, null)
  assert.equal(reduce(asking, { type: 'rewind_busy' }).rewind.confirm, null, 'once it goes, the question is answered')
})

test('the folds of the conversation come back with it at launch', () => {
  const state = reduce(initialState, {
    type: 'history_loaded', conversationId: 'c', messages: [{ role: 'user', text: '口语一点', receipt: null }], savedAt: 1, folds: [{ id: 'old', at: 0, count: 2 }],
  })
  assert.deepEqual(state.folds, [{ id: 'old', at: 0, count: 2 }])
})
