import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DSH_TIMEOUT_MS, ROOT, eventually, startHarness } from './fixtures/dsh-harness.js'
import type { SourceSpec } from '../src/shared/sources-channel.ts'

/**
 * 消息源 inside the real dsh (plugins/sources): with the app's profile and plugins, a source calls its MCP server's
 * tool with no agent (through viva-mcp's manager), has what it has not seen judged by a model call without tools, and
 * reports the check over the app's channel. The mail is synthetic; the model is the fake Messages endpoint.
 */

const JUDGE = '你替用户筛选新消息'
const systemOf = (request: { system?: unknown }) => (Array.isArray(request.system) ? request.system.map((part: { text?: string }) => part.text ?? '').join('\n') : String(request.system ?? ''))

test('in real dsh a source reads its MCP tool with no agent, has what is new judged without tools, and reports it', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const messages: any[] = []
  const judged: any[] = []
  const mcpServers: object[] = []
  const decideFirst = (request: { system?: unknown, model?: string }) => {
    if (!systemOf(request).includes(JUDGE)) return null
    judged.push(request)
    return { text: JSON.stringify({ decisions: [{ key: 'a1@example.test', push: true, reason: '涉及时间安排' }] }) }
  }
  const { bridge, dir, events, llm } = await startHarness(t, {
    mcpServers,
    decideFirst,
    pluginConfig: { 'viva-sources': { startDelayMs: 0, startSpreadMs: 0 } },
    onPluginMessage: (message: unknown) => messages.push(message),
  })
  const sentFile = path.join(dir, 'sent.txt')
  mcpServers.push({ name: 'mail', entry: { transport: 'stdio', command: process.execPath, args: [path.join(ROOT, 'test/fixtures/source-mail-mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1', MAIL_SENT_FILE: sentFile } } })
  const agent = bridge()
  await agent.start()
  assert.ok(await eventually(() => messages.some((message) => message.type === 'sources_ready'), { timeoutMs: 20_000 }), 'viva-sources started and said so')
  const mcp = () => events.filter((event: { type: string }) => event.type === 'mcp_status').at(-1)?.mcp
  assert.ok(await eventually(() => mcp()?.active.includes('mail'), { timeoutMs: 20_000 }), JSON.stringify(mcp()))

  // The route a source keeps is the conversation's: the fake endpoint answers whatever model the profile names.
  const model = String((llm.requests.at(-1) as { model?: string } | undefined)?.model ?? 'deepseek-chat')
  const spec: SourceSpec = {
    id: 'src-test', name: '重要邮件提醒', tool: 'mcp__mail__search_unread', args: { since: '{last}' }, decode: 'json-text', items: '$.results',
    map: { key: '$.id', title: '$.subject', body: '$.preview', link: null, time: '$.date' }, judge: '来自真人、涉及时间安排的',
    everyMinutes: 15, model: { provider: 'deepseek-official', model }, paused: false, createdAt: 0, lastCheckedAt: null,
  }
  agent.sendToPlugins({ type: 'sources_set', version: 1, sources: [{ ...spec, seen: ['n7@example.test'] }] })
  assert.ok(await eventually(() => messages.some((message) => message.type === 'source_checked'), { timeoutMs: 30_000 }), 'a check came back')

  const checked = messages.find((message) => message.type === 'source_checked')
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.deepEqual(checked.items.map((item: { key: string, push: boolean }) => [item.key, item.push]), [['a1@example.test', true]], 'only the message not seen before, judged')
  assert.equal(checked.items[0].title, '周五评审改到 15:00')
  assert.equal(judged.length, 1)
  assert.ok(!judged[0].tools?.length, 'the judging call has no tools')
  assert.match(JSON.stringify(judged[0].messages), /<<<DATA [0-9a-f]{12}>>>/, 'the mail goes in fenced, as data')
  assert.equal(fs.existsSync(sentFile), false, 'nothing but the confirmed tool was called')
})
