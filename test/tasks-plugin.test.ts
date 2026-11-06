import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/backend/app-plugins.ts'
import { ensureDshProfile, SUBAGENT_TOOLS, vivaLayerFile } from '../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../src/backend/dsh-runtime.ts'
import { createTaskRegistry } from '../src/backend/task-registry.ts'
import { startFakeLlm } from './fixtures/fake-llm.js'

test('real DSH discovers both tools and queries main-process tasks over IPC with no permission prompt', { timeout: 60_000 }, async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-task-tools-'))
  let bridge: ReturnType<typeof createAcpBridge> | undefined
  let closeLlm: (() => Promise<void>) | undefined
  t.after(async () => {
    await bridge?.dispose()
    await closeLlm?.()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const registry = createTaskRegistry()
  registry.put({ id: 'demo-task', title: '核对发票', cwd: dir, words: '核对本月发票' })
  registry.receive({ type: 'task_update', taskId: 'demo-task', update: { sessionUpdate: 'agent_message_chunk', content: { text: '已核对三张发票' } } })
  registry.receive({ type: 'task_end', taskId: 'demo-task', stopReason: 'end_turn' })
  let calls = 0
  const llm = await startFakeLlm({ decideFirst: (raw: object) => {
    const request = raw as { tools?: { name: string }[], messages?: unknown[] }
    if (!request.tools?.some(tool => tool.name === 'list_background_tasks')) return null
    const messages = JSON.stringify(request.messages)
    if (!messages.includes('查询后台任务测试')) return null
    if (!messages.includes('"tool_result"')) return { tool: { name: 'list_background_tasks', input: {} } }
    if (!messages.includes('get_background_task')) return { tool: { name: 'get_background_task', input: { taskId: 'demo-task', includeRequest: true, includeOutput: true } } }
    return { text: '任务查询测试完成' }
  } })
  closeLlm = llm.close
  const dshHome = path.join(dir, 'dsh-home')
  const { plugins, problems } = resolvePlugins({ codeRoot: root, userData: path.join(dir, 'userData'), dshVersion: installedDshVersion(root) })
  assert.deepEqual(problems, [])
  const profile = 'viva-task-tools-test'
  ensureDshProfile({ dshHome, profile, plugins, persona: PERSONA })
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const events: { type: string }[] = []
  bridge = createAcpBridge({ dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin, cwd: dir, profile, overlay: vivaLayerFile(dshHome),
    env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url } }),
    emit: event => { events.push(event) },
    taskRead: (request, sessionId) => { assert.ok(sessionId); calls++; return registry.query(request, { cwd: dir }) },
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

test('real DSH: the model starts a task through start_background_task, and the app is the one that acts', { timeout: 60_000 }, async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-task-start-'))
  let bridge: ReturnType<typeof createAcpBridge> | undefined
  let closeLlm: (() => Promise<void>) | undefined
  t.after(async () => {
    await bridge?.dispose()
    await closeLlm?.()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const llm = await startFakeLlm({ decideFirst: (raw: object) => {
    const request = raw as { tools?: { name: string }[], messages?: unknown[] }
    const names = request.tools?.map(tool => tool.name) ?? []
    if (!names.includes('start_background_task')) return null
    const messages = JSON.stringify(request.messages)
    if (!messages.includes('后台开任务测试')) return null
    if (!messages.includes('"tool_result"')) return { tool: { name: 'start_background_task', input: { brief: '核对本月发票，列出金额不符的' } } }
    return { text: '已经交给后台' }
  } })
  closeLlm = llm.close
  const dshHome = path.join(dir, 'dsh-home')
  const { plugins, problems } = resolvePlugins({ codeRoot: root, userData: path.join(dir, 'userData'), dshVersion: installedDshVersion(root) })
  assert.deepEqual(problems, [])
  const profile = 'viva-task-start-test'
  ensureDshProfile({ dshHome, profile, plugins, persona: PERSONA })
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const acted: unknown[] = []
  bridge = createAcpBridge({ dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin, cwd: dir, profile, overlay: vivaLayerFile(dshHome),
    env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url } }),
    emit: () => {},
    taskRead: () => ({ tasks: [] }),
    taskAct: async (request, sessionId) => { acted.push([request, Boolean(sessionId)]); return { taskId: 't1', status: 'running' } },
  })
  await bridge.start()
  await bridge.prompt('后台开任务测试')
  assert.deepEqual(acted, [[{ op: 'start', brief: '核对本月发票，列出金额不符的' }, true]])
  const tools = (llm.requests.at(0) as { tools?: { name: string }[] }).tools?.map(tool => tool.name) ?? []
  for (const name of ['start_background_task', 'stop_background_task', 'message_background_task']) assert.ok(tools.includes(name), `${name} offered`)
  assert.ok(JSON.stringify(llm.requests).includes('"taskId\\":\\"t1\\"'), 'the app\'s answer reached the model')
})

