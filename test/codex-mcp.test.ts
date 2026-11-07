import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexServers } from '../src/backend/codex-mcp.ts'

/** Codex's MCP servers (`[mcp_servers.<name>]` in ~/.codex/config.toml) as the other clients write theirs (codex-mcp.ts). */

test('a command server: its keys as written, and those it lets through from the environment named, to be filled in from the login shell', () => {
  const [github] = codexServers({ mcp_servers: { github: {
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { LOG: 'warn' }, env_vars: ['GITHUB_TOKEN', { name: 'GH_HOST' }], startup_timeout_sec: 20,
  } } })
  assert.deepEqual(github, {
    entry: 'github', off: false, unsupported: null,
    value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', GH_HOST: '${GH_HOST}', LOG: 'warn' } },
  })
})

test('an HTTP server: its headers, those read from the environment, and its bearer token, all as keys', () => {
  const [linear] = codexServers({ mcp_servers: { linear: {
    url: 'https://mcp.linear.app/mcp', http_headers: { 'X-Team': 'core' }, env_http_headers: { 'X-Org': 'LINEAR_ORG' }, bearer_token_env_var: 'LINEAR_TOKEN',
  } } })
  assert.deepEqual(linear.value, { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { 'X-Team': 'core', 'X-Org': '${LINEAR_ORG}', Authorization: 'Bearer ${LINEAR_TOKEN}' } })
})

test('one switched off in Codex says so; one using what Viva cannot do says which setting', () => {
  const servers = codexServers({ mcp_servers: {
    paused: { command: 'node', enabled: false },
    tools: { command: 'node', cwd: '/Users/me/tools' },
    remote: { command: 'node', env_vars: [{ name: 'API', source: 'remote' }] },
    helper: { url: 'https://x.example/mcp', http_headers_helper: 'print-headers' },
    literal: { command: 'node', env: { TEMPLATE: 'a ${b} c' } },
  } })
  const row = (entry: string) => servers.find((server) => server.entry === entry)!
  assert.equal(row('paused').off, true)
  assert.deepEqual(['tools', 'remote', 'helper', 'literal'].map((entry) => row(entry).unsupported), ['cwd', 'env_vars', 'http_headers_helper', 'env'],
    'Codex keeps `${…}` in a value as it is; Viva would fill it in, so it is not taken for either')
})

test('a config with no servers, or not a table, has none', () => {
  assert.deepEqual([codexServers({}), codexServers({ mcp_servers: [] }), codexServers(null), codexServers({ mcp_servers: { odd: 'x' } }).map((server) => server.value)], [[], [], [], [{}]])
})
