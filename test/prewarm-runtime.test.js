import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { DSH_TIMEOUT_MS, ROOT, eventually, replies, startHarness } from './fixtures/dsh-harness.js'

test('real dsh connects the user\'s MCP servers once for every session: a hung one holds none up, a singleton never starts twice', { timeout: DSH_TIMEOUT_MS }, async t => {
  const reserve = net.createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const mcpServers = []
  const { bridge, dir, events, llm } = await startHarness(t, { mcpServers, prewarmSessions: true })
  const log = path.join(dir, 'singleton.jsonl')
  const node = (args, env = {}) => ({ transport: 'stdio', command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1', ...env } })
  mcpServers.push(
    { name: 'singleton', entry: node([path.join(ROOT, 'test/fixtures/singleton-mcp.js'), String(port), log]) },
    { name: 'mail', entry: node([path.join(ROOT, 'test/fixtures/mail-mcp.js')], { MAIL_SENT_FILE: path.join(dir, 'sent.txt') }) },
    // Starts and never answers: a stuck npx, an unreachable gateway.
    { name: 'stuck', entry: node(['-e', 'process.stdin.resume(); setInterval(() => {}, 1 << 30)']) },
  )
  const agent = bridge()
  const began = Date.now()
  const first = await agent.start()
  const next = await agent.newSession()
  assert.ok(Date.now() - began < 20_000, `sessions opened without waiting on the hung server (${Date.now() - began} ms)`)
  assert.notEqual(next.sessionId, first.sessionId)
  const latest = () => events.filter(event => event.type === 'mcp_status').at(-1)?.mcp
  assert.ok(await eventually(() => latest()?.active.includes('singleton') && latest()?.active.includes('mail'), { timeoutMs: 20_000 }), JSON.stringify(latest()))
  assert.ok(latest().connecting.some(server => server.name === 'stuck') || latest().dropped.some(server => server.name === 'stuck'), JSON.stringify(latest()))

  // MCP tools are a task's (the main conversation hands such work over): the task's model has the mail server's.
  const task = await agent.startTask()
  assert.ok(task.ok && task.taskId, JSON.stringify(task))
  await agent.promptTask(task.taskId, '列出可用工具')
  const asked = llm.requests.find(request => JSON.stringify(request.messages).includes('列出可用工具'))
  assert.ok(asked?.tools?.some(tool => tool.name === 'mcp__mail__send_email'), JSON.stringify(asked?.tools?.map(tool => tool.name)))
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(runs.filter(run => run.kind === 'rejected').length, 0, 'one process for every session, never a second fighting the first')
  assert.equal(events.some(event => event.type === 'error'), false)
})
