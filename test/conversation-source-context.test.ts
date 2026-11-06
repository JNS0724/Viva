import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQuestionDesk } from '../src/backend/question-channel.ts'
import { createConfigDesk, type ConfigActions } from '../src/backend/config-channel.ts'
import type { ConversationContext } from '../src/shared/conversation-context.ts'

const old = { conversationId: 'c-old', sessionId: 'same-session' }, next = { conversationId: 'c-new', sessionId: 'same-session' }
const asked = { type: 'question', id: 'q', sessionId: old.sessionId, questions: [{ id: 'city', question: 'Which city?', options: [] }] }
const noop = () => ''
const actions: ConfigActions = {
  listServers: () => [], prepareServer: () => {}, prepareUpdate: () => {}, addServer: noop, updateServer: noop,
  removeServer: noop, importServers: noop, listSkills: () => [], createSkill: noop, installSkill: noop, removeSkill: noop,
}

test('question shown and closed keep their request context across a same-session segment selection', () => {
  const seen: Array<Record<string, unknown>> = []
  let context: ConversationContext = old
  const desk = createQuestionDesk({ send: () => {}, emit: event => { seen.push(event) }, sessionId: () => old.sessionId, conversationContext: () => context })
  desk.receive(asked); context = next; desk.declineAll()
  assert.deepEqual(seen.map(event => event.context), [old, old])
})

test('credential closure uses the original request context without ever publishing credential values', () => {
  const seen: Array<Record<string, unknown>> = []
  let context: ConversationContext = old
  const desk = createConfigDesk({ actions, send: () => {}, emit: event => { seen.push(event) }, sessionId: () => old.sessionId, conversationContext: () => context })
  desk.receive({ type: 'config', id: 'request', sessionId: old.sessionId, op: 'mcp_add', args: { name: 'service', command: 'npx', secrets: ['TOKEN'] } })
  context = next; desk.closeAll()
  assert.deepEqual(seen.map(event => event.context), [old, old])
  assert.deepEqual(seen.map(event => event.type), ['secret_request', 'secret_closed'])
  assert.equal(seen.some(event => 'values' in event), false)
})

test('late foreground plugin requests with no active operation context are declined, even if the session id was reused', () => {
  const sent: object[] = [], seen: object[] = []
  const questions = createQuestionDesk({ send: event => { sent.push(event) }, emit: event => { seen.push(event) }, sessionId: () => old.sessionId, conversationContext: () => null })
  questions.receive(asked)
  const config = createConfigDesk({ actions, send: event => { sent.push(event) }, emit: event => { seen.push(event) }, sessionId: () => old.sessionId, conversationContext: () => null })
  config.receive({ type: 'config', id: 'request', sessionId: old.sessionId, op: 'mcp_add', args: { name: 'service', command: 'npx', secrets: ['TOKEN'] } })
  assert.deepEqual(seen, [])
  assert.equal(sent.length, 2)
})
