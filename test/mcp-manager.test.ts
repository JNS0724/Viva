import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { apply, stateOf } from '../plugins/mcp/index.ts'
import { appToMcpOf, mcpToAppOf, type McpServerEntry } from '../src/shared/mcp-channel.ts'
import { createMcpDesk, statusOf } from '../src/backend/mcp-desk.ts'
import { toManagerServers, type ServerConfig } from '../src/backend/mcp-config.ts'
import { serverStanding, statusOf as liveStatus } from '../src/renderer/capabilities-state.ts'

/** The user's MCP servers through viva-mcp and dsh's MCP manager (plugins/mcp, mcp-desk.ts), in place of each session's own. */

const MAIL: McpServerEntry = { name: 'mail', entry: { transport: 'stdio', command: '/bin/mail-mcp', args: ['--x'], env: { MAIL_KEY: 'k' } } }
const DOCS: McpServerEntry = { name: 'docs', entry: { transport: 'streamable-http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } } }

test('the channel takes only well-formed messages, each way', () => {
  assert.deepEqual(appToMcpOf({ type: 'mcp_servers', version: 1, servers: [MAIL, DOCS] }), { type: 'mcp_servers', version: 1, servers: [MAIL, DOCS] })
  assert.deepEqual(appToMcpOf({ type: 'mcp_restart', version: 1, name: 'mail' }), { type: 'mcp_restart', version: 1, name: 'mail' })
  for (const bad of [null, { type: 'mcp_servers', version: 2, servers: [] }, { type: 'mcp_servers', version: 1, servers: [{ name: 'a b', entry: MAIL.entry }] },
    { type: 'mcp_servers', version: 1, servers: [{ name: 'x', entry: { transport: 'sse', url: 'u' } }] },
    { type: 'mcp_servers', version: 1, servers: [{ name: 'x', entry: { transport: 'stdio', command: '', args: [], env: {} } }] },
    { type: 'mcp_restart', version: 1, name: '../x' }]) assert.equal(appToMcpOf(bad), null)
  assert.deepEqual(mcpToAppOf({ type: 'mcp_ready', version: 1 }), { type: 'mcp_ready', version: 1 })
  assert.deepEqual(mcpToAppOf({ type: 'mcp_status', version: 1, servers: [{ name: 'mail', state: 'connected', error: 3, tools: -1 }] }),
    { type: 'mcp_status', version: 1, servers: [{ name: 'mail', state: 'connected', error: '', tools: 0 }] })
  assert.equal(mcpToAppOf({ type: 'mcp_status', version: 1, servers: [{ name: 'mail', state: 'asleep' }] }), null)
})

test('the configured servers become manager entries; a command not found is left out and said so', () => {
  const config = (over: Partial<ServerConfig>): ServerConfig => ({ name: 'x', type: 'stdio', command: 'x', args: [], url: '', env: {}, headers: {}, missing: [], ...over })
  const { servers, missing } = toManagerServers([
    config({ name: 'mail', command: 'mail-mcp', args: ['--x'], env: { MAIL_KEY: 'k' } }),
    config({ name: 'docs', type: 'http', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer t' } }),
    config({ name: 'gone', command: 'nowhere' }),
  ], { resolve: (command) => (command === 'mail-mcp' ? '/bin/mail-mcp' : null) })
  assert.deepEqual(servers, [MAIL, DOCS])
  assert.deepEqual(missing.map((item) => item.name), ['gone'])
})

test('the app side: servers go when the plugin starts and on a change, restarts go by name, how they stand comes back grouped', () => {
  const sent: object[] = []
  const heard: object[] = []
  let servers = [MAIL]
  const desk = createMcpDesk({ send: (message) => sent.push(message), servers: () => servers, onStatus: (status) => heard.push(status) })
  desk.receive({ type: 'mcp_ready', version: 1 })
  servers = [MAIL, DOCS]
  desk.push()
  desk.restart('mail')
  assert.deepEqual(sent, [{ type: 'mcp_servers', version: 1, servers: [MAIL] }, { type: 'mcp_servers', version: 1, servers: [MAIL, DOCS] }, { type: 'mcp_restart', version: 1, name: 'mail' }])
  desk.receive({ type: 'mcp_status', version: 1, servers: [
    { name: 'mail', state: 'connected', error: '', tools: 2 }, { name: 'docs', state: 'connecting', error: '', tools: 0 },
    { name: 'old', state: 'failed', error: 'gave up', tools: 0 }, { name: 'off', state: 'off', error: '', tools: 0 },
  ] })
  desk.receive({ type: 'something_else' })
  assert.deepEqual(heard, [{ active: ['mail'], connecting: [{ name: 'docs', reason: '' }], dropped: [{ name: 'old', reason: 'gave up' }] }])
  assert.deepEqual(desk.status(), heard[0])
  assert.deepEqual(statusOf([]), { active: [], connecting: [], dropped: [] })
})

/** dsh's MCP manager as the plugin uses it: register (with a release), list, restart, and its status event. */
function fakeManager() {
  const live = new Map<string, unknown>()
  const listeners: Array<(name: string) => void> = []
  const disposers: Array<() => void> = []
  const calls: string[] = []
  const manager = {
    register: (name: string, entry: unknown) => {
      if (name === 'taken') throw new Error('name taken by a configured server')
      calls.push(`register ${name}`)
      live.set(name, entry)
      return () => { calls.push(`release ${name}`); live.delete(name) }
    },
    list: () => [...live.keys()].map((name) => ({ name, configured: true, status: { state: 'connecting', attempt: 0 } })),
    restart: async (name: string) => { calls.push(`restart ${name}`) },
  }
  const ctx = {
    mcpManager: manager,
    on: (event: string, listener: (name: string) => void) => { if (event === 'mcp-manager/status') listeners.push(listener) },
    effect: (setup: () => () => void) => { disposers.push(setup()) },
  }
  return { ctx: ctx as unknown as Context, calls, live, emitStatus: (name: string) => listeners.forEach((listener) => listener(name)), dispose: () => disposers.forEach((dispose) => dispose()) }
}

function plugin() {
  const port = Object.assign(new EventEmitter(), { sent: [] as Array<Record<string, any>>, connected: true })
  const send = (message: Record<string, any>, done?: () => void) => { port.sent.push(message); done?.() }
  const manager = fakeManager()
  apply(manager.ctx, {}, Object.assign(port, { send }) as unknown as NodeJS.Process)
  return { ...manager, port, tell: (message: object) => port.emit('message', message) }
}

test('the plugin registers the set it is sent, takes back what went or changed, and keeps what did not change', () => {
  const { calls, live, port, tell } = plugin()
  assert.deepEqual(port.sent[0], { type: 'mcp_ready', version: 1 })
  tell({ type: 'mcp_servers', version: 1, servers: [MAIL, DOCS] })
  assert.deepEqual(calls, ['register mail', 'register docs'])
  tell({ type: 'mcp_servers', version: 1, servers: [MAIL, { ...DOCS, entry: { ...DOCS.entry, url: 'https://mcp.example/v2' } }] })
  assert.deepEqual(calls.slice(2), ['release docs', 'register docs'], 'a changed server is registered again; the unchanged one stays')
  tell({ type: 'mcp_servers', version: 1, servers: [] })
  assert.deepEqual(calls.slice(4), ['release mail', 'release docs'])
  assert.equal(live.size, 0)
  assert.deepEqual(port.sent.at(-1), { type: 'mcp_status', version: 1, servers: [] })
})

test('the plugin says how each stands, names one the manager refused, restarts only its own, and lets all go when unloaded', () => {
  const { calls, live, port, tell, emitStatus, dispose } = plugin()
  tell({ type: 'mcp_servers', version: 1, servers: [MAIL, { ...DOCS, name: 'taken' }] })
  assert.deepEqual(port.sent.at(-1), { type: 'mcp_status', version: 1, servers: [
    { name: 'mail', state: 'connecting', error: '', tools: 0 },
    { name: 'taken', state: 'failed', error: 'name taken by a configured server', tools: 0 },
  ] })
  const before = port.sent.length
  emitStatus('someone-else')
  emitStatus('mail')
  assert.equal(port.sent.length, before + 1, 'a status of its own server is told; another plugin\'s is not')
  tell({ type: 'mcp_restart', version: 1, name: 'mail' })
  tell({ type: 'mcp_restart', version: 1, name: 'docs' })
  assert.ok(calls.includes('restart mail') && !calls.includes('restart docs'))
  dispose()
  assert.equal(live.size, 0)
})

test('manager states read as the window needs them', () => {
  assert.deepEqual(stateOf({ state: 'connected', toolCount: 3, connectedAt: 1 }), { state: 'connected', error: '', tools: 3 })
  assert.deepEqual(stateOf({ state: 'reconnecting', attempt: 2, maxAttempts: 10, nextRetryAtMs: 5, lastError: 'timed out' }), { state: 'reconnecting', error: 'timed out', tools: 0 })
  assert.deepEqual(stateOf({ state: 'failed', reason: 'gave-up', lastError: 'refused' }), { state: 'failed', error: 'refused', tools: 0 })
  assert.deepEqual(stateOf({ state: 'disabled' }), { state: 'off', error: '', tools: 0 })
})

test('the page shows how a server stands now: what it read when it opened, brought up to date as viva-mcp says', () => {
  const server = { name: 'docs', type: 'http', command: '', args: [], url: 'u', envNames: [], headerNames: [], missingNames: [] }
  const read = { active: [], dropped: [{ name: 'docs', reason: 'old failure' }, { name: 'gone', reason: '命令找不到' }] }
  const state = (mcp: unknown) => ({ extensions: { status: read }, info: { mcp } }) as unknown as State
  assert.deepEqual(serverStanding(server, liveStatus(state(undefined))), { kind: 'dropped', reason: 'old failure' })
  const now = liveStatus(state({ active: [], connecting: [{ name: 'docs', reason: 'timed out' }], dropped: [] }))
  assert.deepEqual(serverStanding(server, now), { kind: 'connecting', reason: 'timed out' })
  assert.deepEqual(now.dropped, [{ name: 'gone', reason: '命令找不到' }], 'a server viva-mcp never had keeps what the page read')
  assert.deepEqual(serverStanding(server, liveStatus(state({ active: ['docs'], connecting: [], dropped: [] }))), { kind: 'connected' })
})
