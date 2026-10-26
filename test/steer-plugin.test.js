import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'

/** The steer plugin inside the real dsh: words sent mid-turn reach the model within that same turn. */

const NOTE = '插话：收件人改成李四'

test('words sent while a turn runs reach the model in that turn, which ends once', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t, { configActions: { listServers: () => [], prepareServer: () => {} } })
  const agent = bridge()
  await agent.start()

  // The approval card holds the turn open, as a long tool would.
  const turn = agent.prompt('帮我接入演示服务')
  const card = await eventually(() => events.find((event) => event.type === 'permission'))
  assert.deepEqual(await agent.steer(NOTE), { ok: true })
  agent.respondPermission(card.requestId, 'reject-once')
  await turn

  const after = llm.requests.findIndex((request) => JSON.stringify(request.messages).includes(NOTE))
  assert.ok(after > 0, 'a later request of the turn carries the words')
  assert.equal(events.filter((event) => event.type === 'turn_end').length, 1, 'one turn, not a second prompt')
  assert.equal(events.some((event) => event.type === 'error'), false)
})

test('a job that will take long: the model can offer the background first, and goes on at once', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('把全部文档整理一遍')

  const offered = llm.requests[0].tools.find((tool) => tool.name === 'viva_offer_background')
  assert.ok(offered?.description.includes('放到后台'), 'the model is told when to offer it')
  const call = events.find((event) => event.type === 'update' && event.update.sessionUpdate === 'tool_call')
  assert.ok(call, 'the window sees the offer as a tool call')
  assert.equal(events.some((event) => event.type === 'permission'), false, 'offering asks nothing of the user')
  const answer = replies(events.filter(event => event.type === 'update')).join('')
  assert.match(answer, /开始整理/, 'the model went on with the job')
})

test('with no turn running the plugin says idle, so the app asks it as a new question', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  assert.deepEqual(await agent.steer('在吗'), { ok: false, reason: 'idle' })
})
