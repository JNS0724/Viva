import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createNewTopicAction, isPreviousTopicEvent } from '../src/renderer/new-topic-actions.ts'
import { showsHome } from '../src/renderer/view/render.ts'

test('new topic is visible and focused before runtime readiness; double clicks and retries keep one topic', async () => {
  let state = { ...initialState, conversationId: 'old', info: { mode: 'live', cwd: '/w', sessionId: 'old' }, messages: [{ id: 'm1', role: 'user', text: 'old words' }] }
  let finish, fail, calls = 0, focused = 0, jumped = 0
  const timings = []
  const action = createNewTopicAction({
    getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    open: () => { calls++; return new Promise((resolve, reject) => { finish = resolve; fail = reject }) },
    focus: () => { focused++ }, jump: () => { jumped++ }, toast: assert.fail,
    errorMessage: (error) => error.message, measure: (timing) => timings.push(timing),
  })
  const pending = action()
  assert.equal(focused, 1)
  assert.equal(jumped, 1)
  assert.equal(state.switching, true)
  assert.equal(state.newTopicPending, true)
  assert.deepEqual(state.messages, [])
  assert.equal(state.earlier.segments[0].messages[0].text, 'old words')
  await action()
  assert.equal(calls, 1, 'a second click cannot open a second session')
  fail(new Error('MCP unavailable'))
  await pending
  assert.equal(state.switching, false)
  assert.equal(state.newTopicPending, true, 'sending remains blocked after failure')
  assert.match(state.error, /MCP unavailable/)
  state = reduce(state, { type: 'ready', info: { mode: 'live', sessionId: 'reconnected-old', cwd: '/w' } })
  assert.equal(state.newTopicPending, true, 'a runtime reconnect cannot silently send the draft into its session')
  assert.match(state.error, /MCP unavailable/)
  const earlier = state.earlier
  const topic = state.topic
  const retry = action()
  assert.equal(state.earlier, earlier, 'retry does not archive the same history again')
  assert.equal(state.topic, topic, 'retry prepares the already displayed topic')
  finish({ mode: 'live', cwd: '/w', sessionId: 'new' })
  await retry
  assert.equal(state.newTopicPending, false)
  assert.equal(state.switching, false)
  assert.equal(state.info.sessionId, 'new')
  assert.equal(state.earlier, earlier)
  assert.deepEqual(timings.map(t => t.stage), ['ui', 'failed', 'ui', 'ready'])
})

test('late foreground events are excluded while background task events remain usable', () => {
  for (const type of ['update', 'turn_end', 'config', 'question', 'question_closed', 'memory_context', 'followup_propose']) {
    assert.equal(isPreviousTopicEvent({ type }), true, type)
  }
  assert.equal(isPreviousTopicEvent({ type: 'permission' }), true)
  assert.equal(isPreviousTopicEvent({ type: 'permission', taskId: 'background' }), false)
  for (const type of ['task_update', 'task_end', 'task_question', 'error', 'prepare_state']) assert.equal(isPreviousTopicEvent({ type }), false, type)
})

test('an empty topic still displays preparation failure instead of hiding it behind the welcome screen', () => {
  const pending = reduce(initialState, { type: 'new_session_pending', at: 1 })
  const failed = reduce(pending, { type: 'new_session_failed', message: 'offline' })
  assert.equal(showsHome(pending), false)
  assert.equal(showsHome(failed), false)
})
