import { decodePermission } from '../src/renderer/agent-event-decoder.ts'
import { recordingActions } from './fixtures/recording-config.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.ts'
import { DEMO_SERVER } from './fixtures/fake-llm.ts'

/** The config plugin inside the real dsh: the model sets up a server; the user approves and types its key. */

const KEY = 'tok-secret-123'

test('a server is set up only after the card is allowed and its key typed, and the model never sees the key', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { added, actions } = recordingActions()
  const { events, llm, bridge } = await setup(t, { configActions: actions })
  const agent = bridge()
  await agent.start()

  const turn = agent.prompt('帮我接入演示服务')
  const card = await eventually(() => events.find((event) => event.type === 'permission'))
  assert.equal(decodePermission(card)?.toolCall.toolCallId !== undefined, true, 'the change waits on the approval card first')
  assert.equal(events.some((event) => event.type === 'secret_request'), false, 'no key is asked for before the yes')
  assert.ok(card && typeof card.requestId === 'string')
  agent.respondPermission(card.requestId, 'allow-once')

  const asked = await eventually(() => events.find((event) => event.type === 'secret_request'))
  assert.ok(asked && typeof asked.requestId === 'string')
  assert.deepEqual([asked.server, asked.names], [DEMO_SERVER.name, DEMO_SERVER.secrets])
  assert.equal(agent.provideSecrets(asked.requestId, { DEMO_TOKEN: KEY }), true)
  await turn

  assert.deepEqual(added.map(([spec, secrets]) => [spec.name, spec.command, secrets]), [['demo', 'node', { DEMO_TOKEN: KEY }]])
  assert.ok(replies(events).join('').includes('配置结果：已接入 MCP 服务器「demo」'), 'the model was told')
  assert.equal(JSON.stringify(llm.requests).includes(KEY), false, 'the key never reaches the model')
})

test('rejecting the card sets up nothing and asks for no key', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { added, actions } = recordingActions()
  const { events, bridge } = await setup(t, { configActions: actions })
  const agent = bridge()
  await agent.start()

  const turn = agent.prompt('帮我接入演示服务')
  const card = await eventually(() => events.find((event) => event.type === 'permission'))
  assert.ok(card && typeof card.requestId === 'string')
  agent.respondPermission(card.requestId, 'reject-once')
  await turn

  assert.deepEqual(added, [])
  assert.equal(events.some((event) => event.type === 'secret_request'), false)
  assert.ok(replies(events).join('').includes('配置结果：'), 'the model hears it was refused')
})
