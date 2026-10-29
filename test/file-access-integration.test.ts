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
