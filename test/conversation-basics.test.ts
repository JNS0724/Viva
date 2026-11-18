import { test } from 'node:test'
import assert from 'node:assert/strict'
import { harness, settle } from './fixtures/conversation-actions.ts'
import { MAX_MESSAGE_CHARS } from '../src/shared/text-limits.ts'

test('normal and image questions keep their visible message and send once', async () => {
  const h = harness()
  assert.equal(h.actions.ask('hello', { via: 'island', images: [{ id: 'pic' }] }), true)
  await settle()
  assert.deepEqual(h.prompts, [{ text: 'hello', images: [{ id: 'pic' }] }])
  assert.deepEqual(h.pictures, ['pic'])
  assert.equal(h.resets(), 1)
  assert.equal(h.state().messages.at(-1)?.text, 'hello')
  assert.equal(h.state().messages.at(-1)?.via, 'island')
})

test('setup, topic switches, empty and oversized questions do not reach the agent', () => {
  const h = harness()
  assert.equal(h.actions.ask(''), false)
  assert.equal(h.actions.ask('x'.repeat(MAX_MESSAGE_CHARS + 1)), false)
  h.change({ switching: true }); assert.equal(h.actions.ask('switching'), false)
  h.change({ switching: false, newTopicPending: true }); assert.equal(h.actions.ask('new'), false)
  h.change({ newTopicPending: false, info: { mode: 'setup', reason: 'no-key', model: '', cwd: '' } })
  assert.equal(h.actions.ask('setup'), false)
  assert.deepEqual(h.prompts, [])
})

test('the current conversation receives the reply and returns to idle', async () => {
  const h = harness()
  h.actions.ask('hello')
  await settle()
  const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } as const
  h.dispatch({ type: 'acp_update', update, at: 124 })
  h.dispatch({ type: 'turn_end', stopReason: 'end_turn', at: 125 })
  assert.deepEqual(h.state().messages.map(({ role, text }) => [role, text]), [['user', 'hello'], ['assistant', 'world']])
  assert.equal(h.state().phase, 'idle')
})
