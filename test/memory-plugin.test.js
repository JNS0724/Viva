import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryDb } from '../plugins/memory/lib/store.js'
import { createAcpBridge } from '../src/main/acp-bridge.js'
import { DSH_PROFILE } from '../src/main/config.js'
import { ensureDshProfile } from '../src/main/dsh-profile.js'
import { startFakeLlm } from './fixtures/fake-llm.js'

/**
 * The memory plugin inside the real dsh: the app's bridge, the app's profile, and a fake Messages endpoint
 * in place of DeepSeek, so every request the model would get can be inspected.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_BIN = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'memory')
const NODE_BIN = process.env.DSH_NODE || 'node'
const DSH_TIMEOUT_MS = 60_000

async function setup(t, { memoryFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-plugin-'))
  const dshHome = path.join(dir, 'dsh-home')
  const workspace = path.join(dir, 'workspace')
  fs.mkdirSync(workspace)
  const file = memoryFile ?? path.join(dir, 'memory.db')
  ensureDshProfile({ dshHome, profile: DSH_PROFILE, pluginDir: PLUGIN_DIR, memoryFile: file })
  const llm = await startFakeLlm()
  const bridges = []
  t.after(async () => {
    bridges.forEach((bridge) => bridge.dispose())
    await llm.close()
    // dsh may still be flushing its session log as it exits.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const events = []
  function bridge() {
    const created = createAcpBridge({
      dshBin: DSH_BIN,
      nodeBin: NODE_BIN,
      cwd: workspace,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DSH_HOME: dshHome, DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url },
      emit: (event) => events.push(event),
    })
    bridges.push(created)
    return created
  }
  return { dir, file, llm, events, bridge }
}

function openDb(t, file) {
  const db = openMemoryDb({ file })
  t.after(() => db.close())
  return db
}

const replies = (events) => events
  .filter((e) => e.update?.sessionUpdate === 'agent_message_chunk')
  .map((e) => e.update.content.text)
/** The plugin's block in the model's latest request, or '' when it sent none. */
function contextOf(request) {
  const last = request.messages[request.messages.length - 1]
  const parts = Array.isArray(last.content) ? last.content : []
  return parts.find((part) => part.type === 'text' && part.text.startsWith('<about-user>'))?.text ?? ''
}
const lastContext = (llm) => contextOf(llm.requests[llm.requests.length - 1])

test('the fixed layer goes out once per session, names push their memories once', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, bridge } = await setup(t)
  const db = openDb(t, file)
  db.setProfile({ role: '后端负责人', people: '张三（直属上级）' })
  db.addMemory({ text: '周报每周五下班前交给张三', keywords: ['周报', '张三'] })
  db.addMemory({ text: '回答先给结论', kind: 'preference' })
  // An up-to-date synthesis, so none is due during the test and the fixed layer stays the same.
  db.saveSynthesis('【偏好】\n- 回答先给结论')
  const agent = bridge()
  const { sessionId } = await agent.start()

  await agent.prompt('今天天气怎么样')
  const first = lastContext(llm)
  await agent.prompt('帮我写这周的周报')
  const second = lastContext(llm)
  await agent.prompt('周报还要注意什么')
  const third = lastContext(llm)

  assert.match(first, /【记忆规则】/)
  assert.match(first, /角色与职责：后端负责人/)
  assert.match(first, /【助手整理的画像】\n【偏好】\n- 回答先给结论/)
  assert.doesNotMatch(first, /周报每周五/, 'nothing named, nothing pushed')
  assert.doesNotMatch(second, /记忆规则/, 'the fixed layer is not sent twice')
  assert.match(second, /【相关记忆】\n- （\d{4}-\d{2}-\d{2}）周报每周五下班前交给张三〔周报〕/)
  assert.equal(third, '', 'a memory is pushed once per session')
  assert.deepEqual(db.injectionsAfter(0, sessionId).map((entry) => [entry.turn, entry.fixed, entry.pushed.length]), [[1, 'first', 0], [2, null, 1]])
  assert.ok(db.pluginStartedAt() > 0, 'the plugin says it is running')
})

