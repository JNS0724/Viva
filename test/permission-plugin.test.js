import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DSH_TIMEOUT_MS, startHarness } from './fixtures/dsh-harness.js'

/**
 * The permission level the user picked (viva-permission), inside the real dsh: 自动 lets ordinary steps through
 * and asks only about the ones its reviewer will not allow; 完全 never asks; 工作区修改 is dsh's usual.
 */

const permissions = (events) => events.filter((event) => event.type === 'permission')

test('自动: an ordinary step runs without asking; removing a file the user had is asked about first', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, bridge, workspace, llm } = await startHarness(t, { permission: 'auto' })
  fs.writeFileSync(path.join(workspace, 'notes.txt'), '原有的笔记')
  const agent = bridge()
  await agent.start()

  await agent.prompt('记住：周报每周五交')
  assert.equal(permissions(events).length, 0, 'the reviewer let it through')
  assert.ok(llm.requests.some((request) => JSON.stringify(request).includes('REVIEW_POLICY')), 'the step was reviewed by the model')
  assert.ok(!events.some((event) => event.type === 'error'), JSON.stringify(events.filter((event) => event.type === 'error')))

  const asked = new Promise((resolve) => {
    const timer = setInterval(() => {
      const card = permissions(events)[0]
      if (!card) return
      clearInterval(timer)
      resolve(card)
    }, 50)
  })
  const turn = agent.prompt('删掉 notes.txt')
  const card = await asked
  const step = events.find((event) => event.update?.sessionUpdate === 'tool_call' && event.update.toolCallId === card.toolCall.toolCallId)
  assert.match(JSON.stringify(step?.update.rawInput), /rm -rf notes\.txt|Remove-Item/, 'the user is asked about the removal')
  agent.respondPermission(card.requestId, 'reject-once')
  await turn
  assert.ok(fs.existsSync(path.join(workspace, 'notes.txt')), 'rejected: the file is still there')
})

test('完全: a removal runs without asking', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { events, bridge, workspace } = await startHarness(t, { permission: 'danger-full-access' })
  fs.writeFileSync(path.join(workspace, 'old.txt'), 'x')
  const agent = bridge()
  await agent.start()
  await agent.prompt('删掉 old.txt')
  assert.equal(permissions(events).length, 0)
  assert.equal(fs.existsSync(path.join(workspace, 'old.txt')), false)
})
