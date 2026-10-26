import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { DSH_TIMEOUT_MS, ROOT, eventually, replies, startHarness } from './fixtures/dsh-harness.js'

test('real dsh keeps a singleton MCP usable after its speculative second process was rejected', { timeout: DSH_TIMEOUT_MS }, async t => {
  const reserve = net.createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const mcpServers = []
  const { bridge, dir, events } = await startHarness(t, { mcpServers, prewarmSessions: true })
  const log = path.join(dir, 'singleton.jsonl')
  mcpServers.push({ name: 'singleton', command: process.execPath, args: [path.join(ROOT, 'test/fixtures/singleton-mcp.js'), String(port), log], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] })
  const agent = bridge(), first = await agent.start()
  assert.deepEqual(first.mcp, { active: ['singleton'], dropped: [] })
  assert.ok(await eventually(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('rejected')), 'preparation actually started a conflicting process')
  const still = await agent.setConfig('model', first.modelValue)
  assert.deepEqual(still.mcp, { active: ['singleton'], dropped: [] })
  const next = await agent.newSession()
  assert.notEqual(next.sessionId, first.sessionId)
  assert.deepEqual(next.mcp, { active: ['singleton'], dropped: [] })
  await agent.prompt('你好')
  assert.equal(events.some(event => event.type === 'error'), false)
  assert.ok(replies(events).join('').includes('你好'))
})
