import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge } from '../src/main/acp-bridge.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/main/app-plugins.ts'
import { ensureDshProfile } from '../src/main/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../src/main/dsh-runtime.ts'
import { createTaskRegistry } from '../src/main/task-registry.ts'
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
  bridge = createAcpBridge({ dshBin: path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), nodeBin: runtime.nodeBin, cwd: dir, profile,
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
