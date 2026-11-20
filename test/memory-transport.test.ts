import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { verifiedModelOutput } from '../plugins/memory/lib/stream-output.ts'
import { createMemoryTransport } from '../plugins/memory/lib/transport.ts'

async function fixture(t: import('node:test').TestContext, status = 200, recordBody?: () => void) {
  const bodies: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part)
    bodies.push(body)
    res.writeHead(status, status === 307 ? { location: '/redirected' } : {}); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const fence = createMemorySendFence({ epoch: 'epoch', admit: () => ({ current: () => true, deadline: null }) })
  let attempts = 0
  const transport = createMemoryTransport({ acquireSend: (id, origin, payload) => {
    attempts++
    return { ...fence.acquire(id, origin, payload), recordBody }
  } })
  t.after(async () => { transport.dispose(); await fence.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { bodies, fence, attempts: () => attempts, transport, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model` }
}
test('every SDK retry crosses a new payload-bound permit and releases on observed bodySent', async t => {
  const fixtureState = await fixture(t, 503)
  const { transport, url, bodies, fence } = fixtureState
  for (const text of ['first', 'retry']) await transport.run({ jobId: 'job' }, () => fetch(url, { method: 'POST', body: JSON.stringify({ model: 'fixture', output_config: { effort: 'high' }, messages: [{ role: 'user', content: text }] }) }))
  assert.equal(fixtureState.attempts(), 2)
  assert.equal(bodies.length, 2)
  assert.notEqual(bodies[0], bodies[1])
  assert.equal(fence.pending(), 0)
})
for (const status of [421, 307]) test(`HTTP ${status} cannot resend the body behind the fence`, async t => {
  const { transport, url, bodies } = await fixture(t, status)
  await transport.run({ session: 'session' }, () => fetch(url, { method: 'POST', body: JSON.stringify({ messages: [] }) })).catch(() => {})
  assert.equal(bodies.length, 1)
})
test('history-upload extensions are rejected before any body leaves the process', async t => {
  const { transport, url, bodies } = await fixture(t)
  await assert.rejects(transport.run({ session: 'session' }, () => fetch(url, { method: 'POST', body: JSON.stringify({ messages: [], dsh_session_log: 'old forgotten history' }) })), /Unsupported/)
  assert.equal(bodies.length, 0)
})
test('request construction failure releases the unsent permit and never blocks later mutations', async t => {
  const { transport, url, bodies, fence } = await fixture(t)
  await assert.rejects(transport.run({ session: 'session' }, () => fetch(url, { method: 'POST', headers: { 'invalid\nname': 'value' }, body: JSON.stringify({ messages: [] }) })))
  assert.equal(bodies.length, 0)
  assert.equal(fence.pending(), 0)
  await fence.mutate(() => undefined)
})
test('a native output ledger write must succeed before any prompt bytes are sent', async t => {
  let recorded = 0
  const { transport, url, bodies, fence } = await fixture(t, 200, () => {
    recorded++
    throw new Error('fixture ledger write failed')
  })
  await assert.rejects(transport.run({ session: 'session' }, () => fetch(url, { method: 'POST', body: JSON.stringify({ messages: [] }) })))
  assert.equal(recorded, 1)
  assert.equal(bodies.length, 0)
  await fence.mutate(() => undefined)
})
test('an opaque fetch cannot consume prompt bytes before proving a physical boundary', async () => {
  const original = globalThis.fetch
  const fence = createMemorySendFence({ epoch: 'epoch', admit: () => ({ current: () => true, deadline: null }) })
  let observed = ''
  globalThis.fetch = async (_input, init) => {
    const body = init?.body
    if (!(body instanceof ReadableStream)) throw new Error('Expected gated stream')
    const reader = body.getReader()
    for (;;) { const item = await reader.read(); if (item.done) break; observed += new TextDecoder().decode(item.value) }
    return new Response('{}')
  }
  const transport = createMemoryTransport({ acquireSend: (id, origin, payload) => fence.acquire(id, origin, payload) })
  try {
    await assert.rejects(transport.run({ session: 'session' }, () => fetch('https://unobserved.invalid', {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'must never reach opaque transport' }] }),
    })), /observable request boundary/)
    assert.equal(observed, '')
    assert.equal(fence.pending(), 0)
    await fence.mutate(() => undefined)
  } finally { transport.dispose(); globalThis.fetch = original; await fence.close() }
})

test('a burst of text is delivered in bounded verified batches and never crosses a reasoning block', async () => {
  async function* chunks(): AsyncGenerator<StreamChunk> {
    for (let i = 0; i < 512; i++) yield { type: 'text-delta', index: 0, text: String.fromCharCode(65 + i % 26) }
    yield { type: 'reasoning-delta', index: 1, text: 'think' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const input = chunks()
  const output: StreamChunk[] = []
  let checked = 0
  for await (const item of verifiedModelOutput(() => input.next(), async () => {
    checked++
    await new Promise<void>(resolve => setImmediate(resolve))
    return true
  })) output.push(item)
  assert.ok(checked < 32)
  assert.equal(output.filter(item => item.type === 'text-delta').map(item => item.text).join(''),
    Array.from({ length: 512 }, (_, i) => String.fromCharCode(65 + i % 26)).join(''))
  assert.deepEqual(output.slice(-2), [{ type: 'reasoning-delta', index: 1, text: 'think' }, { type: 'finish', reason: { kind: 'stop' } }])
})

test('already buffered text and tool output stay private after revocation between deliveries', async () => {
  async function* chunks(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'visible' }
    yield { type: 'text-delta', index: 0, text: 'withheld' }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  }
  const source = chunks()
  let allowed = true
  const stream = verifiedModelOutput(() => source.next(), async () => {
    await new Promise<void>(resolve => setImmediate(resolve))
    return allowed
  })
  assert.deepEqual((await stream.next()).value, { type: 'text-delta', index: 0, text: 'visible' })
  allowed = false
  await assert.rejects(stream.next(), /Memory context changed/)
})
