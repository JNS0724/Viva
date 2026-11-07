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

test('only settings Viva carries over or can safely leave out are taken: tool lists, another environment and anything unknown are refused by name', () => {
  const servers = codexServers({ mcp_servers: {
    timed: { command: 'node', required: true, startup_timeout_sec: 20, startup_timeout_ms: 500, tool_timeout_sec: 60, supports_parallel_tool_calls: true },
    here: { url: 'https://x.example/mcp', environment_id: 'local' },
    allowed: { command: 'node', enabled_tools: ['read'] },
    denied: { command: 'node', disabled_tools: ['delete'] },
    elsewhere: { url: 'http://127.0.0.1:8000/mcp', environment_id: 'devbox' },
    elsewhereCommand: { command: 'node', environment_id: 'devbox' },
    approval: { command: 'node', default_tools_approval_mode: 'never' },
    oauth: { url: 'https://x.example/mcp', scopes: ['read'] },
  } })
  const row = (entry: string) => servers.find((server) => server.entry === entry)!
  assert.deepEqual(['timed', 'here'].map((entry) => row(entry).unsupported), [null, null], 'timeouts and being required change nothing Viva keeps; the local environment is this computer')
  assert.deepEqual(['allowed', 'denied'].map((entry) => row(entry).unsupported), ['enabled_tools', 'disabled_tools'],
    'Viva has no per-server tool list: taken without it, tools turned off in Codex would be offered')
  assert.deepEqual(['elsewhere', 'elsewhereCommand'].map((entry) => row(entry).unsupported), ['environment_id', 'environment_id'],
    'a server in another environment would be reached, or its command run, on this computer instead')
  assert.deepEqual(['approval', 'oauth'].map((entry) => row(entry).unsupported), ['default_tools_approval_mode', 'scopes'])
})

test('a config with no servers, or not a table, has none', () => {
  assert.deepEqual([codexServers({}), codexServers({ mcp_servers: [] }), codexServers(null), codexServers({ mcp_servers: { odd: 'x' } }).map((server) => server.value)], [[], [], [], [{}]])
})
