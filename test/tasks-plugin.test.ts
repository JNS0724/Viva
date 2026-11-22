import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { SUBAGENT_TOOLS } from '../src/backend/dsh-profile.ts'
import { createTaskRegistry } from '../src/backend/task-registry.ts'
import { startHarness } from './fixtures/dsh-harness.ts'

test('real DSH discovers both tools and queries main-process tasks over IPC with no permission prompt', { timeout: 60_000 }, async t => {
  const h = await startHarness(t, { decideFirst: (raw: object) => {
    const request = raw as { tools?: { name: string }[], messages?: unknown[] }
    if (!request.tools?.some(tool => tool.name === 'list_background_tasks')) return null
    const messages = JSON.stringify(request.messages)
    if (!messages.includes('查询后台任务测试')) return null
    if (!messages.includes('"tool_result"')) return { tool: { name: 'list_background_tasks', input: {} } }
    if (!messages.includes('get_background_task')) return { tool: { name: 'get_background_task', input: { taskId: 'demo-task', includeRequest: true, includeOutput: true } } }
    return { text: '任务查询测试完成' }
  } })
  const { dir, llm, events } = h
  const registry = createTaskRegistry()
  registry.put({ id: 'demo-task', title: '核对发票', cwd: dir, words: '核对本月发票' })
  registry.receive({ type: 'task_update', taskId: 'demo-task', update: { sessionUpdate: 'agent_message_chunk', content: { text: '已核对三张发票' } } })
  registry.receive({ type: 'task_end', taskId: 'demo-task', stopReason: 'end_turn' })
  let calls = 0
  const bridge = h.bridge({ cwd: dir,
    taskRead: (request, sessionId) => { assert.ok(sessionId); calls++; return registry.query(request, { kind: 'main', cwd: dir }) },
  })
  await bridge.start()
  await bridge.prompt('查询后台任务测试')
  assert.equal(calls, 2, JSON.stringify({ events, requests: llm.requests }))
  const requests = JSON.stringify(llm.requests)
  assert.ok(requests.includes('已核对三张发票'), 'actual tool result reached the model')
  assert.ok(requests.includes('核对本月发票'))
  assert.equal(events.some(event => event.type === 'permission'), false)
  assert.equal(events.some(event => event.type === 'error'), false)
})

test('real DSH: the main agent routes work to a task, and the app is the one that starts it', { timeout: 60_000 }, async t => {
  // The fake model routes 「后台做：X」 as a start with X its brief (fake-llm.ts).
  const started: string[] = []
  const h = await startHarness(t, { tasks: {
    start: async ({ brief }) => { started.push(brief); return { taskId: 't1' } },
    message: async () => { throw new Error('not asked') },
    stop: async () => { throw new Error('not asked') },
  } })
  const { dir, llm, events } = h
  const bridge = h.bridge({ cwd: dir,
    taskRead: () => ({ observedAt: 0, tasks: [], total: 0, nextOffset: null }),
  })
  await bridge.start()
  await bridge.prompt('后台做：核对本月发票，列出金额不符的')
  assert.deepEqual(started, ['核对本月发票，列出金额不符的'], 'started by the app, from the accepted decision')
  const tools = (llm.requests.at(0) as { tools?: { name: string }[] }).tools?.map(tool => tool.name) ?? []
  for (const name of ['start_background_task', 'stop_background_task', 'message_background_task']) assert.ok(!tools.includes(name), `${name} is no tool`)
  assert.equal(llm.requests.filter(request => JSON.stringify(request).includes('核对本月发票')).length, 1, 'once handed over, the turn ends without waiting')
  assert.equal(events.filter(event => event.type === 'turn_end').length, 1)
})

