import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startFakeLlm } from './fixtures/fake-llm.js'
import { DSH_TIMEOUT_MS, eventually, replies, startHarness } from './fixtures/dsh-harness.js'

test('real dsh asks for an external read each time, and denial never returns the external content', { timeout: DSH_TIMEOUT_MS }, async t => {
  let file = ''
  const llm = await startFakeLlm({ decideFirst: (request: object) => {
    if (!('messages' in request) || !Array.isArray(request.messages)) return null
    if (!JSON.stringify(request.messages).includes('READ_CONSENT_TEST')) return null
    const last = request.messages.at(-1) as { content: Array<{ type: string }> } | undefined
    return last?.content.some(part => part.type === 'tool_result')
      ? { text: JSON.stringify(last.content) }
      : { tool: { name: 'read', input: { file_path: file } } }
  } })
  t.after(() => llm.close())
  const { events, bridge, dir, workspace } = await startHarness(t, { env: { DEEPSEEK_BASE_URL: llm.url } })
  const agent = bridge()
  await agent.start()
  file = path.join(workspace, 'inside.txt')
  fs.writeFileSync(file, 'INSIDE_CONSENT_VALUE')
  await agent.prompt('READ_CONSENT_TEST inside')
  assert.equal(events.filter(event => event.type === 'permission').length, 0)
  assert.ok(replies(events).join('').includes('INSIDE_CONSENT_VALUE'))

  file = path.join(dir, 'outside.txt')
  fs.writeFileSync(file, 'OUTSIDE_CONSENT_VALUE')
  const allowed = agent.prompt('READ_CONSENT_TEST outside allow')
  const card = await eventually(() => events.find(event => event.type === 'permission'))
  assert.ok(card, 'outside content must wait for a permission card')
  assert.ok(!replies(events).join('').includes('OUTSIDE_CONSENT_VALUE'), 'no content before consent')
  agent.respondPermission(card.requestId, 'allow-once')
  await allowed
  assert.ok(replies(events).join('').includes('OUTSIDE_CONSENT_VALUE'))

  const start = events.length
  const denied = agent.prompt('READ_CONSENT_TEST outside deny')
  const again = await eventually(() => events.slice(start).find(event => event.type === 'permission'))
  assert.ok(again, 'allow-once must not become a standing grant')
  agent.respondPermission(again.requestId, 'reject-once')
  await denied
  assert.ok(!replies(events.slice(start)).join('').includes('OUTSIDE_CONSENT_VALUE'), 'denial may not disclose file contents')
})

test('real dsh: a session marked unattended may only look things up, even at 完全, and asks the user nothing', { timeout: DSH_TIMEOUT_MS }, async t => {
  const { events, bridge, workspace } = await startHarness(t, { permission: 'danger-full-access' })
  fs.writeFileSync(path.join(workspace, 'notes.txt'), '原有的笔记')
  const agent = bridge()
  await agent.start()
  const started = await agent.startReadOnlyTask({ cwd: workspace })
  assert.ok(started.ok && started.taskId, JSON.stringify(started))
  await agent.promptTask(started.taskId, '删掉 notes.txt')
  const end = events.find(event => event.type === 'task_end' && event.taskId === started.taskId)
  assert.equal(end?.stopReason, 'end_turn', JSON.stringify(end))
  assert.ok(fs.existsSync(path.join(workspace, 'notes.txt')), 'refused: the file is still there')
  assert.equal(events.filter(event => event.type === 'permission').length, 0, 'nothing asked of the user')
  const said = JSON.stringify(events.filter(event => event.taskId === started.taskId))
  assert.match(said, /定时任务只能查看/, 'the model was told why')
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
  const started = await agent.startReadOnlyTask({ cwd: elsewhere })
  assert.ok(started.ok && started.taskId, JSON.stringify(started))
  await agent.promptTask(started.taskId, 'READ_ITS_FOLDER')
  const said = JSON.stringify(events.filter(event => event.taskId === started.taskId))
  assert.match(said, /SCHEDULE_FOLDER/, 'read where it was made')
  assert.doesNotMatch(said, /ON_SCREEN_FOLDER/)
  assert.equal(events.filter(event => event.type === 'permission').length, 0)
})
