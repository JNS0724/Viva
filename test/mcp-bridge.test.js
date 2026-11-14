import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge, failingMcpServer } from '../src/backend/acp-bridge.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createPersonal } from '../src/backend/personal.ts'
import { scratch } from './fixtures/scratch.js'

/** The user's MCP servers through the real bridge and the fake dsh, and what the app reports after a turn. */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_DSH = path.join(ROOT, 'test', 'fixtures', 'fake-dsh.js')
/** Exits at once, so its MCP handshake fails: stands in for a misconfigured user server. */
const BROKEN_SERVER = { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }

function setup(t) {
  const { dir, defer } = scratch(t, 'mcp-bridge-')
  const historyDb = openHistoryDb({ file: path.join(dir, 'history.db') })
  const personal = createPersonal({ historyDb, mcpStore: { list: () => [] } })
  defer(() => historyDb.close())
  return { dir, defer, personal }
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
  assert.deepEqual(personal.mcpStatus(info).dropped, info.mcp.dropped)
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

test('personal context reports habits from the history', (t) => {
  const { personal } = setup(t)
  assert.deepEqual(personal.habits(), { text: '', samples: 0 })
})
