import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { questionOf, routeFixtureTools } from './fixtures/fake-llm.ts'
import { delayNativeOutputReceipts, DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.ts'
import { ownerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { objectOf } from '../src/memory/contracts/unknown-value.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'

/** The real DSH adapter and the separate storage owner communicate through the backend relay. */
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
  return { ...harness, agent, call, ask, freshSession, session: () => session }
}
interface ModelRequest { system?: unknown, messages: { content: string | { type: string, text?: string }[] }[] }
function lastContext(llm: { requests: object[] }) {
  const foreground = (llm.requests as ModelRequest[]).findLast(request => JSON.stringify(request.system ?? '').includes('你是用户的个人工作助手')
    && JSON.stringify(request.messages.at(-1)).includes('<about-user>'))
  return JSON.stringify(foreground?.messages.at(-1) ?? '')
}

test('a resumed task publishes its committed answer after its native output receipt reaches the owner', { timeout: DSH_TIMEOUT_MS }, async t => {
  const harness = await setup(t)
  const first = harness.bridge()
  await first.start()
  const task = await first.startTask()
  assert.ok(task.ok)
  await first.promptTask(task.taskId, '先记录昨天的进度')
  await first.dispose()
  const kept: string[] = []
  const second = harness.bridge({ recordOutputs: async (session, outputs) => {
    const accepted = []
    for (const output of outputs) {
      if (!output.native || !await second.memory.call('nativeOutputEvidence', { session, ...output.native })) continue
      accepted.push(output)
      kept.push(...output.blocks.map(block => block.text))
    }
    return accepted
  } })
  await second.start()
  assert.ok((await second.resumeTask({ taskId: task.taskId })).ok)
  const delayed = delayNativeOutputReceipts(t, second.pid, 150)
  await second.promptTask(task.taskId, '后来呢')
  assert.ok(delayed() > 0)
  assert.ok(kept.some(text => text.includes('后来呢')), 'only owner-confirmed text can be published')
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

test('automatic context reuses the admitted step and a missing evidence receipt lets the foreground continue', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { agent, call, ask, llm, events } = await setupMemory(t)
  await call('setProfile', { args: [{ role: 'injection-receipt-test' }, randomUUID()] })
  const pid = agent.pid(), emit = ChildProcess.prototype.emit
  let admitted = false, lookup = false, extraSessionReads = 0
  let lostReceiptBudget: number | undefined
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    const frame = event === 'message' && this.pid === pid ? ownerRpcFrame(args[0]) : null
    if (frame?.kind === 'request' && frame.method === 'adapter') {
      const call = objectOf(frame.input), input = Array.isArray(call?.args) ? objectOf(call.args[0]) : null
      if (call?.method === 'receiveSource' && input?.admitted === true) admitted = true
      if (admitted && !lookup && call?.method === 'sessionView') extraSessionReads++
      if (call?.method === 'modelRequest' && input?.op === 'context') lookup = true
      if (lookup && lostReceiptBudget === undefined && call?.method === 'registerDerived' && input?.nativeUserSource === 'viva-memory') {
        lostReceiptBudget = frame.budgetMs
        return true // The owner never acknowledges this optional evidence write.
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  await ask('照常回复这一条消息')
  assert.ok(admitted && lookup)
  assert.ok(lostReceiptBudget !== undefined && lostReceiptBudget <= DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs + 100)
  assert.equal(extraSessionReads, 0)
  assert.match(replies(events).join(''), /照常回复这一条消息/)
  assert.doesNotMatch(JSON.stringify(llm.requests), /injection-receipt-test/)
})

test('the plugin injects manual profile and recalls file memory with exact evidence after restart', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, call, ask, agent, bridge } = await setupMemory(t)
  await call('setProfile', { args: [{ role: '后端负责人' }, randomUUID()] })
  const input = { operationId: randomUUID(), text: '周报每周五下班前交给张三。' }
  const created = await call('createFile', { args: [input] })
  await ask('帮我写周报')
  assert.match(lastContext(llm), /后端负责人/)
  assert.match(lastContext(llm), /周报每周五下班前交给张三/)
  assert.ok(llm.requests.every(request => !JSON.stringify(request).includes('dsh_session_log')))
  const epoch = agent.memory.state()!.epoch
  const dsh = agent.pid()
  await agent.dispose()
  const restarted = bridge({ memoryRequired: true })
  await restarted.start()
  assert.ok(await eventually(() => restarted.memory.ready()))
  assert.notEqual(restarted.pid(), dsh)
  assert.equal(restarted.memory.state()!.epoch, epoch)
  assert.deepEqual(await restarted.memory.call('createFile', { args: [input] }), created)
  assert.ok((await restarted.memory.call('readFile', { args: [created.identity] }))?.markdown.includes(input.text))
})

test('trusted source aliases retain exact user evidence and refuse reused operation text', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { agent, call, session, userData } = await setupMemory(t)
  const text = '周报每周五交给李四，客户故障时另行确认。'
  const alias = { operationId: randomUUID(), sourceId: randomUUID(), session: session(), conversation: 'aliases', text }
  assert.deepEqual(await call('sourceAlias', alias), await call('sourceAlias', alias))
  await assert.rejects(call('sourceAlias', { ...alias, text: 'different text' }))
  await agent.prompt(text, [], { sourceId: alias.sourceId })
  const db = new DatabaseSync(join(userData, 'memory', 'memory.db'), { readOnly: true })
  try {
    const source = db.prepare('SELECT text,author FROM memory_sources WHERE id=?').get(alias.sourceId)
    assert.deepEqual(source, Object.assign(Object.create(null), { text, author: 'user' }))
  } finally { db.close() }
})

test('memory_remember saves exact current user evidence directly into a file', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { call, ask, events } = await setupMemory(t)
  const text = '周报每周五提交，客户故障时另行确认。'
  await ask(`记住：${text}`)
  const files = await call('listFiles', { args: [{ kind: 'digest' }] })
  const saved = files.items.find(item => item.title.includes('周报'))
  assert.ok(saved, JSON.stringify(events))
  const detail = await call('readFile', { args: [saved.identity] })
  assert.ok(detail)
  assert.ok(detail.markdown.includes(text))
  assert.equal(detail.sources.length, 1)
  assert.equal(detail.sources[0]?.namespace, 'canonical')
})

test('the actual remember tool accepts a precise fragment from a natural request without a fixed prefix', { timeout: DSH_TIMEOUT_MS }, async t => {
  const original = '记住我在深圳', text = '我在深圳'
  const { call, ask } = await setupMemory(t, { decideFirst: routeFixtureTools((request: ModelRequest) => {
    if (questionOf(request.messages) === original && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
      return { tool: { name: 'memory_remember', input: { text } } }
    }
    return null
  }) })
  await ask(original)
  const saved = (await call('listFiles', { args: [{ kind: 'digest' }] })).items.find(item => item.title.includes(text))
  assert.ok(saved)
  const detail = await call('readFile', { args: [saved.identity] })
  assert.ok(detail?.markdown.includes(text))
})
