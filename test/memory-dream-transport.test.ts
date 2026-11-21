import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { completeMemoryModel } from '../plugins/memory/lib/model.ts'
import { createMemoryTransport } from '../plugins/memory/lib/transport.ts'
import { createMemorySendFence } from '../src/memory/core/send-fence.ts'
import { createMemoryDreamTools } from '../src/memory/core/memory-dream-tools.ts'
import type { MemoryCompute } from '../src/memory/contracts/memory-contract.ts'
import type { MemoryToolInvocation } from '../src/memory/contracts/service.ts'

type Json = MemoryToolInvocation['input']
type WireBlock = { type: string, id?: string, name?: string, thinking?: string, signature?: string, text?: string, tool_use_id?: string, content?: Json }
type WireRequest = { model: string, messages: Array<{ role: string, content: WireBlock[] }>, tools: Array<{ name: string, input_schema: Json }> }
const path = 'digest/wiki/deployment.md'
const addedSource = { namespace: 'canonical', sourceId: 'newly-read-source', revision: 1 }
const reasoning = 'Inspect node metadata, then inspect its evidence before integrating.'
const signature = 'native-reasoning-signature'
const job: MemoryCompute = { id: 'dream-job', sourceId: 'initial-source', generation: 1, stage: 'dream', provider: 'deepseek-official', model: 'fixture', system: 'Integrate a document.', input: 'Deployment unit' }

function stream(response: ServerResponse, model: string, call?: { id: string, name: string, input: Json }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send('message_start', { message: { id: 'message-' + (call?.id ?? 'done'), type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  if (call) {
    send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: reasoning } })
    send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature } })
    send('content_block_stop', { index: 0 })
    send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
    send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
    send('content_block_stop', { index: 1 })
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'integration complete' } })
    send('content_block_stop', { index: 0 })
  }
  send('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } })
  send('message_stop', {})
  response.end()
}

