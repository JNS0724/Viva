import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMemoryDb } from '../plugins/memory/lib/store.js'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness as setup } from './fixtures/dsh-harness.js'

/** The memory plugin inside the real dsh, with the app's whole profile and a fake model. */

function openDb(defer, file) {
  const db = openMemoryDb({ file })
  defer(() => db.close())
  return db
}

/** The plugin's block in the model's latest request, or '' when it sent none. */
function contextOf(request) {
  const last = request.messages[request.messages.length - 1]
  const parts = Array.isArray(last.content) ? last.content : []
  return parts.find((part) => part.type === 'text' && part.text.startsWith('<about-user>'))?.text ?? ''
}
const lastContext = (llm) => contextOf(llm.requests[llm.requests.length - 1])

test('the fixed layer goes out once per session, names push their memories once', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, bridge, defer } = await setup(t)
  const db = openDb(defer, file)
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
  const { file, events, bridge, defer } = await setup(t)
  const agent = bridge()
  await agent.start()

  await agent.prompt('记住：周报每周五下班前交给张三')

  const db = openDb(defer, file)
  assert.equal(events.some((e) => e.type === 'permission'), false)
  assert.ok(replies(events).join('').includes('好的，我记住了：周报每周五下班前交给张三'))
  assert.deepEqual(db.listMemories().items.map((m) => [m.text, m.source, m.keywords]), [['周报每周五下班前交给张三', 'agent', ['周报', '张三']]])
  const tool = events.find((e) => e.update?.sessionUpdate === 'tool_call')
  assert.equal(tool.update.title, 'memory_remember')
})

test('a resumed session keeps its state across a restart', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, bridge, defer } = await setup(t)
  openDb(defer, file).setProfile({ role: '后端负责人' })
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

test('a preference the model did not save is picked up in the background after the turn', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, llm, events, bridge, defer } = await setup(t)
  const db = openDb(defer, file)
  const agent = bridge()
  await agent.start()

  await agent.prompt('以后回答我，先给结论再展开')

  assert.equal(events.some((e) => e.update?.sessionUpdate === 'tool_call'), false, 'the main model called no memory tool')
  const saved = await eventually(() => db.listMemories().items.find((m) => m.kind === 'preference'))
  const extraction = llm.requests.find((request) => JSON.stringify(request.system ?? '').includes('记忆整理员'))
  const input = JSON.parse(extraction.messages[0].content[0].text)
  assert.match(input.assistant, /收到：「以后回答我，先给结论再展开」/, 'the extractor reads the answer the user got')
  assert.equal(saved?.text, '回答我先给结论再展开')
  assert.equal(saved?.source, 'agent')
})

test('what the user answers to the agent\'s question is kept for next time', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, events, bridge, defer } = await setup(t)
  const db = openDb(defer, file)
  const agent = bridge()
  await agent.start()

  const turn = agent.prompt('明天天气怎么样')
  const asked = await eventually(() => events.find((event) => event.type === 'question'))
  agent.answerQuestion(asked.questionId, [{ id: 'city', selected: ['上海'] }])
  await turn

  const saved = await eventually(() => db.listMemories().items.find((m) => m.text.includes('上海')))
  assert.equal(saved?.text, '用户在上海')
  assert.equal(saved?.source, 'agent')
})

test('a changed fact replaces the agent memory it contradicts, which stays as history', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { file, bridge, defer } = await setup(t)
  const db = openDb(defer, file)
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
  const { file, llm, bridge, defer } = await setup(t)
  const db = openDb(defer, file)
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
  const { file, llm, bridge, defer } = await setup(t)
  const db = openDb(defer, file)
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

test('the model is told it is a personal work assistant, not the coding agent of the stock profile', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { llm, bridge } = await setup(t)
  const agent = bridge()
  await agent.start()

  await agent.prompt('你好')

  const request = JSON.stringify(llm.requests[0])
  assert.match(request, /你是用户的个人工作助手/)
  assert.match(request, /你的工作目录是 /)
  assert.doesNotMatch(request, /coding agent/)
})
