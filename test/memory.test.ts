import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { activeHours, MIN_SAMPLES } from '../src/backend/habits.ts'
import { packContext, MAX_CONTEXT_CHARS } from '../src/memory/core/memory-context.ts'
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
  const operationId = randomUUID()
  const item = await runtime.writeManagedFile(operationId, runtime.manualFileWorkspace(), { operationId, text: '我负责 Viva 的发布' }, () => {})
  assert.ok(item)
  await runtime.setProfile({ projects: 'Atlas' })
  assert.ok(runtime.readFile(item.identity)?.markdown.includes('我负责 Viva 的发布'))
  assert.equal(runtime.accept('Viva 下周发版', { conversation: 'topic', session: 'session' }).outcome, 'recorded')
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

test('the fixed context includes user-authored profile fields and file memory rules', () => {
  const packed = packContext({ profile: { role: { value: '发布负责人' }, email: { value: 'private@example.com' } }, today: '2026-11-16' })
  assert.match(packed.text, /发布负责人/)
  assert.match(packed.text, /2026-11-16/)
  assert.match(packed.text, /daily/)
  assert.match(packed.text, /memory_read/)
  assert.equal(packed.text.includes('private@example.com'), false)
  assert.equal(packed.text.includes('忘掉 #'), false)
})

test('the manual profile fixed layer remains inside the context budget', () => {
  const profile = Object.fromEntries(['role', 'projects', 'preferences', 'other'].map(key => [key, { value: '很长的资料'.repeat(1000) }]))
  const packed = packContext({ profile, today: '2026-11-16' })
  assert.ok(packed.text.length <= MAX_CONTEXT_CHARS)
  assert.match(packed.text, /<about-user>/)
  assert.match(packed.text, /<\/about-user>$/)
})

test('custom profile labels keep complete bounded fields and preserve the date', () => {
  const packed = packContext({ profile: { preference: { value: '简练\n清楚' } }, today: '2026-11-16', profileLabels: [{ key: 'preference', label: '偏好' }] })
  assert.match(packed.text, /偏好：简练；清楚/)
  assert.match(packed.text, /2026-11-16/)
  assert.ok(packed.text.length <= MAX_CONTEXT_CHARS)
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

test('memory IPC creates file memory and reports the profile page in one call', async t => {
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

  const result = await call('memory:create-file', { operationId: randomUUID(), text: '回答先给结论。' }) as { status: string }
  await call('memory:set-profile', { role: '后端负责人' })
  const page = await call('memory:get') as {
    profile: { role: { value: string } }, onboarding: string, habits: { samples: number },
  }
  assert.equal(result.status, 'applied')
  assert.deepEqual([page.profile.role.value, page.onboarding, page.habits.samples], ['后端负责人', 'pending', 3])
  assert.equal(handlers.has('memory:add'), false)
  assert.deepEqual(await call('memory:add-docs'), [], 'cancelling the file picker adds nothing')
  assert.equal(await call('memory:onboarding', 'done'), 'done')
  await assert.rejects(call('memory:create-file', { operationId: randomUUID(), text: 42 }), /invalid memory:create-file arguments/)
})

test('memory IPC rebuilds derived indexes without modifying the canonical records', async t => {
  const { dir, defer } = scratch(t, 'memory-ipc-index-')
  const owner = openMemoryOwner({ root: path.join(dir, 'owner'), compute: () => null, route: () => null, quiesce: async () => {} })
  await owner.recover(); defer(() => owner.close())
  const runtime = owner.runtime
  const created = await ownerClient(owner).createFile({ operationId: randomUUID(), text: '我的工作电脑使用 Iosevka。' })
  const before = runtime.readFile(created.identity)
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
  assert.deepEqual(runtime.readFile(created.identity), before)
})
