import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { activeHours, MIN_SAMPLES } from '../src/backend/habits.ts'
import { packContext, MAX_CONTEXT_CHARS } from '../src/memory/core/memory-context.ts'
import { recallMatches, termsOf } from '../src/memory/core/memory-match.ts'
import { looksSecret } from '../src/memory/core/memory-sensitive.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { createMemoryRuntime } from './fixtures/localized-memory-runtime.ts'
import { ownerClient } from './fixtures/memory-owner-client.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { copyIntoWorkspace, DOCS_DIR_NAME, registerRuntimeMemoryIpc } from '../src/backend/memory-ipc.ts'
import { scratch } from './fixtures/scratch.js'
import { checkedIpc } from '../src/shared/ipc-contract.ts'
import type { RawIpc } from '../src/shared/ipc-contract.ts'

function memoryRuntime(t: TestContext) {
  const { dir, defer } = scratch(t, 'memory-test-')
  const store = openMemoryStore(path.join(dir, 'memory.db'))
  const runtime = createMemoryRuntime({ store, compute: () => null, route: () => null, quiesce: async () => {}, changed: () => {} })
  defer(async () => { await runtime.wake(); runtime.close() })
  return { dir, runtime }
}

const at = (month: number, day: number, hour = 10) => new Date(2026, month - 1, day, hour).getTime()

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
  const texts = (query: string) => recallMatches(items, query, 5).map((m) => m.text)
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
  assert.ok(looksSecret('https://example.test/?access_token=synthetic-test-token'))
  assert.ok(looksSecret('https://user:synthetic-password@example.test/'))
  assert.ok(looksSecret('https://example.test/invite/sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'))
  assert.ok(looksSecret('https://example.test/invite/s%6b%2dABCDEFGHIJKLMNOPQRSTUVWXYZ0123'))
  assert.ok(looksSecret('https://example.test/?%61ccess%5ftoken=synthetic-test-token'))
  assert.ok(looksSecret('https://example.test/?unrecognized=s%6b%2dABCDEFGHIJKLMNOPQRSTUVWXYZ0123'))
  assert.ok(looksSecret('https://example.test/callback#refresh_token=syntheticABc123456789'))
  assert.ok(looksSecret('https://example.test/?authorization=Bearer%20syntheticABc123456789'))
  assert.ok(looksSecret('https://example.test/?X-Amz-Security-Token=syntheticABc123456789'))
  assert.ok(looksSecret('https://example.test/reset/0123abcd4567ef890123abcd4567ef89'))
  assert.ok(looksSecret('password is syntheticPassword'))
  assert.equal(looksSecret('公司要求密码每 90 天更换一次'), false)
  assert.equal(looksSecret('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit'), false)
})

test('profile fields belong to the user and changing a field keeps unrelated memories', async t => {
  const { runtime } = memoryRuntime(t)
  await runtime.setProfile({ role: '后端负责人', projects: 'Viva' })
  assert.deepEqual(Object.keys(runtime.profile()).sort(), ['projects', 'role'])
  assert.equal(runtime.profile().role.source, 'user')
  const item = runtime.addMemory('我负责 Viva 的发布')!
  await runtime.setProfile({ projects: 'Atlas' })
  assert.equal(runtime.listMemories().items[0].id, item.id)
  assert.equal(runtime.accept('Viva 下周发版', { conversation: 'topic', session: 'session' }).outcome, 'pending')
  await runtime.setProfile({ projects: '' })
  assert.equal(runtime.profile().projects, undefined)
  assert.throws(() => runtime.setProfile({ department: '支付平台部' }))
  assert.throws(() => runtime.setProfile({ role: 'token: abcdef1234567' }), /凭据/)
})

test('onboarding starts pending and only takes known states', t => {
  const { runtime } = memoryRuntime(t)
  assert.equal(runtime.onboarding(), 'pending')
  runtime.setOnboarding('skipped')
  assert.equal(runtime.onboarding(), 'skipped')
  assert.throws(() => runtime.setOnboarding('later'), /invalid onboarding state/)
})

test('the context block carries the fixed layer and pushed memories with their names, never the email', () => {
  const memory = (text: string) => ({ text, createdAt: at(10, 12) })
  const preference = { text: '回答先给结论', dependency: { id: 1, revision: 3, collectionRevision: 5 } }
  const projectFact = { text: '先核对清结算的草稿', dependency: { id: 2, revision: 5 } }
  const fixed = {
    profile: { role: { value: '后端负责人\n负责清结算' }, email: { value: 'me@corp.example' } },
    user: { generated: true, items: [preference] },
    project: { generated: false, items: [projectFact] },
  }
  const { text: context, profile } = packContext({ fixed, pushed: [{ memory: memory('周报每周五交给张三'), names: ['周报', '张三'] }] })
  assert.match(context, /^<about-user>\n/)
  assert.match(context, /【记忆规则】\n.*memory_recall/)
  assert.match(context, /【画像】\n角色与职责：后端负责人；负责清结算\n【助手整理的画像】\n- 回答先给结论\n【项目原始记忆】\n- 先核对清结算的草稿\n/)
  assert.match(context, /【相关记忆】\n- （2026-10-12）周报每周五交给张三〔周报、张三〕\n<\/about-user>$/)
  assert.doesNotMatch(context, /me@corp|collectionRevision/)
  assert.deepEqual(profile, [preference, projectFact])
  assert.doesNotMatch(packContext({ fixed: null, pushed: [{ memory: memory('x'), names: ['x'] }] }).text, /记忆规则/)
  assert.deepEqual(packContext({ fixed: null, pushed: [] }), { text: '', pushed: [], profile: [] })
})

