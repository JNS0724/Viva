import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpSources, readClientServers, scanMcp } from '../src/backend/mcp-import.ts'

/** MCP servers brought in from other clients' settings (mcp-import.ts): found, read, checked by Viva's own rules. */

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-import-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return { dir, write }
}

const lookup = (env: Record<string, string>) => (name: string) => env[name]
const commands = new Set(['npx', 'node', 'uvx'])
const findCommand = (command: string) => (commands.has(command) ? `/usr/bin/${command}` : null)

test('the clients found on this computer with servers in them, where each keeps them', (t) => {
  const { dir, write } = setup(t)
  write('home/.cursor/mcp.json', { mcpServers: { linear: { url: 'https://mcp.linear.app/mcp' } } })
  write('home/.claude.json', { mcpServers: { a: { command: 'npx' }, b: { command: 'node' } }, projects: {} })
  write('home/Library/Application Support/Claude/claude_desktop_config.json', { mcpServers: {} })
  const sources = mcpSources({ home: path.join(dir, 'home'), platform: 'darwin', appData: '' })
  assert.deepEqual(sources.map((source) => [source.id, source.count]), [['claude-code', 2], ['cursor', 1]], 'one with none is not offered')
  const windows = mcpSources({ home: path.join(dir, 'home'), platform: 'win32', appData: path.join(dir, 'roaming') })
  assert.ok(!windows.some((source) => source.id === 'claude-desktop'), 'on Windows Claude Desktop keeps them under AppData')
})

test('a file that is not JSON, or has no servers, gives none rather than failing', (t) => {
  const { dir, write } = setup(t)
  write('bad.json', '{ not json')
  write('none.json', { other: 1 })
  assert.deepEqual([readClientServers(path.join(dir, 'bad.json')), readClientServers(path.join(dir, 'none.json')), readClientServers(path.join(dir, 'missing.json'))], [[], [], []])
})

