import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { envLookup, expandHome, importDshServers, importSummary, parseShellEnv, readDshMcpServers, resolveExpression, shortPath, userDshHome } from '../src/main/dsh-mcp-import.ts'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-import-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const MCP = "'@deepseek-ai/dsh-mcp-client'"
const lookupOf = (vars) => (name) => vars[name]

/** A dsh home the way dsh writes one: an empty root per profile, servers inserted by the patch layers. */
function dshHome(t) {
  const home = tempDir(t)
  write(path.join(home, 'profiles', 'web', 'cordis.yml'), '# root\n[]\n')
  write(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- insert:',
    '  - id: mcp-github',
    `    name: ${MCP}`,
    '    config:',
    '      serverName: github',
    '      transport: stdio',
    '      command: npx',
    "      args: ['-y', '@modelcontextprotocol/server-github']",
    '      env:',
    '        GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN',
    '        GITHUB_HOST: github.example.com',
    '  - id: mcp-web',
    `    name: ${MCP}`,
    '    config:',
    '      serverName: web',
    '      transport: streamable-http',
    '      url: http://localhost:3000/mcp',
    '      headers:',
    "        Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'",
    '  - id: mcp-off',
    `    name: ${MCP}`,
    '    disabled: true',
    '    config: { serverName: off, transport: stdio, command: node }',
    '  - id: tools',
    "    name: '@deepseek-ai/dsh-tool-fs-search'",
    '    config: {}',
    '',
  ].join('\n'))
  write(path.join(home, 'profiles', 'headless', 'cordis.yml'), [
    '- id: group',
    '  group: true',
    '  config:',
    '    - id: mcp-sentry',
    `      name: ${MCP}`,
    '      config:',
    '        serverName: sentry',
    '        transport: stdio',
    '        command: npx',
    '        args: [-y, "@sentry/mcp-server"]',
    '        env:',
    '          SENTRY_TOKEN: !!js process.env.SENTRY_TOKEN',
    '',
  ].join('\n'))
  return home
}

test('the default dsh home is DSH_HOME, else ~/.dsh', () => {
  assert.equal(userDshHome({ DSH_HOME: '/opt/dsh' }, '/Users/me'), path.resolve('/opt/dsh'))
  assert.equal(userDshHome({}, '/Users/me'), path.join('/Users/me', '.dsh'))
})

test('!!js values: environment variables, literals and templates; anything else is not run', () => {
  const lookup = lookupOf({ TOKEN: 'abc', EMPTY: '' })
  assert.equal(resolveExpression('process.env.TOKEN', lookup), 'abc')
  assert.equal(resolveExpression(" process.env['TOKEN'] ", lookup), 'abc')
  assert.equal(resolveExpression('`Bearer ${process.env.TOKEN}`', lookup), 'Bearer abc')
  assert.equal(resolveExpression("'plain'", lookup), 'plain')
  assert.equal(resolveExpression("process.env.NOPE ?? 'fallback'", lookup), 'fallback')
  assert.equal(resolveExpression("process.env.TOKEN || 'fallback'", lookup), 'abc')
  assert.equal(resolveExpression('process.env.NOPE', lookup), undefined)
  assert.equal(resolveExpression('process.env.EMPTY', lookup), undefined, 'an empty variable is as good as unset')
  assert.equal(resolveExpression('`${process.env.NOPE}`', lookup), undefined)
  assert.equal(resolveExpression('`${require("fs")}`', lookup), undefined)
  assert.equal(resolveExpression('require("child_process").execSync("id")', lookup), undefined)
})

test('servers are read from every profile and patch layer, with keys copied or reported missing', (t) => {
  const home = dshHome(t)
  const { servers, problems } = readDshMcpServers(home, { lookup: lookupOf({ GITHUB_TOKEN: 'ghp_1', MCP_TOKEN: 'm2' }) })
  assert.deepEqual(problems, [])
  assert.deepEqual(servers.map((s) => s.name).sort(), ['github', 'sentry', 'web'], 'disabled entries and other plugins are left out')
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
  assert.deepEqual(byName.github, {
    name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], url: '',
    env: { GITHUB_TOKEN: 'ghp_1', GITHUB_HOST: 'github.example.com' }, headers: {}, missing: [],
  })
  assert.deepEqual(byName.web, {
    name: 'web', type: 'http', command: '', args: [], url: 'http://localhost:3000/mcp', env: {}, headers: { Authorization: 'Bearer m2' }, missing: [],
  })
  assert.deepEqual([byName.sentry.env, byName.sentry.missing], [{}, ['SENTRY_TOKEN']])
})

test('a home-level patch overrides or disables a profile entry by id', (t) => {
  const home = dshHome(t)
  write(path.join(home, 'cordis.patch.yml'), [
    '- id: mcp-github',
    '  config:',
    '    serverName: github',
    '    transport: stdio',
    '    command: /usr/local/bin/github-mcp',
    '- id: mcp-sentry',
    '  disabled: true',
    '',
  ].join('\n'))
  const { servers } = readDshMcpServers(home, { lookup: lookupOf({}) })
  const github = servers.find((s) => s.name === 'github')
  assert.deepEqual([github.command, github.args, github.env], ['/usr/local/bin/github-mcp', [], {}])
  assert.equal(servers.some((s) => s.name === 'sentry'), false)
})

