import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelValue, piAiProviders, providerEnv } from '../src/main/model-providers.ts'
import { DSH_TIMEOUT_MS, replies, startHarness } from './fixtures/dsh-harness.js'
import { OPENAI_REPLY, startFakeOpenAi } from './fixtures/fake-openai.js'

/** Providers the user adds besides DeepSeek, served by the real dsh through the profile the app writes. */

const GATEWAY_KEY = 'sk-gateway-0000000000abcd'

test('without a DeepSeek key the added provider is the only model, sessions start on it, and memory rides along', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const gateway = (llm) => ({ id: 'custom-gateway', name: '公司网关', api: 'anthropic-messages', baseURL: llm.url, models: ['gw-model'], key: GATEWAY_KEY })
  const { llm, events, bridge } = await startHarness(t, {
    models: (fake) => ({ providers: piAiProviders([gateway(fake)]), deepseek: false, defaultModel: { provider: 'custom-gateway', model: 'gw-model' } }),
    env: { DEEPSEEK_API_KEY: '', ...providerEnv([gateway({ url: '' })]) },
  })
  const agent = bridge()

  const info = await agent.start()
  assert.deepEqual(info.models.map(({ group, name }) => [group, name]), [['公司网关', 'gw-model']], 'DeepSeek is not offered without a key')
  assert.equal(info.modelValue, modelValue({ provider: 'custom-gateway', model: 'gw-model' }))

  await agent.prompt('你好')
  assert.deepEqual(events.filter((event) => event.type === 'error'), [])
  const request = llm.requests.at(-1)
  assert.equal(request.model, 'gw-model')
  assert.match(JSON.stringify(request.messages), /【今天】/, 'the memory plugin adds its context whatever the model')
})

test('an OpenAI-compatible provider sits beside DeepSeek and answers once picked, with its key', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const openai = await startFakeOpenAi()
  const provider = { id: 'custom-openai', name: 'OpenAI 兼容', api: 'openai-completions', baseURL: openai.url, models: ['oa-model'], key: GATEWAY_KEY }
  const { llm, events, bridge, defer } = await startHarness(t, {
    models: () => ({ providers: piAiProviders([provider]), deepseek: true, defaultModel: null }),
    env: providerEnv([provider]),
  })
  defer(() => openai.close())
  const agent = bridge()

  const info = await agent.start()
  assert.deepEqual([...new Set(info.models.map((model) => model.group))].sort(), ['DeepSeek', 'OpenAI 兼容'])
  const picked = await agent.setConfig('model', modelValue({ provider: 'custom-openai', model: 'oa-model' }))
  assert.equal(picked.modelValue, modelValue({ provider: 'custom-openai', model: 'oa-model' }))

  const before = llm.requests.length
  await agent.prompt('你好')
  assert.deepEqual(events.filter((event) => event.type === 'error'), [])
  assert.equal(replies(events).join(''), OPENAI_REPLY)
  assert.deepEqual(openai.requests.map(({ path, authorization, body }) => [path, authorization, body.model]), [['/v1/chat/completions', `Bearer ${GATEWAY_KEY}`, 'oa-model']])
  assert.equal(llm.requests.length, before, 'nothing went to DeepSeek')
})
