import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { activeHours, MIN_SAMPLES } from '../src/main/habits.ts'
import { buildContext, MAX_CONTEXT_CHARS } from '../plugins/memory/lib/context.ts'
import { recallMatches, termsOf } from '../plugins/memory/lib/match.ts'
import { looksSecret, openMemoryDb } from '../plugins/memory/lib/store.ts'
import { memoryTools } from '../plugins/memory/lib/tools.ts'
import { copyIntoWorkspace, DOCS_DIR_NAME, registerMemoryIpc } from '../src/main/memory-ipc.ts'
import { scratch } from './fixtures/scratch.js'

const tempDir = (t) => scratch(t, 'memory-test-').dir

function tempDb(t, now = () => 1_760_000_000_000) {
  const { dir, defer } = scratch(t, 'memory-test-')
  const db = openMemoryDb({ file: path.join(dir, 'memory.db'), now })
  defer(() => db.close())
  return db
}

const at = (month, day, hour = 10) => new Date(2026, month - 1, day, hour).getTime()

test('terms are Han bigrams and whole Latin words, without filler', () => {
  assert.deepEqual([...termsOf('帮我写周报')], ['写周', '周报'])
  assert.deepEqual([...termsOf('张三是我的上级')], ['张三', '上级'])
  assert.deepEqual([...termsOf('Review the PR for Q4')], ['review', 'pr', 'q4'])
})

test('recall needs enough of the query or a keyword, and returns nothing rather than weak matches', () => {
  const items = [
    { text: '周报每周五交给张三', keywords: ['周报', '张三'], updatedAt: 1 },
    { text: '张三是我的上级', keywords: [], updatedAt: 2 },
    { text: '结算按 T+1 自然日口径，和财务王五确认过', keywords: [], updatedAt: 3 },
    { text: '财务报销每月 25 号截止', keywords: [], updatedAt: 4 },
  ]
  const texts = (query) => recallMatches(items, query, 5).map((m) => m.text)
  assert.deepEqual(texts('张三 周报'), ['周报每周五交给张三', '张三是我的上级'])
  assert.deepEqual(texts('结算口径 财务'), ['结算按 T+1 自然日口径，和财务王五确认过'], 'one shared pair out of four is not enough')
  assert.deepEqual(texts('周报'), ['周报每周五交给张三'])
  assert.deepEqual(texts('天气'), [])
  assert.deepEqual(texts('这个'), [])
})

test('secrets are refused, mentions and document links are not', () => {
  assert.ok(looksSecret('我的密码是 hunter2'))
  assert.ok(looksSecret('key sk-abcdefghijklmnop1234'))
  assert.ok(looksSecret('身份证 11010519491231002X'))
  assert.ok(looksSecret('api_key: abcdef123456'))
  assert.equal(looksSecret('公司要求密码每 90 天更换一次'), false)
  assert.equal(looksSecret('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit'), false)
})

test('profile fields belong to the user: replaced as written, cleared when empty', (t) => {
  const db = tempDb(t)
  db.setProfile({ role: '后端负责人', projects: '对账系统重构' })
  assert.deepEqual(Object.keys(db.getProfile()).sort(), ['projects', 'role'])
  assert.equal(db.getProfile().role.source, 'user')
  assert.equal(db.appendProfile, undefined, 'the agent has no way to write the profile')

  db.setProfile({ projects: '' })
  assert.equal(db.getProfile().projects, undefined)
  assert.throws(() => db.setProfile({ department: '支付平台部' }), /profile field/, 'fields the profile no longer has are refused')
  assert.throws(() => db.setProfile({ nickname: 'x' }), /invalid profile field/)
  assert.throws(() => db.setProfile({ role: 'token: abcdef1234567' }), /不会被记住/)
})

