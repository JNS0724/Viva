import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DiscoveryError, discoverModels, listingUrl, MAX_RESPONSE_BYTES, readListing, type DiscoveryFetch } from '../src/backend/model-discovery.ts'

/** 获取可用模型 asks the endpoint the user typed, the way dsh's own discovery does (dsh-llm-pi-ai discovery.js). */

type Seen = { url: string, headers: Record<string, string> }

/** A fetch that answers `reply` and keeps what it was asked. */
function answering(reply: () => Response | Promise<Response>) {
  const seen: Seen[] = []
  const fetch: DiscoveryFetch = async (url, init) => {
    seen.push({ url, headers: init.headers })
    return reply()
  }
  return { fetch, seen }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A real endpoint on this machine, answering each GET with `handle`. */
async function endpoint(t: TestContext, handle: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handle)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

test('OpenAI protocols list at {baseURL}/models; Anthropic at its root /v1/models, whichever way the base is written', () => {
  assert.equal(listingUrl('https://gw.example/openai/v1/', 'openai-completions'), 'https://gw.example/openai/v1/models')
  assert.equal(listingUrl('https://api.example/v1', 'openai-responses'), 'https://api.example/v1/models')
  assert.equal(listingUrl('https://api.anthropic.com', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000')
  assert.equal(listingUrl('https://api.anthropic.com/v1', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000')
})

test('the key goes as a bearer for OpenAI and as x-api-key with a version for Anthropic; none when there is none', async () => {
  const { fetch, seen } = answering(() => json({ data: [] }))
  await discoverModels({ api: 'openai-completions', baseURL: 'https://a.example/v1', key: 'sk-a' }, { fetch })
  await discoverModels({ api: 'anthropic-messages', baseURL: 'https://b.example', key: 'sk-b' }, { fetch })
  await discoverModels({ api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', key: '' }, { fetch })
  assert.deepEqual(seen.map((one) => one.headers), [
    { accept: 'application/json', authorization: 'Bearer sk-a' },
    { accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-b' },
    { accept: 'application/json' },
  ])
})

test('a listing reads as models in its order, with the sizes it gives under any of the names gateways use', () => {
  assert.deepEqual(readListing({
    data: [
      { id: 'glm-5.2', context_length: 131072, top_provider: { max_completion_tokens: 8192 } },
      { id: 'claude-x', display_name: 'Claude X', max_input_tokens: 200000, max_output_tokens: 64000 },
      { id: 'qwen3:8b', object: 'model' },
      { name: 'no id' }, 'not a row', { id: 'glm-5.2' },
      { id: 'odd', context_window: 1.5, maxTokens: -2 },
    ],
  }), [
    { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 131072, maxTokens: 8192 },
    { id: 'claude-x', name: 'Claude X', contextWindow: 200000, maxTokens: 64000 },
    { id: 'qwen3:8b', name: 'qwen3:8b' },
    { id: 'odd', name: 'odd' },
  ])
  assert.deepEqual(readListing({ models: { 'alias-a': { id: 'canonical/a', name: 'A', limit: { context: 65536, output: 4096 } }, version: 3 } }), [
    { id: 'alias-a', name: 'A', contextWindow: 65536, maxTokens: 4096 },
  ], 'a models map: the key is the id requests use')
  assert.throws(() => readListing({ object: 'list' }))
  assert.throws(() => readListing(null))
})

test('what goes wrong is told apart: the key refused, another status, not JSON, not a listing, unreachable, too slow', async () => {
  const reason = async (reply: () => Response | Promise<Response>, timeoutMs?: number) => {
    const { fetch } = answering(reply)
    try {
      await discoverModels({ api: 'openai-completions', baseURL: 'https://x.example/v1', key: 'sk-x' }, { fetch, timeoutMs })
      return 'listed'
    } catch (err) {
      assert.ok(err instanceof DiscoveryError)
      return `${err.reason}${err.status ? ` ${err.status}` : ''}`
    }
  }
  assert.equal(await reason(() => json({ error: 'no' }, 401)), 'refused 401')
  assert.equal(await reason(() => json({ error: 'no' }, 403)), 'refused 403')
  assert.equal(await reason(() => json({}, 404)), 'status 404')
  assert.equal(await reason(() => new Response('<html>')), 'not-json')
  assert.equal(await reason(() => json({ object: 'list' })), 'not-a-listing')
  assert.equal(await reason(() => { throw new TypeError('fetch failed') }), 'unreachable')
  assert.equal(await reason(() => new Promise((_, fail) => setTimeout(() => fail(new Error('aborted')), 50)), 10), 'timeout')
})

test('a real endpoint is asked over HTTP; an answer past the limit is refused, declared or not', async (t) => {
  const asked: string[] = []
  const url = await endpoint(t, (req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`)
    if (req.url === '/big/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      // Streamed, so no length is declared: what came is what counts.
      const chunk = Buffer.alloc(1024 * 1024, ' ')
      for (let sent = 0; sent <= MAX_RESPONSE_BYTES; sent += chunk.length) res.write(chunk)
      res.end('{"data":[]}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'local-a' }, { id: 'local-b', context_length: 32768 }] }))
  })
  assert.deepEqual(await discoverModels({ api: 'openai-completions', baseURL: `${url}/v1`, key: 'sk-local' }), [
    { id: 'local-a', name: 'local-a' }, { id: 'local-b', name: 'local-b', contextWindow: 32768 },
  ])
  await assert.rejects(discoverModels({ api: 'openai-completions', baseURL: `${url}/big`, key: '' }), (err) => err instanceof DiscoveryError && err.reason === 'too-large')
  assert.deepEqual(asked, ['GET /v1/models Bearer sk-local', 'GET /big/models '])
})
