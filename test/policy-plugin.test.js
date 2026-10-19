import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decide, DRAFT_ONLY } from '../plugins/policy/lib/rules.js'
import { DSH_TIMEOUT_MS, ROOT, replies, startHarness } from './fixtures/dsh-harness.js'

/** The policy plugin: the app sends nothing on the user's behalf, decided in code before a tool runs. */
const MAIL_SERVER = path.join(ROOT, 'test', 'fixtures', 'mail-mcp.js')

test('MCP tools that send are refused, whatever their naming style; drafting and dsh tools pass', () => {
  for (const name of ['mcp__mail_1a2b3c4d__send_email', 'mcp__slack__postMessage', 'mcp__im__reply-to-thread', 'mcp__feishu__forward_message']) {
    assert.deepEqual(decide({ name }), { kind: 'deny', reason: DRAFT_ONLY }, name)
  }
  for (const name of ['mcp__mail__create_draft', 'mcp__blog__get_posts', 'mcp__mail__sender_stats', 'bash', 'send_message', 'memory_remember']) {
    assert.equal(decide({ name }), null, name)
  }
})

test('inside dsh a send is refused before it runs, and a draft still goes through', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-mail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sentFile = path.join(dir, 'sent.txt')
  const mail = {
    name: 'mail',
    command: process.execPath,
    args: [MAIL_SERVER],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: 'MAIL_SENT_FILE', value: sentFile }],
  }
  const { events, bridge } = await startHarness(t, { mcpServers: [mail], allow: true })
  const agent = bridge()
  const info = await agent.start()
  assert.deepEqual(info.mcp.active, ['mail'])

  await agent.prompt('发邮件给张三说周报已经交了')
  await agent.prompt('存草稿给张三说周报已经交了')

  const answer = replies(events).join('')
  assert.match(answer, /只能起草，不能直接发送/, 'the model hears why')
  assert.match(answer, /DRAFT SAVED/)
  assert.equal(fs.existsSync(sentFile), false, 'nothing was sent')
  // dsh runs MCP tools without asking, so this plugin is what stands between the model and a send.
  assert.equal(events.filter((e) => e.type === 'permission').length, 0)
})