async function fixture(t: TestContext, { withdrawAfterTool = false, failSecondRequest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-dream-transport-'))
  const requests: WireRequest[] = [], attempts: Array<{ id: string, payload: string, sources: string[], jobId: string }> = []
  const reads = new Set(['initial-source']), withdrawn = new Set<string>()
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += String(part)
    const body = JSON.parse(raw) as WireRequest
    requests.push(body)
    if (failSecondRequest && requests.length === 2) {
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'api_error', message: 'temporary fixture outage' } }))
      return
    }
    const results = body.messages.flatMap(message => message.content.filter(block => block.type === 'tool_result'))
    if (!results.some(result => result.tool_use_id === 'search-1')) stream(response, body.model, { id: 'search-1', name: 'node_search', input: { query: 'Deployment' } })
    else if (!results.some(result => result.tool_use_id === 'read-2')) stream(response, body.model, { id: 'read-2', name: 'read', input: { path } })
    else stream(response, body.model)
  })
  server.on('error', () => {})
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }) }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error }
  const fence = createMemorySendFence({ epoch: 'test-owner', admit: () => ({ current: () => [...reads].every(id => !withdrawn.has(id)), deadline: null }) })
  const transport = createMemoryTransport({ acquireSend(id, origin, payload) {
    assert('jobId' in origin)
    attempts.push({ id, payload, sources: [...reads], jobId: origin.jobId })
    return fence.acquire(id, origin, payload)
  } })
  const ctx = new Context(), llm = new LlmRuntime(ctx)
  const configuration = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    models: [{ id: 'fixture' }], retryPolicy: { mode: 'normal', maxRetries: 0 } })
  const adapter = new DeepSeekAdapter({ options: () => configuration,
    resolveAuth: async () => ({ headers: { authorization: 'Bearer local-fixture' } }),
    resolveUserId: () => getOrCreateAnonymousUserId({ env: { DSH_HOME: root } }),
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  const dispose = llm.registerAdapter(['deepseek-official'], adapter)
  t.after(async () => {
    dispose(); transport.dispose(); await fence.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  const snapshot = { path, revision: 'document-v1', markdown: '---\nname: Deployment\ndescription: Deployment procedure\n---\nRead the current deployment evidence.', sources: [addedSource], usageVersion: 1 }
  const tools = createMemoryDreamTools({
    documents: { list: () => [snapshot], read: candidate => candidate === path ? snapshot : null },
    onRead: snapshot => { for (const source of snapshot.sources) reads.add(source.sourceId) },
  })
  const capability = { tools: tools.tools, executeTool: async (invocation: MemoryToolInvocation) => {
    const result = await tools.executeTool(invocation)
    if (withdrawAfterTool) await fence.mutate(() => { withdrawn.add(addedSource.sourceId) })
    return result
  } }
  const run = (id = job.id) => transport.run({ jobId: id }, () => completeMemoryModel(ctx, { ...job, id }, AbortSignal.timeout(10_000), capability))
  return { requests, attempts, reads, withdrawn, fence, run }
}

test('real DeepSeek HTTP dream loop preserves native thinking/call IDs and fences each expanded readset', async t => {
  const f = await fixture(t)
  assert.equal(await f.run(), 'integration complete')
  assert.equal(f.requests.length, 3)
  assert.deepEqual(f.requests[0]!.tools.map(tool => tool.name), ['node_search', 'read'])
  assert.deepEqual(f.attempts.map(attempt => attempt.sources), [['initial-source'], ['initial-source', addedSource.sourceId], ['initial-source', addedSource.sourceId]])
  assert.equal(new Set(f.attempts.map(attempt => attempt.id)).size, 3)
  assert.equal(new Set(f.attempts.map(attempt => attempt.payload)).size, 3)
  for (const request of f.requests.slice(1)) {
    const blocks = request.messages.flatMap(message => message.content)
    assert(blocks.some(block => block.type === 'thinking' && block.thinking === reasoning && block.signature === signature))
    assert(blocks.some(block => block.type === 'tool_use' && block.id === 'search-1' && block.name === 'node_search'))
    assert(blocks.some(block => block.type === 'tool_result' && block.tool_use_id === 'search-1'))
  }
  const final = f.requests[2]!.messages.flatMap(message => message.content)
  assert(final.some(block => block.type === 'tool_result' && block.tool_use_id === 'read-2' && JSON.stringify(block.content).includes('Read the current deployment evidence.')))
  assert.equal(f.fence.pending(), 0)
})

test('withdrawing a newly-read node source prevents the next real provider HTTP request', async t => {
  const f = await fixture(t, { withdrawAfterTool: true })
  await assert.rejects(f.run())
  assert.equal(f.requests.length, 1)
  assert.equal(f.attempts.length, 2)
  assert(f.attempts[1]!.sources.includes(addedSource.sourceId))
  assert.equal(f.fence.pending(), 0)
})

test('retrying a dream job after real HTTP 503 obtains fresh physical permits with its dependency set', async t => {
  const f = await fixture(t, { failSecondRequest: true })
  await assert.rejects(f.run())
  assert.equal(f.requests.length, 2)
  assert.equal(await f.run('dream-job-retry'), 'integration complete')
  assert.equal(f.requests.length, 5)
  assert.equal(new Set(f.attempts.map(attempt => attempt.id)).size, 5)
  assert(f.attempts.slice(1).every(attempt => attempt.sources.includes(addedSource.sourceId)))
  assert(f.attempts.slice(2).every(attempt => attempt.jobId === 'dream-job-retry'))
  assert.equal(f.fence.pending(), 0)
})

test('a source withdrawn after HTTP failure cannot escape through the recovered dream job', async t => {
  const f = await fixture(t, { failSecondRequest: true })
  await assert.rejects(f.run())
  await f.fence.mutate(() => { f.withdrawn.add(addedSource.sourceId) })
  await assert.rejects(f.run('dream-job-recovery'))
  assert.equal(f.requests.length, 2)
  assert.equal(f.attempts.length, 3)
  assert.equal(f.attempts[2]!.jobId, 'dream-job-recovery')
  assert.equal(f.fence.pending(), 0)
})
