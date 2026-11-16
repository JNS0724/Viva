import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { TestContext } from 'node:test'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'

/** Actual DSH child owns storage, ingestion, computation, tools and dispatch. The host only calls RPC. */
async function setupMemory(t: TestContext, options?: Parameters<typeof setup>[1]) {
  const harness = await setup(t, options)
  const agent = harness.bridge({ memoryRequired: true })
  let session = (await agent.start()).sessionId!
  assert.ok(await eventually(() => agent.memory.ready()), 'independent memory owner becomes ready')
  const call = agent.memory.call
  async function ask(text: string) {
    const sourceId = randomUUID()
    await call('sourceAlias', { operationId: randomUUID(), sourceId, session,
      conversation: 'memory-integration', text })
    return agent.prompt(text, [], { userTurn: true, sourceId })
  }
  async function freshSession() { session = (await agent.newSession()).sessionId! }
  async function saved(text: string) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const found = (await call('listMemories', { args: [] })).items.find(item => item.text === text && !item.conditional)
      if (found || Date.now() > deadline) return found
      await new Promise(resolve => setTimeout(resolve, 80))
    }
  }
  return { ...harness, agent, call, ask, freshSession, saved, session: () => session }
}
interface ModelRequest { system?: unknown, messages: { content: string | { type: string, text?: string }[] }[] }
function lastContext(llm: { requests: object[] }) {
  const foreground = (llm.requests as ModelRequest[]).findLast(request => JSON.stringify(request.system ?? '').includes('你是用户的个人工作助手')
    && JSON.stringify(request.messages.at(-1)).includes('<about-user>'))
  return JSON.stringify(foreground?.messages.at(-1) ?? '')
}

test('the sole plugin owner injects manual profile and saves evidence from a native memory tool', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, events, ask, call, freshSession, saved } = await setupMemory(t)
  await call('setProfile', { args: [{ role: '后端负责人' }] })
  await ask('你好')
  assert.match(lastContext(llm), /后端负责人/, JSON.stringify({ events, requests: llm.requests }))
  const text = '周报每周五下班前交给张三'
  await ask(`记住：${text}`)
  assert.equal(events.some(event => event.type === 'permission'), false)
  const entry = await saved(text)
  assert.ok(entry, JSON.stringify(events))
  assert.equal(entry.evidence.length, 1)
  assert.ok(entry.evidence[0]!.sourceId)
  await freshSession()
  await ask('帮我写周报')
  assert.match(lastContext(llm), /周报每周五下班前交给张三/)
  assert.ok(llm.requests.every(request => !JSON.stringify(request).includes('dsh_session_log')), 'raw session-log upload must stay disabled')
})

test('host forgetting invalidates dependent main and task requests at the plugin send boundary', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, ask, call, agent, freshSession } = await setupMemory(t)
  const text = '周报发到 old-address@example.com'
  const entry = await call('addMemory', { args: [text] })
  assert.ok(entry)
  await ask('周报怎么提交？')
  assert.match(lastContext(llm), /old-address@example.com/)
  const task = await agent.startTask()
  assert.ok(task.ok)
  const provenance = await call('provenance', { args: [agent.currentSession()!] })
  if (task.ok) await call('transfer', { args: [task.taskId, provenance, undefined, true] })
  const current = (await call('listMemories', { args: [] })).items.find(item => item.id === entry.id)!
  await call('deleteMemory', { args: [current.id, current.revision, randomUUID()] })
  const before = llm.requests.length
  await agent.prompt('禁止发送 stale-memory-marker').catch(() => {})
  if (task.ok) await agent.promptTask(task.taskId, '禁止发送 stale-task-marker').catch(() => {})
  assert.ok(llm.requests.slice(before).every(request => !/stale-(?:memory|task)-marker/u.test(JSON.stringify(request))), 'neither dependent request crosses the wire')
  await freshSession()
  await ask('新会话可以继续')
  assert.ok(llm.requests.slice(before).some(request => JSON.stringify(request).includes('新会话可以继续')))
  assert.ok(llm.requests.slice(before).every(request => !JSON.stringify(request).includes('old-address@example.com')))
})