test('memories are deduplicated, edited, deleted and restored with their id', (t) => {
  let clock = 1000
  const db = tempDb(t, () => clock)
  const first = db.addMemory({ text: '周报每周五交给张三', source: 'agent' })
  clock = 2000
  const again = db.addMemory({ text: '周报每周五交给张三。 ' })
  assert.equal(first.created, true)
  assert.deepEqual([again.created, again.memory.id, again.memory.updatedAt], [false, first.memory.id, 2000])

  const second = db.addMemory({ text: '回答先给结论', kind: 'preference' }).memory
  assert.throws(() => db.updateMemory(second.id, '周报每周五交给张三'), /相同的记忆/)
  assert.equal(db.updateMemory(second.id, '回答先给结论，再给细节').text, '回答先给结论，再给细节')

  const removed = db.deleteMemory(first.memory.id)
  assert.equal(db.deleteMemory(first.memory.id), null)
  assert.equal(db.restoreMemory(removed).id, first.memory.id)
  assert.equal(db.listMemories().total, 2)
  assert.deepEqual(db.listMemories({ query: '结论' }).items.map((m) => m.kind), ['preference'])
  assert.deepEqual(db.ofKind('preference', 5).map((m) => m.id), [second.id])
  assert.throws(() => db.addMemory({ text: '  ' }), /不能为空/)
  assert.throws(() => db.addMemory({ text: 'x', kind: 'gossip' }), /invalid memory kind/)
})

test('what the agent saved during a turn is claimed for that conversation once', (t) => {
  let clock = 1000
  const db = tempDb(t, () => clock)
  db.addMemory({ text: '用户自己加的', source: 'user' })
  clock = 5000
  db.addMemory({ text: '对账服务迁移推迟到 11 月', source: 'agent' })

  const changes = db.claimChanges(4000, 'conv-1')
  assert.deepEqual(changes.memories.map((m) => [m.text, m.conversationId]), [['对账服务迁移推迟到 11 月', 'conv-1']])
  assert.deepEqual(db.claimChanges(4000, 'conv-2').memories, [], 'claimed memories are not reported again')
})

test('onboarding starts pending and only takes known states', (t) => {
  const db = tempDb(t)
  assert.equal(db.onboarding(), 'pending')
  db.setOnboarding('skipped')
  assert.equal(db.onboarding(), 'skipped')
  assert.throws(() => db.setOnboarding('later'), /invalid onboarding state/)
})

test('the context block carries the fixed layer and pushed memories with their names, never the email', () => {
  const memory = (text) => ({ text, createdAt: at(10, 12) })
  const fixed = {
    profile: { role: { value: '后端负责人\n负责清结算' }, email: { value: 'me@corp.example' } },
    synthesis: '【偏好】\n- 回答先给结论',
    recent: [memory('李四是新的直属上级')],
    habits: '常在 9–12 点使用',
  }
  const context = buildContext({ fixed, pushed: [{ memory: memory('周报每周五交给张三'), names: ['周报', '张三'] }] })
  assert.match(context, /^<about-user>\n/)
  assert.match(context, /【记忆规则】\n.*memory_recall/)
  assert.match(context, /【画像】\n角色与职责：后端负责人；负责清结算\n【助手整理的画像】\n【偏好】\n- 回答先给结论\n【最近了解到的】\n- （2026-10-12）李四是新的直属上级\n/)
  assert.match(context, /【使用习惯】\n常在 9–12 点使用/)
  assert.match(context, /【相关记忆】\n- （2026-10-12）周报每周五交给张三〔周报、张三〕\n<\/about-user>$/)
  assert.doesNotMatch(context, /me@corp/)
  assert.doesNotMatch(buildContext({ fixed: null, pushed: [{ memory: memory('x'), names: ['x'] }] }), /记忆规则/)
  assert.equal(buildContext({ fixed: null, pushed: [] }), '')
})

test('the fixed layer stays within its budget however much is stored', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ text: `第 ${i} 条很长的记忆`.padEnd(120, '。'), createdAt: at(1, 1) }))
  const profile = Object.fromEntries(['role', 'department', 'domain', 'projects', 'people', 'preferences', 'sources'].map((key) => [key, { value: 'x'.repeat(1000) }]))
  const context = buildContext({ fixed: { profile, synthesis: 'y'.repeat(1200), recent: many }, pushed: [] })
  assert.ok(context.length <= MAX_CONTEXT_CHARS, `was ${context.length}`)
  assert.match(context, /【记忆规则】/, 'the rules always fit')
  assert.match(context, /<\/about-user>$/)
})