test('an entry Viva cannot take is reported, the rest still come', (t) => {
  const home = tempDir(t)
  write(path.join(home, 'profiles', 'p', 'cordis.patch.yml'), [
    '- insert:',
    `  - name: ${MCP}`,
    '    config: { serverName: dyn, transport: stdio, command: !!js "require(\'os\').homedir()" }',
    `  - name: ${MCP}`,
    '    config: { serverName: 中文, transport: stdio, command: node }',
    `  - name: ${MCP}`,
    '    config: { serverName: sse, transport: sse, url: "http://x" }',
    `  - name: ${MCP}`,
    '    config: { serverName: ok, transport: stdio, command: node, args: [server.js] }',
    '',
  ].join('\n'))
  const { servers, problems } = readDshMcpServers(home, { lookup: lookupOf({}) })
  assert.deepEqual(servers.map((s) => s.name), ['ok'])
  assert.deepEqual(problems.map((p) => p.name), ['dyn', '中文', 'sse'])
  assert.match(problems[0].reason, /启动命令/)
})

test('the same server in two profiles is taken once', (t) => {
  const home = tempDir(t)
  const entry = ['- insert:', `  - name: ${MCP}`, '    config: { serverName: same, transport: stdio, command: node }', ''].join('\n')
  write(path.join(home, 'profiles', 'a', 'cordis.patch.yml'), entry)
  write(path.join(home, 'profiles', 'b', 'cordis.patch.yml'), entry)
  assert.deepEqual(readDshMcpServers(home, { lookup: lookupOf({}) }).servers.map((s) => s.name), ['same'])
})

test('a folder that is not a dsh home says so; one without MCP servers lists none', (t) => {
  const dir = tempDir(t)
  assert.throws(() => readDshMcpServers(path.join(dir, 'nope'), { lookup: lookupOf({}) }), /找不到/)
  assert.throws(() => readDshMcpServers(dir, { lookup: lookupOf({}) }), /不像 dsh 的文件夹/)
  write(path.join(dir, 'profiles', 'web', 'cordis.yml'), '[]\n')
  assert.deepEqual(readDshMcpServers(dir, { lookup: lookupOf({}) }), { servers: [], problems: [] })
})

test('a patch file dsh could not load either is reported, not thrown', (t) => {
  const home = tempDir(t)
  write(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), '- insert: [\n')
  const { servers, problems } = readDshMcpServers(home, { lookup: lookupOf({}) })
  assert.deepEqual(servers, [])
  assert.match(problems[0].reason, /读不懂/)
})

test("variables come from the terminal's environment first, then the app's, then dsh's .env", (t) => {
  const home = tempDir(t)
  write(path.join(home, '.env'), 'FROM_FILE=file\nBOTH=file\n# comment\nQUOTED="q v"\n')
  const lookup = envLookup({ dshHome: home, shellEnv: { BOTH: 'shell', SHELL_ONLY: 's' }, processEnv: { BOTH: 'app', APP_ONLY: 'a' } })
  assert.deepEqual(['FROM_FILE', 'BOTH', 'SHELL_ONLY', 'APP_ONLY', 'QUOTED', 'NONE'].map(lookup), ['file', 'shell', 's', 'a', 'q v', undefined])
  assert.equal(envLookup({ dshHome: path.join(home, 'none'), shellEnv: {}, processEnv: {} })('X'), undefined, 'no .env is fine')
})

test('importing adds the new servers at once, skips names in use, and keeps keys out of the summary', async (t) => {
  const home = dshHome(t)
  const added = []
  const store = { addMany: (configs) => added.push(...configs) }
  const result = await importDshServers({
    dir: home, store, takenNames: () => ['memory', 'Web'],
    shellEnv: async () => ({ GITHUB_TOKEN: 'ghp_shell' }), processEnv: {},
  })
  assert.deepEqual(added.map((s) => [s.name, s.env]), [['sentry', {}], ['github', { GITHUB_TOKEN: 'ghp_shell', GITHUB_HOST: 'github.example.com' }]], 'profiles in name order')
  assert.deepEqual(result, {
    dir: home, added: [{ name: 'sentry', missing: ['SENTRY_TOKEN'] }, { name: 'github', missing: [] }], skipped: ['web'], problems: [],
  })

  const forUser = importSummary(result, { home: path.dirname(home) })
  assert.equal(forUser, `已从 ${path.join('~', path.basename(home))} 导入 2 个：sentry、github。跳过 1 个重名的（web）。sentry 还缺 SENTRY_TOKEN，点「编辑」补上就能连接。`)
  const forModel = importSummary(result, { home: path.dirname(home), forModel: true })
  assert.match(forModel, /这一轮结束后生效/)
  assert.match(forModel, /设置 → 扩展/)
  assert.equal([forUser, forModel].some((text) => text.includes('ghp_shell')), false)
})

test('an import with nothing new says so, and what could not be taken', () => {
  assert.equal(importSummary({ dir: '/d', added: [], skipped: [], problems: [] }, { home: '/Users/me' }), '在 /d 里没有找到 MCP 服务器。')
  assert.equal(importSummary({ dir: '/d', added: [], skipped: ['a'], problems: [{ name: 'b', reason: '不支持的连接方式：sse' }] }, { home: '/' }),
    '没有新的服务器可以导入。跳过 1 个重名的（a）。没能导入：b（不支持的连接方式：sse）。')
  assert.equal(shortPath(path.join('/Users/me', '.dsh'), '/Users/me'), path.join('~', '.dsh'))
  assert.equal(shortPath('/opt/dsh', '/Users/me'), '/opt/dsh')
  assert.equal(expandHome('~/work/.dsh', '/Users/me'), path.resolve('/Users/me/work/.dsh'))
  assert.equal(expandHome('~', '/Users/me'), path.resolve('/Users/me'))
  assert.equal(expandHome('/opt/dsh', '/Users/me'), path.resolve('/opt/dsh'))
})

test("the login shell's environment is read from env -0 output", () => {
  assert.deepEqual(parseShellEnv('A=1\0B=x=y\0MULTI=l1\nl2\0\0'), { A: '1', B: 'x=y', MULTI: 'l1\nl2' })
})