test('the fixed layer stays within its budget however much is stored', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ text: `第 ${i} 条很长的记忆`.padEnd(120, '。'), dependency: { id: i + 1, revision: 1 } }))
  const profile = Object.fromEntries(['role', 'department', 'domain', 'projects', 'people', 'preferences', 'sources'].map((key) => [key, { value: 'x'.repeat(1000) }]))
  const { text: context, profile: shown } = packContext({ fixed: { profile, user: { generated: true, items: many } }, pushed: [] })
  assert.ok(context.length <= MAX_CONTEXT_CHARS, `was ${context.length}`)
  assert.ok(shown.length > 0 && shown.length < many.length)
  assert.deepEqual(shown, many.filter(item => context.includes(item.text)))
  assert.match(context, /【记忆规则】/, 'the rules always fit')
  assert.match(context, /<\/about-user>$/)
})

test('the context budget covers the date, profile, full memories and the conflict notice together', () => {
  const fixed = { profile: { role: { value: '审核员' } } }
  const today = '2026-10-12（周一）'
  const item = (id: number, text: string) => ({ memory: { id, revision: 1, text, createdAt: at(10, 12) }, names: ['周报'] })
  const oversized = item(1, '过大的周报'.padEnd(MAX_CONTEXT_CHARS, '超'))
  const assertion = '周报交给张三'
  const condition = '，客户故障时除外'
  const ordinary = item(2, assertion + condition)
  const args = { fixed, today, disputed: true }
  const base = packContext({ ...args, pushed: [ordinary] })
  const exact = item(2, `${assertion}${'。'.repeat(MAX_CONTEXT_CHARS - base.text.length)}${condition}`)
  const { text, pushed } = packContext({ ...args, pushed: [oversized, exact, item(3, '没有空间的周报')] })

  assert.equal(text.length, MAX_CONTEXT_CHARS)
  assert.deepEqual(pushed.map(({ memory }) => [memory.id, memory.revision]), [[2, 1]])
  assert.match(text, /【今天】\n2026-10-12（周一）/)
  assert.match(text, /角色与职责：审核员/)
  assert.ok(text.includes(`${exact.memory.text}〔周报〕`), 'critical qualifiers and a fitting memory remain complete')
  assert.match(text, /【记忆冲突】\n当前问题涉及待澄清的记忆。/)
  assert.doesNotMatch(text, /过大的周报|没有空间的周报/)
  assert.deepEqual(packContext({ fixed: null, pushed: [oversized] }), { text: '', pushed: [], profile: [] })
})

test('active hours need enough questions and merge neighbouring hours', () => {
  assert.equal(activeHours([at(1, 1)]).text, '')
  const day = [9, 9, 10, 10, 11, 14, 15, 15, 16, 16]
  const times = Array.from({ length: MIN_SAMPLES }, (_, i) => at(1, 1 + i, day[i % day.length]))
  const result = activeHours([...times, at(2, 1, 3)])
  assert.deepEqual(result.ranges, [[9, 12], [14, 17]])
  assert.equal(result.text, '常在 9–12 点、14–17 点使用')
})

test('picked documents are copied into the workspace under a free name', (t) => {
  const { dir } = scratch(t, 'memory-documents-')
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

test('memory IPC adds as the user and reports the page in one call', async t => {
  const { dir, defer } = scratch(t, 'memory-ipc-owner-')
  const owner = openMemoryOwner({ root: path.join(dir, 'owner'), compute: () => null, route: () => null, quiesce: async () => {} })
  await owner.recover(); defer(() => owner.close())
  const handlers = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const registry = checkedIpc({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, {
    onRefused: (_channel, problem) => { throw new Error(problem) },
  })
  registerRuntimeMemoryIpc(registry, {
    client: ownerClient(owner), habits: () => ({ text: '', samples: 3 }), cwd: () => dir, chooseDocs: async () => null,
  })
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

  const memory = await call('memory:add', '回答先给结论', 'preference') as { source: string }
  await call('memory:set-profile', { role: '后端负责人' })
  const page = await call('memory:get') as {
    total: number, items: { text: string }[], profile: { role: { value: string } }, onboarding: string, habits: { samples: number },
  }
  assert.equal(memory.source, 'user')
  assert.deepEqual([page.total, page.items[0].text, page.profile.role.value, page.onboarding, page.habits.samples], [1, '回答先给结论', '后端负责人', 'pending', 3])
  assert.deepEqual(await call('memory:add-docs'), [], 'cancelling the file picker adds nothing')
  assert.equal(await call('memory:onboarding', 'done'), 'done')
  await assert.rejects(call('memory:add', 42), /invalid memory:add arguments/)
})

test('memory IPC rebuilds derived indexes without modifying the canonical records', async t => {
  const { dir, defer } = scratch(t, 'memory-ipc-index-')
  const owner = openMemoryOwner({ root: path.join(dir, 'owner'), compute: () => null, route: () => null, quiesce: async () => {} })
  await owner.recover(); defer(() => owner.close())
  const runtime = owner.runtime
  runtime.addMemory('我的工作电脑使用 Iosevka')
  const before = runtime.listMemories()
  const handlers = new Map<string, Parameters<RawIpc['handle']>[1]>()
  const registry = checkedIpc({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, {
    onRefused: (_channel, problem) => { throw new Error(problem) },
  })
  registerRuntimeMemoryIpc(registry, {
    client: ownerClient(owner),
    habits: () => ({ text: '', samples: 0 }), cwd: () => dir, chooseDocs: async () => null,
  })
  assert.deepEqual(await handlers.get('memory:rebuild-indexes')!({}), { fullText: true, semantic: true, files: { lexical: true, vectorGeneration: 1 } })
  assert.throws(() => handlers.get('memory:rebuild-indexes')!({}, 'invalid'), /invalid memory:rebuild-indexes arguments/)
  assert.deepEqual(runtime.listMemories(), before)
})
