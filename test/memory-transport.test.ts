import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import { createMemoryTransport } from '../plugins/memory/lib/transport.ts'

async function fixture(t: import('node:test').TestContext, status = 200) {
  const bodies: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part)
    bodies.push(body)
    res.writeHead(status, status === 307 ? { location: '/redirected' } : {}); res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const fence = createMemorySendFence({ epoch: 'epoch', admit: () => ({ current: () => true, deadline: null }) })
  let attempts = 0
  const transport = createMemoryTransport({ acquireSend: (id, origin, payload) => { attempts++; return fence.acquire(id, origin, payload) } })
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
