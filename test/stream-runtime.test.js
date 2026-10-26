import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness } from './fixtures/dsh-harness.js'
import { piAiProviders, providerEnv } from '../src/main/model-providers.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

test('real dsh forwards first live text before a delayed SSE response finishes; cancellation retains the committed prefix', { timeout: DSH_TIMEOUT_MS }, async t => {
  let completedAt = 0
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const model = JSON.parse(body).model
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (content, stop = null) => res.write(`data: ${JSON.stringify({ id: 'stream-test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content }, finish_reason: stop }] })}\n\n`)
    chunk('第一段')
    await new Promise(resolve => setTimeout(resolve, 900))
    if (res.destroyed) return
    chunk('第二段')
    await new Promise(resolve => setTimeout(resolve, 300))
    if (res.destroyed) return
    chunk('', 'stop'); completedAt = Date.now(); res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = { id: 'stream-test', name: 'stream-test', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: ['stream-test'], key: 'test-only' }
  const { bridge, events, defer } = await startHarness(t, { models: () => ({ providers: piAiProviders([provider]), deepseek: false, defaultModel: { provider: provider.id, model: 'stream-test' } }), env: { DEEPSEEK_API_KEY: '', ...providerEnv([provider]) } })
  defer(() => { server.closeAllConnections(); server.close() })
  const agent = bridge(); await agent.start()
  const turn = agent.prompt('验证真实增量')
  const first = await eventually(() => events.find(event => event.update?.sessionUpdate === 'viva_stream' && event.update.kind === 'delta'), { intervalMs: 10 })
  assert.ok(first, 'first delta reaches Viva')
  assert.equal(completedAt, 0, 'server is still holding the rest of the answer')
  assert.equal(events.some(event => event.type === 'turn_end'), false)
  await turn
  assert.equal(replies(events).join(''), '第一段第二段')
  assert.equal(events.filter(event => event.type === 'turn_end').length, 1)
  let state = reduce(initialState, { type: 'user_prompt', text: 'q', at: 0 })
  for (const event of events) if (event.update) state = reduce(state, { type: 'acp_update', update: event.update, at: 1 })
  assert.equal(state.messages.at(-1).text, '第一段第二段')

  const before = events.length
  const cancelled = agent.prompt('取消部分输出')
  await eventually(() => events.slice(before).some(event => event.update?.kind === 'delta'), { intervalMs: 10 })
  await agent.cancel(); await cancelled
  assert.equal(replies(events.slice(before)).join(''), '第一段')
  assert.equal(events.at(-1).stopReason, 'cancelled')
})
