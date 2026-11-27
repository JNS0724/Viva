import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { activeHours, MIN_SAMPLES } from '../src/backend/habits.ts'
import { DatabaseSync } from 'node:sqlite'
import { openIndependentHistory } from './fixtures/independent-history.ts'
import { formatAutomaticRecallMessage, formatMemoryRulesSection, formatProfileContext } from '../src/memory/core/memory-context.ts'
import { assembleDreamProfileBody, MAX_PROFILE_L2_CHARS, measureConfirmedSectionL2, mergeUserProfileEdit, projectProfileL2 } from '../src/memory/core/resident-profile.ts'
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
  const runtime = createMemoryRuntime({ store, compute: () => null, route: () => null, changed: () => {} })
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

test('L1 rules, L2 profile context and L3 recall message stay cleanly separated', () => {
  const rules = formatMemoryRulesSection()
  assert.match(rules, /memory_read/)
  assert.match(rules, /## 用户确认/)
  assert.equal(rules.includes('忘掉 #'), false)

  const profile = formatProfileContext({ text: '## 用户确认\n- 先给结论', today: '2026-11-16' })
  assert.match(profile, /<about-user>/)
  assert.match(profile, /2026-11-16/)
  assert.match(profile, /先给结论/)
  assert.match(profile, /<\/about-user>$/)

  assert.equal(formatProfileContext({ text: '', today: '2026-11-16' }), '<about-user>\n【今天】\n2026-11-16\n</about-user>')
  assert.equal(formatProfileContext({ text: '', today: '' }), '')

  const recall = formatAutomaticRecallMessage({
    turn: 2,
    ref: 'req-1',
    result: { status: 'hit', text: '[digest] 周报每周五提交', partial: false, hits: [{ text: '周报每周五提交', names: ['周报'] }] },
  })
  assert.ok(recall)
  assert.match(recall, /^<memory-recall turn="2" ref="req-1">/)
  assert.match(recall, /周报每周五提交/)
  assert.match(recall, /<\/memory-recall>$/)
})

test('resident profile projection strips Sources, preserves confirmed section first and bounds length', () => {
  const longAuto = '自动整理的习惯描述'.repeat(120)
  const markdown = `---\nname: Personal Profile\ndescription: Resident\n---\n\n## 用户确认\n- 始终用中文回复\n\n## 自动整理\n- ${longAuto}\n\n## Sources\n- [[daily/2026-11-16/note-a.md]]`
  const projected = projectProfileL2(markdown)
  assert.ok([...projected].length <= MAX_PROFILE_L2_CHARS)
  assert.match(projected, /## 用户确认\n- 始终用中文回复/)
  assert.equal(projected.includes('## Sources'), false)
  assert.equal(projected.includes('[[daily/'), false)

  const merged = mergeUserProfileEdit('## 自动整理\n- 习惯 A', '## 自动整理\n- 习惯 A\n- 新增偏好 B')
  assert.match(merged, /## 用户确认\n- 新增偏好 B/)
  assert.match(merged, /## 自动整理\n- 习惯 A/)

  assert.throws(() => assembleDreamProfileBody({ existingBody: null, autoSummaryBody: '## 用户确认\n- 假冒', action: 'CREATE' }), /dream-profile-reserved-heading/)
  assert.throws(() => assembleDreamProfileBody({ existingBody: '## 用户确认\n- A', autoSummaryBody: '## 自动整理\n- B\n## 自动整理\n- C', action: 'REFINE' }), /dream-profile-reserved-heading/)
  assert.ok(measureConfirmedSectionL2(merged) > 0)
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
  const owner = openMemoryOwner({ root: path.join(dir, 'owner'), compute: () => null, route: () => null })
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
  const page = await call('memory:get') as {
    cleanupPending: number, revision: number, residentProfile: unknown, habits: { samples: number },
  }
  assert.equal(result.status, 'applied')
  assert.deepEqual([page.cleanupPending, page.residentProfile, page.habits.samples], [0, null, 3])
  assert.equal(handlers.has('memory:add'), false)
  assert.equal(handlers.has('memory:set-profile'), false)
  assert.equal(handlers.has('memory:onboarding'), false)
  assert.deepEqual(await call('memory:add-docs'), [], 'cancelling the file picker adds nothing')
  await assert.rejects(call('memory:create-file', { operationId: randomUUID(), text: 42 }), /invalid memory:create-file arguments/)
})

test('memory IPC rebuilds derived indexes without modifying the canonical records', async t => {
  const { dir, defer } = scratch(t, 'memory-ipc-index-')
  const owner = openMemoryOwner({ root: path.join(dir, 'owner'), compute: () => null, route: () => null })
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

test('questionTimes uses the partial user covering index without temp B-tree and skips soft-deleted conversations', t => {
  const { dir, defer } = scratch(t, 'history-question-times-')
  const dbFile = path.join(dir, 'app.db')
  let clock = 1_700_000_000_000
  const history = openIndependentHistory({ file: dbFile, now: () => clock })
  defer(() => history.close())

  const kept = history.create({ sessionId: 's-kept', cwd: dir })
  clock = 1_700_000_010_000
  history.save(kept, [
    { role: 'user', text: 'q1', receipt: null },
    { role: 'assistant', text: 'a1', receipt: null },
  ])
  const deleted = history.create({ sessionId: 's-del', cwd: dir })
  clock = 1_700_000_020_000
  history.save(deleted, [
    { role: 'user', text: 'q-deleted', receipt: null },
    { role: 'assistant', text: 'a-deleted', receipt: null },
  ])
  const latest = history.create({ sessionId: 's-latest', cwd: dir })
  clock = 1_700_000_030_000
  history.save(latest, [
    { role: 'user', text: 'q2', receipt: null },
    { role: 'assistant', text: 'a2', receipt: null },
  ])
  history.softDelete(deleted.id)

  assert.deepEqual(history.questionTimes(), [1_700_000_030_000, 1_700_000_010_000])
  assert.deepEqual(history.questionTimes(1), [1_700_000_030_000])

  const raw = new DatabaseSync(dbFile)
  defer(() => raw.close())
  const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT m.created_at FROM messages m
    CROSS JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.deleted_at IS NULL
    ORDER BY m.id DESC LIMIT ?`).all(1000).map(row => String(row.detail))
  assert.ok(plan.some(line => line.includes('messages_user_order')), JSON.stringify(plan))
  assert.equal(plan.some(line => line.includes('TEMP B-TREE')), false, JSON.stringify(plan))
})