test('real DSH: the model proposes a schedule with flat time arguments, and the app gets dsh-schedule\'s rule', { timeout: 60_000 }, async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-schedule-tool-'))
  let bridge: ReturnType<typeof createAcpBridge> | undefined
  let closeLlm: (() => Promise<void>) | undefined
  t.after(async () => {
    await bridge?.dispose()
    await closeLlm?.()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const weekly = { title: '周报', prompt: '按上周的模板起草周报', kind: 'weekly', time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] }
  const llm = await startFakeLlm({ decideFirst: (raw: object) => {
    const request = raw as { tools?: { name: string }[], messages?: unknown[] }
    if (!request.tools?.some(tool => tool.name === 'schedule_create')) return null
    const messages = JSON.stringify(request.messages)
    if (!messages.includes('定时任务测试')) return null
    if (!messages.includes('"tool_result"')) return { tool: { name: 'schedule_create', input: weekly } }
    return { text: '已经提出定时' }
  } })
  closeLlm = llm.close
  const dshHome = path.join(dir, 'dsh-home')
  const { plugins, problems } = resolvePlugins({ codeRoot: root, userData: path.join(dir, 'userData'), dshVersion: installedDshVersion(root) })
  assert.deepEqual(problems, [])
  const profile = 'viva-schedule-tool-test'
  ensureDshProfile({ dshHome, profile, plugins, persona: PERSONA })
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const acted: unknown[] = []
  bridge = createAcpBridge({ dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin, cwd: dir, profile, overlay: vivaLayerFile(dshHome),
    env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url } }),
    emit: () => {},
    taskRead: () => ({ tasks: [] }),
    taskAct: async request => { acted.push(request); return { proposed: true, firstAt: '2026-11-13T08:00:00.000Z' } },
  })
  await bridge.start()
  await bridge.prompt('定时任务测试')
  assert.deepEqual(acted, [{ op: 'schedule_create', title: '周报', prompt: '按上周的模板起草周报', rule: { kind: 'weekly', weekly: { time: '16:00:00', time_zone: 'Asia/Shanghai', weekdays: [5] } } }])
  const tools = (llm.requests.at(0) as { tools?: { name: string }[] }).tools?.map(tool => tool.name) ?? []
  for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) assert.ok(tools.includes(name), `${name} offered`)
  assert.ok(!tools.includes('viva_followup_propose'), 'the old proposal tool is gone')
})

test('real DSH: sub-agents work within the turn, in the foreground, with read-only tools only, and cannot delegate', { timeout: 90_000 }, async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-subagent-'))
  let bridge: ReturnType<typeof createAcpBridge> | undefined
  let closeLlm: (() => Promise<void>) | undefined
  t.after(async () => {
    await bridge?.dispose()
    await closeLlm?.()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const childTools: string[][] = []
  const llm = await startFakeLlm({ decideFirst: (raw: object) => {
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
  closeLlm = llm.close
  const dshHome = path.join(dir, 'dsh-home')
  const { plugins, problems } = resolvePlugins({ codeRoot: root, userData: path.join(dir, 'userData'), dshVersion: installedDshVersion(root) })
  assert.deepEqual(problems, [])
  const profile = 'viva-subagent-test'
  ensureDshProfile({ dshHome, profile, plugins, persona: PERSONA })
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const events: Array<{ type: string, [field: string]: unknown }> = []
  bridge = createAcpBridge({ dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin, cwd: dir, profile, overlay: vivaLayerFile(dshHome),
    env: dshEnv({ base: process.env, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url } }),
    emit: event => { events.push(event) },
  })
  await bridge.start()
  await bridge.prompt('子代理测试')
  const main = llm.requests.find(request => JSON.stringify((request as { messages?: unknown }).messages).includes('子代理测试')) as { tools?: Array<{ name: string, input_schema?: { properties?: object } }> }
  const mainTools = main.tools?.map(tool => tool.name) ?? []
  assert.ok(mainTools.includes('subagent') && mainTools.includes('subagent_fork'), JSON.stringify(mainTools))
  for (const name of ['send_message', 'list_agents', 'interrupt_agent']) assert.ok(!mainTools.includes(name), `${name} is off`)
  const subagent = main.tools?.find(tool => tool.name === 'subagent')
  assert.ok(!Object.keys(subagent?.input_schema?.properties ?? {}).includes('run_in_background'), 'no background mode to ask for')
  assert.equal(childTools.length, 1, JSON.stringify(llm.requests.at(-1)).match(/tool_result.{0,800}/)?.[0])
  const allowed = new Set(SUBAGENT_TOOLS)
  assert.deepEqual(childTools[0].filter(name => !allowed.has(name)), [], 'the child has only the read-only tools')
  assert.ok(!childTools[0].includes('subagent'), 'and cannot delegate')
  assert.ok(JSON.stringify(llm.requests.at(-1)).includes('子代理完成'), 'the result came back as a tool result in the same turn')
  assert.equal(events.filter(event => event.type === 'turn_end').length, 1)
  assert.equal(events.some(event => event.type === 'error'), false)
})