test('active hours need enough questions and merge neighbouring hours', () => {
  assert.equal(activeHours([at(1, 1)]).text, '')
  const day = [9, 9, 10, 10, 11, 14, 15, 15, 16, 16]
  const times = Array.from({ length: MIN_SAMPLES }, (_, i) => at(1, 1 + i, day[i % day.length]))
  const result = activeHours([...times, at(2, 1, 3)])
  assert.deepEqual(result.ranges, [[9, 12], [14, 17]])
  assert.equal(result.text, '常在 9–12 点、14–17 点使用')
})

test('the memory tools save, recall and forget, and refuse secrets', (t) => {
  const db = tempDb(t)
  const tools = Object.fromEntries(memoryTools(db).map((tool) => [tool.name, tool]))
  assert.match(tools.memory_remember.run({ text: '张三是我的上级', kind: 'person', keywords: ['张三'] }), /^已记住（#1）/)
  assert.match(tools.memory_remember.run({ text: '张三是我的上级' }), /^之前已经记过（#1）/)
  assert.throws(() => tools.memory_remember.run({ text: '验证码是 123456' }), /不会被记住/)
  assert.match(tools.memory_recall.run({ query: '张三是谁' }), /#1（\d{4}-\d{2}-\d{2}，person）张三是我的上级〔张三〕/)
  assert.match(tools.memory_recall.run({ query: '天气' }), /^没有找到相关的记忆。/)
  assert.throws(() => tools.memory_recall.run({ query: ' ' }), /关键词/)

  assert.deepEqual(Object.keys(tools), ['memory_remember', 'memory_recall', 'memory_forget'], 'no tool writes the profile')
  assert.ok(tools.memory_remember.parameters.kind.enum.includes('role'))
  assert.match(tools.memory_forget.run({ id: 1 }), /^已忘掉 #1：张三是我的上级（用户可以在「关于你」里恢复）/)
  assert.equal(tools.memory_forget.run({ id: 1 }), '#1 之前已经忘掉了。')
  assert.equal(tools.memory_forget.run({ id: 99 }), '没有编号为 #99 的记忆。')
  assert.equal(db.getMemory(1).invalidatedBy, 'user', 'forgetting only marks it, the user can bring it back')
  assert.match(tools.memory_recall.run({ query: '张三' }), /^没有找到/, 'a forgotten memory is not recalled')
})

test('picked documents are copied into the workspace under a free name', (t) => {
  const dir = tempDir(t)
  const source = path.join(dir, '设计文档.md')
  fs.writeFileSync(source, '# 对账系统')
  const cwd = path.join(dir, 'workspace')

  const first = copyIntoWorkspace([source], cwd)
  const second = copyIntoWorkspace([source], cwd)
  assert.deepEqual(first, [{ name: '设计文档.md', path: `${DOCS_DIR_NAME}/设计文档.md` }])
  assert.deepEqual(second, [{ name: '设计文档 (2).md', path: `${DOCS_DIR_NAME}/设计文档 (2).md` }])
  assert.equal(fs.readFileSync(path.join(cwd, DOCS_DIR_NAME, '设计文档 (2).md'), 'utf8'), '# 对账系统')
  assert.throws(() => copyIntoWorkspace([dir], cwd), /不是文件/)
})

test('memory IPC adds as the user and reports the page in one call', async (t) => {
  const db = tempDb(t)
  const handlers = new Map()
  registerMemoryIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    db, habits: () => ({ text: '', samples: 3 }), cwd: () => tempDir(t), chooseDocs: async () => null,
  })
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)

  const memory = await call('memory:add', '回答先给结论', 'preference')
  await call('memory:set-profile', { role: '后端负责人' })
  const page = await call('memory:get')
  assert.equal(memory.source, 'user')
  assert.deepEqual([page.total, page.items[0].text, page.profile.role.value, page.onboarding, page.habits.samples], [1, '回答先给结论', '后端负责人', 'pending', 3])
  assert.deepEqual(await call('memory:add-docs'), [], 'cancelling the file picker adds nothing')
  assert.equal(await call('memory:onboarding', 'done'), 'done')
  await assert.rejects(call('memory:add', 42), /invalid memory text/)
})
