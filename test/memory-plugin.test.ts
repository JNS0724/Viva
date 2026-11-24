import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { questionOf, routeFixtureTools } from './fixtures/fake-llm.ts'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.ts'
import { ownerRpcFrame } from '../src/memory/contracts/owner-rpc.ts'
import { objectOf } from '../src/memory/contracts/unknown-value.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'

/** The real DSH adapter and the separate storage owner communicate through the backend relay. */
async function setupMemory(t: TestContext, options?: Parameters<typeof setup>[1]) {
  const harness = await setup(t, options)
  const agent = harness.bridge()
  let session = (await agent.start()).sessionId!
  assert.ok(await eventually(() => agent.memory.ready()), 'independent memory owner becomes ready')
  const call = agent.memory.call
  async function ask(text: string) {
    const sourceId = randomUUID()
    return agent.prompt(text, [], { userTurn: true, sourceId })
  }
  async function freshSession() { session = (await agent.newSession()).sessionId! }
  return { ...harness, agent, call, ask, freshSession, session: () => session }
}
interface ModelRequest { system?: unknown, messages: { content: string | { type: string, text?: string }[] }[] }
function lastForeground(llm: { requests: object[] }) {
  return (llm.requests as ModelRequest[]).findLast(request => JSON.stringify(request.system ?? '').includes('你是用户的个人工作助手'))
}
function lastContext(llm: { requests: object[] }) {
  const foreground = lastForeground(llm)
  return JSON.stringify(foreground?.messages ?? '')
}

test('a resumed task publishes its own committed answer after restart', { timeout: DSH_TIMEOUT_MS }, async t => {
  const harness = await setup(t)
  const first = harness.bridge()
  await first.start()
  const task = await first.startTask()
  assert.ok(task.ok)
  await first.promptTask(task.taskId, '先记录昨天的进度')
  await first.dispose()
  const second = harness.bridge()
  await second.start()
  assert.ok((await second.resumeTask({ taskId: task.taskId })).ok)
  const before = harness.events.length
  await second.promptTask(task.taskId, '后来呢')
  assert.ok(harness.events.slice(before).some(event => event.type === 'task_update' && JSON.stringify(event).includes('后来呢')))
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

test('automatic recall times out without interrupting the request', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { agent, call, ask, llm, events } = await setupMemory(t)
  await call('createFile', { args: [{ operationId: randomUUID(), text: '照常回复规则：injection-receipt-test' }] })
  const pid = agent.pid(), emit = ChildProcess.prototype.emit
  let admitted = false, lookup = false, extraSessionReads = 0
  let lostReceiptBudget: number | undefined
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    const frame = event === 'message' && this.pid === pid ? ownerRpcFrame(args[0]) : null
    if (frame?.kind === 'request' && (frame.method === 'claimPrefetch' || frame.method === 'claimPrefetchBatch')) {
      lookup = true
      lostReceiptBudget = frame.budgetMs
      return true // Simulate hung host prefetch claim.
    }
    if (frame?.kind === 'request' && frame.method === 'adapter') {
      const call = objectOf(frame.input), input = Array.isArray(call?.args) ? objectOf(call.args[0]) : null
      if (call?.method === 'receiveSource' && input?.live === true) admitted = true
      if (admitted && !lookup && call?.method === 'sessionView') extraSessionReads++
      if (call?.method === 'automaticRecall' || (call?.method === 'sidecarRequest' && input?.op === 'context')) {
        lookup = true
        lostReceiptBudget = frame.budgetMs
        return true // The owner never returns this optional recall lookup.
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })
  await ask('照常回复这一条消息')
  assert.ok(admitted && lookup)
  assert.ok(lostReceiptBudget !== undefined && lostReceiptBudget <= DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs)
  assert.equal(extraSessionReads, 0)
  assert.match(replies(events).join(''), /照常回复这一条消息/)
  assert.doesNotMatch(JSON.stringify(llm.requests), /injection-receipt-test/)
})

test('the plugin injects static memory rules and recalls file memory with exact evidence after restart', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { llm, call, ask, agent, bridge } = await setupMemory(t)
  const input = { operationId: randomUUID(), text: '周报每周五下班前交给张三。' }
  const created = await call('createFile', { args: [input] })
  await ask('帮我写周报')
  assert.match(JSON.stringify(llm.requests.at(-1)), /memory_read/)
  assert.match(lastContext(llm), /周报每周五下班前交给张三/)
  assert.ok(llm.requests.every(request => !JSON.stringify(request).includes('dsh_session_log')))
  const epoch = agent.memory.state()!.epoch
  const dsh = agent.pid()
  await agent.dispose()
  const restarted = bridge()
  await restarted.start()
  assert.ok(await eventually(() => restarted.memory.ready()))
  assert.notEqual(restarted.pid(), dsh)
  assert.equal(restarted.memory.state()!.epoch, epoch)
  assert.deepEqual(await restarted.memory.call('createFile', { args: [input] }), created)
  assert.ok((await restarted.memory.call('readFile', { args: [created.identity] }))?.markdown.includes(input.text))
})

