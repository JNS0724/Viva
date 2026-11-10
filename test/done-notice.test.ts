import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDoneNotice, DONE_LOOP_MS } from '../src/renderer/done-notice-actions.ts'
import { initialState, reduce } from './fixtures/task-window.ts'
import { islandView } from '../src/renderer/island-view.ts'
import { catMood, statusView } from '../src/renderer/selectors.ts'

/** 已完成 is news until looked at (done-notice-actions.ts): then 待命; unwatched, it stays, its pose held still. */

const answered = (stopReason = 'end_turn') => {
  let state = reduce(reduce(initialState, {
    type: 'ready', info: { mode: 'live', sessionId: 's', model: 'test-model', cwd: '/w', reason: '' },
  }), { type: 'user_prompt', text: '整理一下周报', at: 100 })
  state = reduce(state, { type: 'acp_update', at: 110, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '周报整理好了。' } } })
  return reduce(state, { type: 'turn_end', stopReason, at: 120 })
}

function setup(looking: boolean, state = answered()) {
  let current = state
  const seen = { looking }
  const notice = createDoneNotice({ getState: () => current, dispatch: (action) => { current = reduce(current, action) }, looking: () => seen.looking })
  return { notice, seen, state: () => current, set: (next: State) => { current = next } }
}

test('a turn done is news: done, moving; held still, still done; seen, the island and she are at rest', () => {
  const done = answered()
  assert.deepEqual([done.doneNotice, islandView(done).form, islandView(done).still, catMood(done)], ['fresh', 'done', undefined, 'done'])
  const still = reduce(done, { type: 'done_still' })
  assert.deepEqual([islandView(still).form, islandView(still).still, islandView(still).summary, catMood(still), statusView(still).tone], ['done', true, '周报整理好了。', 'done', 'done'])
  const seen = reduce(still, { type: 'done_seen' })
  assert.deepEqual([islandView(seen).form, islandView(seen).label, islandView(seen).detail, catMood(seen)], ['idle', '空闲', 'test-model', 'idle'])
  assert.deepEqual(statusView(seen), { tone: 'idle', label: '空闲', event: 'test-model' })
  assert.equal(reduce(seen, { type: 'done_still' }), seen, 'seen is not made news again')
  const next = reduce(reduce(seen, { type: 'user_prompt', text: '再来一个', at: 200 }), { type: 'turn_end', stopReason: 'end_turn', at: 210 })
  assert.equal(next.doneNotice, 'fresh', 'the next turn done is news again')
})

test('a turn that went wrong stays said, seen or not', () => {
  const failed = reduce(answered('max_tokens'), { type: 'done_seen' })
  assert.deepEqual([islandView(failed).form, catMood(failed), statusView(failed).tone], ['error', 'error', 'error'])
})

test('done with the user on the window: seen after one loop of her pose', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { notice, state } = setup(true)
  notice.check()
  t.mock.timers.tick(DONE_LOOP_MS - 1)
  assert.equal(state().doneNotice, 'fresh')
  t.mock.timers.tick(1)
  assert.equal(state().doneNotice, 'seen')
})

test('done with nobody looking: held still after two loops, kept done; seen a loop after the window is come to', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { notice, seen, state } = setup(false)
  notice.check()
  notice.check()
  t.mock.timers.tick(DONE_LOOP_MS * 2)
  assert.equal(state().doneNotice, 'still')
  t.mock.timers.tick(DONE_LOOP_MS * 100)
  assert.equal(state().doneNotice, 'still', 'not missed: it waits for the user')
  seen.looking = true
  notice.check()
  t.mock.timers.tick(DONE_LOOP_MS)
  assert.equal(state().doneNotice, 'seen')
})

test('the window left before the loop is over: not seen after all', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { notice, seen, state } = setup(true)
  notice.check()
  t.mock.timers.tick(DONE_LOOP_MS / 2)
  seen.looking = false
  notice.check()
  t.mock.timers.tick(DONE_LOOP_MS * 2)
  assert.equal(state().doneNotice, 'still')
})

test('read on the desktop island: seen at once; a new turn under way waits for nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const away = setup(false)
  away.notice.check()
  away.notice.seen()
  assert.equal(away.state().doneNotice, 'seen')
  t.mock.timers.tick(DONE_LOOP_MS * 2)
  assert.equal(away.state().doneNotice, 'seen', 'the held-still timer went with it')

  const working = setup(true)
  working.set(reduce(working.state(), { type: 'user_prompt', text: '继续', at: 300 }))
  working.notice.check()
  t.mock.timers.tick(DONE_LOOP_MS * 3)
  assert.equal(working.state().doneNotice, 'fresh', 'nothing done to see while it works')
})

test('a turn stopped stays 已停止 once seen, on the island and in the status alike', () => {
  const stopped = reduce(answered('cancelled'), { type: 'done_seen' })
  assert.deepEqual([islandView(stopped).label, statusView(stopped).label, catMood(stopped)], ['已停止', '已停止', 'idle'])
})
