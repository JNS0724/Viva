import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createTaskRuntime, taskProblems } from '../src/backend/task-runtime.ts'
import { permissionCard } from '../src/renderer/prompt-card.ts'
import { permissionDetail } from '../src/renderer/selectors.ts'
import { userError } from '../src/renderer/user-error.ts'

test('approval shows the complete command and every additional argument', () => {
  const command = 'Write-Output "' + '完整命令'.repeat(500) + '"; Remove-Item important.txt'
  const rawInput = { command, description: '生成报告', cwd: 'C:\\work', timeout: 60 }
  const card = permissionCard({ title: '工具请求', rawInput })
  assert.equal(card.title, '运行命令')
  assert.equal(card.command, command)
  assert.deepEqual(JSON.parse(card.detail), rawInput)
  assert.equal(permissionDetail({ rawInput: { command } }), command)
  assert.equal(permissionCard({ title: '配置 MCP 服务', rawInput: { name: 'qa', command: 'node', args: ['server.js'] } }).title, '配置 MCP 服务')
})

test('a task asked for while connecting is refused before one is created, and starts once connected', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-connecting-regression-'))
  const db = openHistoryDb({ file: path.join(dir, 'history.db') })
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const conversation = db.create({ sessionId: 'main', cwd: dir })
  let mode = 'connecting', calls = 0
  const idle = async () => ({ ok: true })
  const runtime = createTaskRuntime({ db, current: () => conversation, agentInfo: () => ({ mode }),
    agent: { closeTask: idle, cancelTask: idle, steerTask: idle, resumeTask: idle,
      startTask: async () => { calls++; return { ok: true, taskId: 'task1' } }, promptTask: idle } })
  await assert.rejects(runtime.agent.start('完整保留的请求'), (err: Error) => err.message === taskProblems().connecting)
  assert.equal(calls, 0)
  mode = 'live'
  assert.equal((await runtime.agent.start('完整保留的请求')).status, 'running')
  assert.equal(calls, 1)
})

test('sandbox setup errors distinguish an unexecuted command and do not expose raw paths', () => {
  const message = userError('SetNamedSecurityInfoW failed (Win32 5): grantWrite(C:\\private\\workspace)')
  assert.match(message, /命令还没有执行[\s\S]*拥有的本地文件夹/)
  assert.doesNotMatch(message, /C:|Win32|SecurityInfo/)
})