test('real DSH: the model proposes a schedule with flat time arguments, and the app gets dsh-schedule\'s rule', { timeout: 60_000 }, async t => {
  const weekly = { title: '周报', prompt: '按上周的模板起草周报', kind: 'weekly', time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] }
  // The fake model routes 「…到时候帮我…」 as an app operation (fake-llm.ts); its tool is called with these arguments.
  const h = await startHarness(t, { decideFirst: (raw: object) => {
    const request = raw as { messages?: unknown[] }
    const messages = JSON.stringify(request.messages)
    if (!messages.includes('定时任务测试')) return null
    if (messages.includes('"name":"schedule_create"')) return { text: '已经提出定时' }
    if (messages.includes('"name":"commit_route"')) return { tool: { name: 'schedule_create', input: weekly } }
    return null
  } })
  const { dir, llm } = h
  const acted: unknown[] = []
  const bridge = h.bridge({ cwd: dir,
    taskRead: () => ({ observedAt: 0, tasks: [], total: 0, nextOffset: null }),
    taskAct: async request => { acted.push(request); return { proposed: true, firstAt: '2026-11-13T08:00:00.000Z' } },
  })
  await bridge.start()
  await bridge.prompt('定时任务测试：到时候帮我起草周报')
  assert.deepEqual(acted, [{ op: 'schedule_create', title: '周报', prompt: '按上周的模板起草周报', rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] } } }])
  const tools = (llm.requests.at(0) as { tools?: { name: string }[] }).tools?.map(tool => tool.name) ?? []
  for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) assert.ok(tools.includes(name), `${name} offered`)
  assert.ok(!tools.includes('viva_followup_propose'), 'the old proposal tool is gone')
})

test('real DSH: sub-agents work within the turn, in the foreground, with read-only tools only, and cannot delegate', { timeout: 90_000 }, async t => {
  const childTools: string[][] = []
  const h = await startHarness(t, { decideFirst: (raw: object) => {
    const request = raw as { tools?: { name: string }[], messages?: unknown[] }
    const messages = JSON.stringify(request.messages)
    const names = request.tools?.map(tool => tool.name) ?? []
    if (messages.includes('子代理任务：看看目录') && !messages.includes('子代理测试')) {
      childTools.push(names)
      return { text: '子代理完成：目录里没有文件' }
    }
    if (!messages.includes('子代理测试')) return null
    if (!messages.includes('"tool_result"')) return { tool: { name: 'subagent', input: { description: '看目录', prompt: '子代理任务：看看目录' } } }
    return { text: '主对话收到子代理的结论' }
  } })
  const { dir, llm, events, userData } = h
  const bridge = h.bridge({ cwd: dir })
  await bridge.start()
  // Sub-agents are a task's: the main conversation hands such work over.
  const task = await bridge.startTask()
  assert.ok(task.ok && task.taskId, JSON.stringify(task))
  await bridge.promptTask(task.taskId, '子代理测试')
  const main = llm.requests.find(request => JSON.stringify((request as { messages?: unknown }).messages).includes('子代理测试')) as { tools?: Array<{ name: string, input_schema?: { properties?: object } }> }
  const mainTools = main.tools?.map(tool => tool.name) ?? []
  assert.ok(mainTools.includes('subagent') && mainTools.includes('subagent_fork'), JSON.stringify(mainTools))
  for (const name of ['send_message', 'list_agents', 'interrupt_agent']) assert.ok(!mainTools.includes(name), `${name} is off`)
  const subagent = main.tools?.find(tool => tool.name === 'subagent')
  assert.ok(!Object.keys(subagent?.input_schema?.properties ?? {}).includes('run_in_background'), 'no background mode to ask for')
  assert.equal(childTools.length, 1, 'Generated child instructions must not trigger automatic fact extraction')
  const memory = new DatabaseSync(path.join(userData, 'memory', 'memory.db'), { readOnly: true })
  try { assert.equal(memory.prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE text LIKE '%子代理任务：看看目录%'").get()?.n, 0) } finally { memory.close() }
  const allowed = new Set(SUBAGENT_TOOLS)
  assert.deepEqual(childTools[0].filter(name => !allowed.has(name)), [], 'the child has only the read-only tools')
  assert.ok(!childTools[0].includes('subagent'), 'and cannot delegate')
  assert.ok(JSON.stringify(llm.requests.at(-1)).includes('子代理完成'), 'the result came back as a tool result in the same turn')
  assert.equal(events.filter(event => event.type === 'task_end').length, 1)
  assert.equal(events.some(event => event.type === 'error'), false)
})