test('the agent remembers through the plugin tool, with keywords and without asking', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, events, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()

  await agent.prompt('记住：周报每周五下班前交给张三')

  const db = openDb(t, file)
  assert.equal(events.some((e) => e.type === 'permission'), false)
  assert.ok(replies(events).join('').includes('好的，我记住了：周报每周五下班前交给张三'))
  assert.deepEqual(db.listMemories().items.map((m) => [m.text, m.source, m.keywords]), [['周报每周五下班前交给张三', 'agent', ['周报', '张三']]])
  const tool = events.find((e) => e.update?.sessionUpdate === 'tool_call')
  assert.equal(tool.update.title, 'memory_remember')
})

test('a resumed session keeps its state across a restart', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, bridge } = await setup(t)
  openDb(t, file).setProfile({ role: '后端负责人' })
  const first = bridge()
  const { sessionId } = await first.start()
  await first.prompt('你好')
  first.dispose()

  const second = bridge()
  const resumed = await second.start({ resumeSessionId: sessionId })
  await second.prompt('继续')

  assert.equal(resumed.resumed, true)
  assert.equal(lastContext(llm), '', 'the profile is still in the resumed conversation')
})

test('dsh keeps working when the memory plugin cannot open its store', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-blocked-'))
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }))
  // A directory where the database file should be: opening it fails inside the plugin.
  const { llm, events, bridge } = await setup(t, { memoryFile: blocked })
  const agent = bridge()
  await agent.start()

  await agent.prompt('你好')

  assert.equal(events.some((e) => e.type === 'error'), false)
  assert.equal(lastContext(llm), '')
  assert.ok(replies(events).join('').includes('收到：「你好」'))
})

/** The background pass finishes after the turn; wait for what it writes. */
async function eventually(read, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

test('a preference the model did not save is picked up in the background after the turn', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, events, bridge } = await setup(t)
  const db = openDb(t, file)
  const agent = bridge()
  await agent.start()

  await agent.prompt('以后回答我，先给结论再展开')

  assert.equal(events.some((e) => e.update?.sessionUpdate === 'tool_call'), false, 'the main model called no memory tool')
  const saved = await eventually(() => db.listMemories().items.find((m) => m.kind === 'preference'))
  assert.equal(saved?.text, '回答我先给结论再展开')
  assert.equal(saved?.source, 'agent')
})

test('a changed fact replaces the agent memory it contradicts, which stays as history', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, bridge } = await setup(t)
  const db = openDb(t, file)
  const old = db.addMemory({ text: '张三是直属上级', kind: 'person', keywords: ['张三'], source: 'agent' }).memory
  const agent = bridge()
  await agent.start()

  await agent.prompt('张三调走了，现在上级是李四')

  const replaced = await eventually(() => db.listInvalid().find((m) => m.id === old.id))
  assert.equal(replaced?.invalidatedBy, 'agent')
  const current = db.listMemories().items.find((m) => m.id === replaced?.supersededBy)
  assert.equal(current?.text, '直属上级是李四')
  assert.deepEqual(db.invalidatedSince(0).map((m) => m.id), [old.id])
})

test('the background pass never overrides what the user wrote: the whole change is dropped', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, bridge } = await setup(t)
  const db = openDb(t, file)
  const mine = db.addMemory({ text: '张三是直属上级', kind: 'person', keywords: ['张三'], source: 'user' }).memory
  const agent = bridge()
  await agent.start()

  await agent.prompt('张三调走了，现在上级是李四')
  await eventually(() => llm.requests.length >= 2, { timeoutMs: 15_000 })
  await new Promise((resolve) => setTimeout(resolve, 500))

  assert.equal(db.getMemory(mine.id).invalidAt, null)
  assert.deepEqual(db.listMemories().items.map((m) => m.text), ['张三是直属上级'], 'not even the new memory is kept')
})

test('after a turn the profile is synthesised from the memories, and the next session starts with it', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, bridge } = await setup(t)
  const db = openDb(t, file)
  const agent = bridge()
  await agent.start()

  await agent.prompt('以后回答我，先给结论再展开')

  const synthesis = await eventually(() => db.latestSynthesis())
  assert.equal(synthesis?.text, '【偏好】\n- 回答我先给结论再展开')
  await agent.newSession()
  await agent.prompt('今天天气怎么样')
  assert.match(lastContext(llm), /【助手整理的画像】\n【偏好】\n- 回答我先给结论再展开/)
  assert.doesNotMatch(lastContext(llm), /【最近了解到的】/, 'everything is in the synthesis')
})
