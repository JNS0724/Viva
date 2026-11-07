import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEQ_HEADER } from '../src/backend/wire.ts'
import { backendWith, post, TOKEN } from './fixtures/backend-wire.ts'

test('a call after the connection sat idle goes through (the server keeps its sockets)', async (t) => {
  const { connection } = await backendWith(t, { 'agent:info': () => 'info' })
  assert.equal(await connection.rpc('agent:info', []), 'info')
  await new Promise((resolve) => setTimeout(resolve, 5_500))
  assert.equal(await connection.rpc('agent:info', []), 'info')
})

test('a call whose turn never comes holds up the next ones only for a while', async (t) => {
  const { port } = await backendWith(t, { 'agent:info': () => 'info' })
  const started = Date.now()
  const late = await post(port, '/rpc/agent:info', { headers: { authorization: `Bearer ${TOKEN}`, [SEQ_HEADER]: '2' } })
  assert.deepEqual(JSON.parse(late.body), { ok: true, value: 'info', mark: 0 })
  assert.ok(Date.now() - started >= 4_900, 'it waited for number 1 first')
})

