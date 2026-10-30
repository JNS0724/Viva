import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { permissionCard } from '../src/renderer/prompt-card.ts'
import { permissionDetail } from '../src/renderer/selectors.ts'
import { userError } from '../src/renderer/user-error.ts'
import { recallCandidates, recallMatches, MIN_COVERAGE } from '../plugins/memory/lib/match.ts'
import { memoryTools } from '../plugins/memory/lib/tools.ts'
import { openMemoryDb } from '../plugins/memory/lib/store.ts'
import { materialsFor } from '../src/main/prepare-materials.ts'
import type { Followup } from '../src/main/followup-store.ts'
import { openHistoryDb } from '../src/main/history-db.ts'
import { registerTaskIpc, TASK_PROBLEMS } from '../src/main/task-ipc.ts'

test('approval shows the complete command and every additional argument', () => {
  const command = 'Write-Output "' + '完整命令'.repeat(500) + '"; Remove-Item important.txt'
  const rawInput = { command, description: '生成报告', cwd: 'C:\\work', timeout: 60 }
  const card = permissionCard({ title: '工具请求', rawInput })
  assert.equal(card.title, '运行命令')
  assert.equal(card.command, command)
  assert.deepEqual(JSON.parse(card.detail), rawInput)
  assert.equal(permissionDetail({ rawInput: { command } }), command)
})

test('keyword fallback recovers residence candidates without changing strict coverage or claiming certainty', () => {
  const memories = [{ text: '我常住杭州', keywords: [], updatedAt: 1 }, { text: '周报交给张三', keywords: ['周报'], updatedAt: 2 }]
  assert.equal(MIN_COVERAGE, 0.34)
  assert.deepEqual(recallMatches(memories, '常住 城市 地点', 5), [])
  assert.deepEqual(recallCandidates(memories, '常住 城市 地点', 5), { found: [memories[0]], partial: true })
  assert.deepEqual(recallCandidates(memories, '常住', 5), { found: [memories[0]], partial: false })
  for (const query of ['气象 天气 降雨', '常住 城市 地点 天气 气温', '告诉我这个周末应该带什么出行装备 城市']) {
    assert.deepEqual(recallCandidates(memories, query, 5), { found: [], partial: false })
  }
})

test('recall tool labels partial matches and never recovers invalidated memories', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-recall-regression-'))
  const db = openMemoryDb({ file: path.join(dir, 'memory.db') })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const { memory } = db.addMemory({ text: '我常住杭州', kind: 'fact', keywords: [], source: 'user' })
  const recall = memoryTools(db).find(tool => tool.name === 'memory_recall')!
  assert.match(recall.run({ query: '常住 城市 地点' }), /分词补查候选[\s\S]*我常住杭州/)
  db.invalidateMemory(memory.id, { by: 'user' })
  assert.doesNotMatch(recall.run({ query: '常住 城市 地点' }), /我常住杭州/)
})

test('preparation receives the accepted stage before untrusted conversation material', () => {
  const followup: Followup = { id: 'f1', title: '周报', ask: '起草周报', origin: { kind: 'chat', conversationId: 'c1' }, createdAt: 1,
    remindAt: null, prepareBy: null, files: [], watchPath: null, watchMtime: null, status: 'scheduled', draft: null,
    draftAt: null, readFiles: [], remindedAt: null, lateFrom: null, cue: null }
  const { input } = materialsFor(followup, { conversation: () => [{ role: 'assistant', text: '是否接受这项跟进？' }], profile: () => null, now: () => 1 })
  assert.match(input, /用户已经接受[\s\S]*直接给出可用草稿/)
  assert.ok(input.indexOf('【当前阶段】') < input.indexOf('【材料：对话节选】'))
  assert.match(input, /【材料：对话节选】[\s\S]*是否接受这项跟进/)
})

test('connecting background submission fails before creating a task, then can retry when connected', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-connecting-regression-'))
  const db = openHistoryDb({ file: path.join(dir, 'history.db') })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const conversation = db.create({ sessionId: 'main', cwd: dir })
  let mode = 'connecting', calls = 0
  let invoke: (() => Promise<{ ok: boolean, problem?: string }>) | undefined
  const idle = async () => ({ ok: true })
  registerTaskIpc({ handle(channel, listener) {
    if (channel === 'task:start') invoke = async () => await Reflect.apply(listener, undefined, [null, { text: '完整保留的请求' }]) as { ok: boolean, problem?: string }
  } }, { db, current: () => conversation, setCurrent: () => {}, isBusy: () => false, setBusy: () => {}, agentInfo: () => ({ mode }),
    agent: { spinOff: idle, mergeBack: idle, closeTask: idle, cancelTask: idle, steerTask: idle, resumeTask: idle,
      startTask: async () => { calls++; return { ok: true, taskId: 'task1' } }, promptTask: idle } })
  assert.ok(invoke)
  assert.deepEqual(await invoke(), { ok: false, problem: TASK_PROBLEMS.connecting })
  assert.equal(calls, 0)
  mode = 'live'
  assert.equal((await invoke()).ok, true)
  assert.equal(calls, 1)
})

test('sandbox setup errors distinguish an unexecuted command and do not expose raw paths', () => {
  const message = userError('SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\private\\workspace)')
  assert.match(message, /命令还没有执行[\s\S]*拥有的本地文件夹/)
  assert.doesNotMatch(message, /C:|Win32|SecurityInfo/)
})