test('trusted source aliases retain exact user evidence and refuse reused operation text', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { agent, call, session, userData, workspace } = await setupMemory(t)
  const text = '周报每周五交给李四，客户故障时另行确认。'
  const alias = { operationId: randomUUID(), sourceId: randomUUID(), session: session(), conversation: session(), text, wireText: text, cwd: workspace }
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
  const { call, ask, events, llm } = await setupMemory(t)
  const text = '周报每周五提交，客户故障时另行确认。'
  await ask(`记住：${text}`)
  const files = await call('listFiles', { args: [{ kind: 'digest' }] })
  const saved = files.items.find(item => item.title.includes('周报'))
  assert.ok(saved, JSON.stringify(events))
  const detail = await call('readFile', { args: [saved.identity] })
  assert.ok(detail)
  assert.ok(detail.markdown.includes(text))
  const continuation = (llm.requests as ModelRequest[]).find(request =>
    request.messages.some(message => JSON.stringify(message.content).includes('tool_result')))
  assert.ok(continuation, 'the model continued after executing the memory tool')
  assert.match(JSON.stringify(continuation), /memory_read/)
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

test('Phase 1 L1/L2/L3 split preserves prior turn recall in history (Option A) and confirms memory_context exactly once per committed turn including tool continuation (R2 P2-7, R3 P2-7)', { timeout: DSH_TIMEOUT_MS }, async t => {
  let toolCallIssued = false
  const { llm, call, ask, agent } = await setupMemory(t, {
    decideFirst: routeFixtureTools((request: ModelRequest) => {
      const text = questionOf(request.messages)
      if (!toolCallIssued && text.includes('月报') && !JSON.stringify(request.messages.at(-1)).includes('tool_result')) {
        toolCallIssued = true
        return { tool: { name: 'memory_node_search', input: { query: '月报' } } }
      }
      return null
    }),
  })
  await call('createFile', { args: [{ operationId: randomUUID(), text: '周报每周五下午五点发给产品组。' }] })
  await call('createFile', { args: [{ operationId: randomUUID(), text: '月报每月底最后一天发给运营组。' }] })

  const pid = agent.pid(), emit = ChildProcess.prototype.emit
  const contextUsedReports: Array<{ turn: number, pushed: Array<{ text: string, names: string[] }> }> = []
  t.mock.method(ChildProcess.prototype, 'emit', function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    const frame = event === 'message' && this.pid === pid ? ownerRpcFrame(args[0]) : null
    if (frame?.kind === 'request' && frame.method === 'adapter') {
      const payload = objectOf(frame.input)
      if (payload?.method === 'reportContextUsed' && Array.isArray(payload.args)) {
        const arg = objectOf(payload.args[0])
        if (arg && typeof arg.turn === 'number' && Array.isArray(arg.pushed)) {
          contextUsedReports.push({ turn: arg.turn, pushed: arg.pushed as Array<{ text: string, names: string[] }> })
        }
      }
    }
    return Reflect.apply(emit, this, [event, ...args]) as boolean
  })

  const textsOf = (request: ModelRequest) => request.messages.flatMap(msg =>
    typeof msg.content === 'string' ? [msg.content] : msg.content.map(part => part.text ?? ''),
  ).join('\n')

  await ask('帮我写周报')
  assert.ok(await eventually(() => contextUsedReports.filter(r => r.turn === 1).length === 1), 'turn 1 must report memory_context once')
  const firstReq = lastForeground(llm)
  assert.ok(firstReq)
  assert.match(JSON.stringify(firstReq.system ?? ''), /memory_read/, 'L1 static rules must reside in system prompt')
  const firstText = textsOf(firstReq)
  assert.match(firstText, /<memory-recall turn="1" ref="/, 'L3 recall message must be attached for turn 1')
  assert.match(firstText, /产品组/)

  // Turn 2 executes a multi-step tool continuation (step 1 calls memory_node_search, step 2 replies)
  await ask('帮我写月报')
  assert.equal(toolCallIssued, true, 'turn 2 must exercise real multi-step tool continuation')
  assert.ok(await eventually(() => contextUsedReports.filter(r => r.turn === 2).length === 1), 'turn 2 must report memory_context once')
  const secondReq = lastForeground(llm)
  assert.ok(secondReq)
  const secondText = textsOf(secondReq)
  assert.match(secondText, /<memory-recall turn="1" ref="/, 'Option A: turn 1 recall message must remain preserved in history')
  assert.match(secondText, /<memory-recall turn="2" ref="/, 'turn 2 recall message must be appended cleanly')
  assert.match(secondText, /运营组/)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(contextUsedReports.filter(r => r.turn === 2).length, 1, 'committed multi-step tool continuation turn must emit exactly 1 memory_context report')
  assert.equal(contextUsedReports.length, 2, 'normal 2-turn commit (including multi-step tool continuation) must emit exactly 2 memory_context reports')
})
