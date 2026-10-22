import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMemoryDb } from '../plugins/memory/lib/store.ts'
import { createAcpBridge, failingMcpServer } from '../src/main/acp-bridge.ts'
import { openHistoryDb } from '../src/main/history-db.ts'
import { createPersonal } from '../src/main/personal.ts'
import { scratch } from './fixtures/scratch.js'

/** The user's MCP servers through the real bridge and the fake dsh, and what the app reports after a turn. */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_DSH = path.join(ROOT, 'test', 'fixtures', 'fake-dsh.js')
/** Exits at once, so its MCP handshake fails: stands in for a misconfigured user server. */
const BROKEN_SERVER = { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }

function setup(t, { now } = {}) {
  const { dir, defer } = scratch(t, 'mcp-bridge-')
  const memoryDb = openMemoryDb({ file: path.join(dir, 'memory.db'), now })
  const historyDb = openHistoryDb({ file: path.join(dir, 'history.db') })
  const personal = createPersonal({ memoryDb, historyDb, mcpStore: { list: () => [] }, ...(now ? { now } : {}) })
  defer(() => memoryDb.close())
  defer(() => historyDb.close())
  return { dir, defer, memoryDb, personal }
}

/** The fake dsh runs in `cwd`: it is stopped, and waited for, before the directory goes. */
function fakeBridge({ defer }, { mcpServers, cwd }) {
  const bridge = createAcpBridge({
    dshBin: FAKE_DSH,
    nodeBin: 'node',
    cwd,
    env: { ...process.env, FAKE_DSH_DELAY_MS: '0', ELECTRON_RUN_AS_NODE: '' },
    mcpServers,
    emit: () => {},
  })
  defer(() => bridge.dispose())
  return bridge
}

test('a failing MCP server is left out and reported', async (t) => {
  const scratchDir = setup(t)
  const { dir, personal } = scratchDir
  const bridge = fakeBridge(scratchDir, { mcpServers: () => [BROKEN_SERVER], cwd: dir })

  const info = await bridge.start()

  assert.deepEqual(info.mcp.active, [])
  assert.deepEqual(info.mcp.dropped.map((d) => d.name), ['broken'])
  assert.match(info.mcp.dropped[0].reason, /initial connection/)
  assert.deepEqual(personal.mcpStatus(info, 0).dropped, info.mcp.dropped)
})

test('reloading the session picks up a changed server list and keeps the session', async (t) => {
  const scratchDir = setup(t)
  const { dir } = scratchDir
  let servers = []
  const bridge = fakeBridge(scratchDir, { mcpServers: () => servers, cwd: dir })
  const started = await bridge.start()
  servers = [BROKEN_SERVER]

  const reloaded = await bridge.reloadSession()

  assert.equal(reloaded.sessionId, started.sessionId)
  assert.equal(reloaded.resumed, true)
  assert.deepEqual(reloaded.mcp.dropped.map((d) => d.name), ['broken'])
})

test('the failing server is found by name or by position, and nothing else counts', () => {
  const servers = [{ name: 'memory' }, { name: 'github' }]
  assert.equal(failingMcpServer({ message: 'Internal error', data: { details: 'mcp-client(github): initial connection failed' } }, servers), servers[1])
  assert.equal(failingMcpServer(new Error('Invalid params: mcpServers[0].command must be an absolute path'), servers), servers[0])
  assert.equal(failingMcpServer(new Error('session is not resumable'), servers), null)
  assert.equal(failingMcpServer(new Error('mcp-client(other): failed'), servers), null)
})

test('the app hears once about what was saved, replaced and sent, including what comes in after the turn', (t) => {
  let clock = 1000
  const { memoryDb, personal } = setup(t, { now: () => clock })
  const old = memoryDb.addMemory({ text: '张三是直属上级', source: 'agent' }).memory
  memoryDb.claimChanges(0, 'conv-0')
  clock = 5000
  memoryDb.addMemory({ text: '周报每周五交给张三', source: 'agent' })
  memoryDb.logInjection({ sessionId: 's-1', turn: 3, fixed: 'first', pushed: [{ text: '回答先给结论', names: ['结论'] }] })
  memoryDb.logInjection({ sessionId: 's-2', turn: 1, fixed: 'first', pushed: [] })

  const report = personal.collect({ conversationId: 'conv-1', sessionId: 's-1' })
  assert.deepEqual(report.memories, ['周报每周五交给张三'])
  assert.deepEqual(report.injected.map((entry) => [entry.turn, entry.fixed, entry.pushed[0].text]), [[3, 'first', '回答先给结论']])
  clock = 6000
  assert.equal(personal.collect({ conversationId: 'conv-1', sessionId: 's-1' }), null, 'nothing new, nothing to tell')

  clock = 8000
  memoryDb.applyExtraction({ add: [{ text: '直属上级是李四', replaces: old.id }], invalidate: [], shown: new Set([old.id]) })
  const late = personal.collect({ conversationId: 'conv-1', sessionId: 's-1' })
  assert.deepEqual([late.memories, late.invalidated], [['直属上级是李四'], ['张三是直属上级']])
})

test('memory counts as working only when the plugin started inside the current dsh', (t) => {
  let clock = 1000
  const { memoryDb, personal } = setup(t, { now: () => clock })
  memoryDb.markPluginStarted()

  assert.equal(personal.mcpStatus(null, 0).memory, false, 'no dsh launched')
  assert.equal(personal.mcpStatus(null, 2000).memory, false, 'started before this launch')
  clock = 2500
  memoryDb.markPluginStarted()
  assert.equal(personal.mcpStatus(null, 2000).memory, true)
})

test('habits read from the history reach the plugin through memory.db', (t) => {
  const { memoryDb, personal } = setup(t)
  assert.deepEqual(personal.habits(), { text: '', samples: 0 })
  assert.equal(memoryDb.habits(), '')
})
