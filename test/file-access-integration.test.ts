import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startFakeLlm } from './fixtures/fake-llm.js'
import { DSH_TIMEOUT_MS, startHarness } from './fixtures/dsh-harness.js'

test('real dsh: a session nobody watches runs at the level picked; what that level would ask is refused, not waited for', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { events, bridge, workspace } = await startHarness(t, { permission: 'read-only' })
  fs.writeFileSync(path.join(workspace, 'notes.txt'), '原有的笔记')
  const agent = bridge()
  await agent.start()
  const started = await agent.startUnattendedTask({ cwd: workspace })
  assert.ok(started.ok && started.taskId, JSON.stringify(started))
  await agent.promptTask(started.taskId, '删掉 notes.txt')
  const end = events.find(event => event.type === 'task_end' && event.taskId === started.taskId)
  assert.equal(end?.stopReason, 'end_turn', JSON.stringify(end))
  assert.ok(fs.existsSync(path.join(workspace, 'notes.txt')), 'read-only: the file is still there')
  assert.equal(events.filter(event => event.type === 'permission').length, 0, 'nothing asked of the user')
})

test('real dsh: an unattended session works in the folder it was given, not the one on screen', { timeout: DSH_TIMEOUT_MS }, async t => {
  const llm = await startFakeLlm({ decideFirst: (request: object) => {
    if (!('messages' in request) || !Array.isArray(request.messages)) return null
    if (!JSON.stringify(request.messages).includes('READ_ITS_FOLDER')) return null
    const last = request.messages.at(-1) as { content: Array<{ type: string }> } | undefined
    return last?.content.some(part => part.type === 'tool_result')
      ? { text: JSON.stringify(last.content) }
      : { tool: { name: 'read', input: { file_path: 'notes.txt' } } }
  } })
  t.after(() => llm.close())
  const { events, bridge, dir, workspace } = await startHarness(t, { env: { DEEPSEEK_BASE_URL: llm.url } })
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'ON_SCREEN_FOLDER')
  const elsewhere = path.join(dir, 'made-here')
  fs.mkdirSync(elsewhere)
  fs.writeFileSync(path.join(elsewhere, 'notes.txt'), 'SCHEDULE_FOLDER')
  const agent = bridge()
  await agent.start()
  const started = await agent.startUnattendedTask({ cwd: elsewhere })
  assert.ok(started.ok && started.taskId, JSON.stringify(started))
  await agent.promptTask(started.taskId, 'READ_ITS_FOLDER')
  const said = JSON.stringify(events.filter(event => event.taskId === started.taskId))
  assert.match(said, /SCHEDULE_FOLDER/, 'read where it was made')
  assert.doesNotMatch(said, /ON_SCREEN_FOLDER/)
  assert.equal(events.filter(event => event.type === 'permission').length, 0)
})
