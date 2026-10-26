import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DSH_TIMEOUT_MS, eventually, startHarness as setup } from './fixtures/dsh-harness.js'

/** The messages plugin inside the real dsh, with the fake model: asked about mail, the model reads it through the app. */

test('asked about mail, the model reads the sources through the app, without a card, and hears the answer', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const asked = []
  const { events, llm, bridge } = await setup(t, {
    messageActions: {
      read: async (request) => {
        asked.push(request)
        return '「163 邮箱」已更新。\n1. 法务部 · 服务合同明天到期'
      },
    },
  })
  const agent = bridge()
  await agent.start()
  await agent.prompt('看看邮件里的 合同')
  await eventually(() => asked.length)
  assert.deepEqual(asked, [{ source: null, query: '合同', sinceHours: 72, limit: 10 }], 'the request, checked, with its defaults')
  const heard = await eventually(() => llm.requests.find((request) => JSON.stringify(request.messages).includes('服务合同明天到期')))
  assert.ok(heard, 'the answer went back to the model as the tool result')
  assert.equal(events.some((event) => event.type === 'permission'), false, 'reading changes nothing, so it asks nothing')
})

test('without sources in the app, the tool says so instead of failing the turn', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, llm, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()
  await agent.prompt('看看邮件')
  const heard = await eventually(() => llm.requests.find((request) => JSON.stringify(request.messages).includes('这个版本的应用没有消息源')))
  assert.ok(heard)
  assert.equal(events.some((event) => event.type === 'error'), false, JSON.stringify(events.filter((event) => event.type === 'error')))
})