test('trusted source aliases are idempotent and preserve exact original evidence without interpreting headers', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { agent, call, session, saved } = await setupMemory(t)
  const text = '记住：周报每周五交给李四'
  const alias = { operationId: randomUUID(), sourceId: randomUUID(), session: session(), conversation: 'aliases', text }
  assert.deepEqual(await call('sourceAlias', alias), await call('sourceAlias', alias))
  await assert.rejects(call('sourceAlias', { ...alias, text: 'different text' }))
  await agent.prompt(text, [], { sourceId: alias.sourceId })
  const entry = await saved('周报每周五交给李四')
  assert.ok(entry)
  assert.equal(entry.evidence.length, 1)
  assert.equal(entry.evidence[0]!.sourceId, alias.sourceId)
})

test('owner survives a DSH process restart with the same durable records and a new instance epoch', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { agent, bridge, call } = await setupMemory(t)
  const entry = await call('addMemory', { args: ['周报在周五提交'] })
  assert.ok(entry)
  const epoch = agent.memory.state()!.epoch
  await agent.dispose()
  const restarted = bridge()
  await restarted.start()
  assert.ok(await eventually(() => restarted.memory.ready()))
  assert.notEqual(restarted.memory.state()!.epoch, epoch)
  const records = await restarted.memory.call('listMemories', { args: [] })
  assert.ok(records.items.some(item => item.id === entry.id && item.text === entry.text))
})

test('an idle interjection starts neither a fast request nor a routing decision', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, agent, ask, requests } = await setupMemory(t)
  await ask('先看看这份报告')
  const before = llm.requests.length
  assert.deepEqual(await agent.steer('把会议纪要另交给后台'), { ok: false, reason: 'idle' })
  assert.equal(llm.requests.length, before)
  assert.deepEqual(requests.endTurn({ sessionId: agent.currentSession()!, reason: 'unrouted' }), [])
})

test('the plugin preserves Viva persona and normal conversation replies', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, events, ask } = await setupMemory(t)
  await ask('你好')
  assert.match(JSON.stringify(llm.requests[0]), /你是用户的个人工作助手/)
  assert.match(JSON.stringify(llm.requests[0]), /Current working directory:/)
  assert.doesNotMatch(JSON.stringify(llm.requests[0]), /coding agent/)
  assert.ok(replies(events).join('').includes('你好'))
})


test('native explicit correction and forgetting publish local receipts without a model request', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, ask, call, freshSession, dshHome } = await setupMemory(t)
  const original = await call('addMemory', { args: ['周报周五提交'] })
  assert.ok(original)
  let offset = llm.requests.length
  await ask(`更正 #${original.id} 为 周报周一提交`)
  assert.ok(llm.requests.slice(offset).every(request => !JSON.stringify(request).includes(`更正 #${original.id}`)))
  const corrected = (await call('listMemories', { args: [] })).items.find(item => item.text === '周报周一提交')
  assert.ok(corrected)
  await freshSession()
  offset = llm.requests.length
  await ask(`忘记 #${corrected.id}`)
  assert.ok(llm.requests.slice(offset).every(request => !JSON.stringify(request).includes(`忘记 #${corrected.id}`)))
  assert.equal((await call('listMemories', { args: [] })).items.some(item => item.id === corrected.id), false)
  const logs = readdirSync(dshHome, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.jsonl(?:\.zstd)?$/u.test(entry.name))
    .map(entry => {
      const bytes = readFileSync(join(entry.parentPath, entry.name))
      if (!entry.name.endsWith('.zstd')) return bytes.toString('utf8')
      let offset = 0, text = ''
      while (offset < bytes.length) {
        // Node's info:true result is not reflected in @types/node's zstd overload.
        const decoded = zstdDecompressSync(bytes.subarray(offset), { info: true }) as unknown as { buffer: Buffer, engine: { bytesWritten: number } }
        assert.ok(decoded.engine.bytesWritten > 0)
        offset += decoded.engine.bytesWritten
        text += decoded.buffer.toString('utf8')
      }
      return text
    }).join('\n')
  assert.match(logs, /command\/done/u)
  assert.match(logs, /has been corrected/u)
  assert.match(logs, /is no longer used/u)
})