test('each server read and checked: as it is, its keys from the login shell, renamed, or refused with why', () => {
  const entries = [
    { entry: 'github', value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_example' } } },
    { entry: 'postgres', value: { command: 'uvx', args: ['mcp-postgres'], env: { PG_URL: '${PG_URL}', PG_ROLE: '${env:PG_ROLE}' } } },
    { entry: 'linear', value: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_KEY}' } } },
    { entry: 'old search', value: { type: 'sse', url: 'https://search.example/sse' } },
    { entry: 'figma', value: { command: 'figma-mcp' } },
    { entry: 'demo', value: { command: 'node', args: ['demo.js'] } },
    { entry: 'Odd Name!', value: { command: 'node' } },
  ]
  const found = scanMcp(entries, { taken: ['demo'], lookup: lookup({ PG_URL: 'postgres://db' }), findCommand })
  const row = (entry: string) => found.find((candidate) => candidate.entry === entry)!
  assert.deepEqual([row('github').status, row('github').why, row('github').config?.env, row('github').config?.command], ['ready', 'ready', { GITHUB_TOKEN: 'ghp_example' }, '/usr/bin/npx'])
  assert.deepEqual([row('postgres').status, row('postgres').why, row('postgres').config?.env, row('postgres').config?.missing], ['ready', 'missing', { PG_URL: 'postgres://db' }, ['PG_ROLE']],
    'a key the shell has is taken; one it has not is kept by name, to fill in later')
  assert.deepEqual([row('linear').config?.type, row('linear').config?.missing], ['http', ['Authorization']])
  assert.deepEqual([row('old search').status, row('old search').why], ['blocked', 'sse'])
  assert.deepEqual([row('figma').status, row('figma').why], ['blocked', 'command'])
  assert.deepEqual([row('demo').status, row('demo').why, row('demo').name, row('demo').picked], ['fixable', 'taken', 'demo-2', false])
  assert.deepEqual([row('Odd Name!').status, row('Odd Name!').why, row('Odd Name!').name, row('Odd Name!').picked], ['fixable', 'name', 'Odd-Name', true])
  assert.equal(JSON.stringify(found.map((candidate) => candidate.config?.name)).includes('Odd Name!'), false)
})

test('a variable outside the keys (in the address, the command or its arguments) is refused, found or not: only keys are kept encrypted', () => {
  const entries = [
    { entry: 'url', value: { type: 'http', url: 'https://api.example/mcp?token=${TOKEN}' } },
    { entry: 'arg', value: { command: 'npx', args: ['--token', '${TOKEN}'] } },
    { entry: 'cmd', value: { command: '${HOME}/bin/tool' } },
    { entry: 'gone', value: { command: 'npx', args: ['--token', '${NOT_SET}'] } },
  ]
  const found = scanMcp(entries, { taken: [], lookup: lookup({ TOKEN: 'secret', HOME: '/home/me' }), findCommand })
  assert.deepEqual(found.map((candidate) => [candidate.entry, candidate.status, candidate.why, candidate.config]),
    [['url', 'blocked', 'inline-ref', null], ['arg', 'blocked', 'inline-ref', null], ['cmd', 'blocked', 'inline-ref', null], ['gone', 'blocked', 'inline-ref', null]])
  assert.equal(JSON.stringify(found).includes('secret'), false)
})

test('the command is saved as the login shell finds it, so one in a folder only the shell knows still starts', () => {
  const shellOnly = (command: string) => (command === 'my-mcp' ? '/Users/me/.local/share/mise/shims/my-mcp' : null)
  const [found] = scanMcp([{ entry: 'mine', value: { command: 'my-mcp', args: ['serve'] } }], { taken: [], lookup: lookup({}), findCommand: shellOnly })
  assert.deepEqual([found.status, found.config?.command, found.config?.args], ['ready', '/Users/me/.local/share/mise/shims/my-mcp', ['serve']])
})

test('Codex: found where CODEX_HOME says, its TOML read; one switched off there is not ticked, one using what Viva cannot do is refused naming it', (t) => {
  const { dir, write } = setup(t)
  write('codex/config.toml', [
    'model = "gpt-5"',
    '[mcp_servers.github]', 'command = "npx"', 'args = ["-y", "@modelcontextprotocol/server-github"]', 'env_vars = ["GITHUB_TOKEN"]',
    '[mcp_servers.paused]', 'command = "node"', 'enabled = false',
    '[mcp_servers.tools]', 'command = "node"', 'cwd = "/somewhere"',
    '[mcp_servers.docs]', 'url = "https://docs.example/mcp"', 'bearer_token_env_var = "DOCS_TOKEN"',
  ].join('\r\n')) // Windows line ends
  const [codex] = mcpSources({ home: path.join(dir, 'home'), platform: 'darwin', appData: '', codexHome: path.join(dir, 'codex') })
  assert.deepEqual([codex.id, codex.count], ['codex', 4])
  const found = scanMcp(readClientServers(codex.file), { taken: [], lookup: lookup({ GITHUB_TOKEN: 'ghp_example' }), findCommand })
  const row = (entry: string) => found.find((candidate) => candidate.entry === entry)!
  assert.deepEqual([row('github').why, row('github').config?.env, row('github').picked], ['ready', { GITHUB_TOKEN: 'ghp_example' }, true])
  assert.deepEqual([row('paused').status, row('paused').why, row('paused').picked], ['ready', 'off', false])
  assert.deepEqual([row('tools').status, row('tools').why, row('tools').detail], ['blocked', 'unsupported', 'cwd'])
  assert.deepEqual([row('docs').why, row('docs').config?.missing], ['missing', ['Authorization']], 'its token is a key, to be filled in')
  write('codex/config.toml', '[mcp_servers.x\ncommand = 1')
  assert.deepEqual(readClientServers(codex.file), [], 'TOML that cannot be read gives none')
})
