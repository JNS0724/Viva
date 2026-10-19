import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerExtensionsIpc } from '../src/main/extensions-ipc.js'
import { createMcpConfigStore, parseServerInput, resolveCommand, serverView, toAcpServers } from '../src/main/mcp-config.js'
import { importSkill, listSkills, parseFrontmatter, removeSkill, skillRoots } from '../src/main/skills.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extensions-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Stand-in for safeStorage: reversible, and visibly not plain text. */
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().replace(/^enc:/, ''), 'base64').toString(),
})

const STDIO_INPUT = { name: 'github', type: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-github\n', env: 'GITHUB_TOKEN=ghp_example' }

function writeSkill(dir, folder, frontmatter) {
  fs.mkdirSync(path.join(dir, folder), { recursive: true })
  fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n\n正文`)
}

test('MCP server input is parsed from the form and validated', () => {
  assert.deepEqual(parseServerInput(STDIO_INPUT, ['memory']), {
    name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], url: '',
    env: { GITHUB_TOKEN: 'ghp_example' }, headers: {},
  })
  const http = parseServerInput({ name: 'web', type: 'http', url: 'https://mcp.example.com/mcp', headers: 'Authorization=Bearer x' }, [])
  assert.deepEqual([http.url, http.headers], ['https://mcp.example.com/mcp', { Authorization: 'Bearer x' }])

  assert.throws(() => parseServerInput({ ...STDIO_INPUT, name: 'Memory' }, ['memory']), /已经有名为/)
  assert.throws(() => parseServerInput({ ...STDIO_INPUT, name: '中文名' }, []), /只能用英文字母/)
  assert.throws(() => parseServerInput({ ...STDIO_INPUT, env: 'NO_EQUALS' }, []), /名称=值/)
  assert.throws(() => parseServerInput({ ...STDIO_INPUT, env: 'A=1\nA=2' }, []), /重复/)
  assert.throws(() => parseServerInput({ name: 'web', type: 'http', url: 'ftp://x' }, []), /http/)
  assert.throws(() => parseServerInput({ name: 'x', type: 'sse' }, []), /连接方式/)
})

test('commands are found on PATH, with PATHEXT on Windows', () => {
  const files = new Set([path.join('/opt/bin', 'npx'), path.join('C:\\node', 'npx.cmd')])
  const exists = (file) => files.has(file)
  assert.equal(resolveCommand('npx', { env: { PATH: '/usr/bin:/opt/bin' }, platform: 'darwin', exists }), path.join('/opt/bin', 'npx'))
  assert.equal(resolveCommand('npx', { env: { Path: 'C:\\node', PATHEXT: '.EXE;.CMD' }, platform: 'win32', exists }), path.join('C:\\node', 'npx.cmd'))
  assert.equal(resolveCommand('npx', { env: { PATH: '' }, platform: 'darwin', exists, extraDirs: ['/opt/bin'] }), path.join('/opt/bin', 'npx'))
  assert.equal(resolveCommand('nope', { env: { PATH: '/opt/bin' }, platform: 'darwin', exists }), null)
})

test('servers become ACP declarations; one with a missing command is left out and reported', () => {
  const configs = [
    parseServerInput(STDIO_INPUT, []),
    parseServerInput({ name: 'web', type: 'http', url: 'https://mcp.example.com/mcp', headers: 'X-Key=1' }, []),
    parseServerInput({ name: 'typo', type: 'stdio', command: 'nxp' }, []),
  ]
  const { servers, missing } = toAcpServers(configs, { resolve: (command) => (command === 'npx' ? '/opt/bin/npx' : null) })
  assert.deepEqual(servers, [
    { name: 'github', command: '/opt/bin/npx', args: ['-y', '@modelcontextprotocol/server-github'], env: [{ name: 'GITHUB_TOKEN', value: 'ghp_example' }] },
    { type: 'http', name: 'web', url: 'https://mcp.example.com/mcp', headers: [{ name: 'X-Key', value: '1' }] },
  ])
  assert.deepEqual(missing, [{ name: 'typo', reason: '找不到命令：nxp' }])
})

test('the MCP store keeps secrets encrypted and the view shows only their names', (t) => {
  const file = path.join(tempDir(t), 'mcp-servers.json')
  const store = createMcpConfigStore({ file, crypto: fakeCrypto() })
  store.add(parseServerInput(STDIO_INPUT, []))

  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /ghp_example/)
  assert.equal(store.list()[0].env.GITHUB_TOKEN, 'ghp_example')
  assert.deepEqual(serverView(store.list()[0]).envNames, ['GITHUB_TOKEN'])
  assert.equal(JSON.stringify(serverView(store.list()[0])).includes('ghp_example'), false)

  store.remove('github')
  assert.deepEqual(store.list(), [])
  assert.throws(() => store.remove('github'), /没有名为/)
  const locked = createMcpConfigStore({ file, crypto: fakeCrypto(false) })
  assert.throws(() => locked.add(parseServerInput(STDIO_INPUT, [])), /钥匙串不可用/)
  locked.add(parseServerInput({ name: 'plain', type: 'stdio', command: 'node' }, []))
  assert.equal(locked.list()[0].name, 'plain', 'a server without secrets needs no keychain')
})

test('frontmatter: plain, quoted and folded values', () => {
  assert.deepEqual(parseFrontmatter('---\nname: weekly\ndescription: "写周报"\n---\nbody'), { name: 'weekly', description: '写周报' })
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: >\n  第一行\n  第二行\nmetadata: {}\n---'), { name: 'x', description: '第一行 第二行' })
  assert.equal(parseFrontmatter('# no frontmatter'), null)
})

test('skills are listed from every root, with the reason dsh would skip a broken one', (t) => {
  const dir = tempDir(t)
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws'), env: { DSH_AGENTS_HOME: path.join(dir, 'agents') } })
  writeSkill(roots[0].dir, 'weekly', 'name: weekly\ndescription: 按团队模板写周报')
  writeSkill(roots[0].dir, '.system', 'name: hidden\ndescription: x')
  writeSkill(roots[2].dir, 'broken', 'name: broken')
  fs.mkdirSync(roots[1].dir, { recursive: true })
  fs.writeFileSync(path.join(roots[1].dir, 'flat.md'), '---\nname: flat\ndescription: 单文件 skill\n---')
  fs.writeFileSync(path.join(roots[1].dir, 'notes.txt'), 'not a skill')

  assert.deepEqual(listSkills(roots).map((s) => [s.name, s.root, s.managed, s.problem]), [
    ['weekly', 'user', true, ''],
    ['flat', 'agents', false, ''],
    ['broken', 'workspace', false, '缺少 name 或 description'],
  ])
})

test('importing copies into the user root; removing goes to the trash, only there', async (t) => {
  const dir = tempDir(t)
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws'), env: {} })
  const source = path.join(dir, 'downloads')
  writeSkill(source, 'weekly', 'name: weekly\ndescription: 按团队模板写周报')
  writeSkill(source, 'bad', 'name: bad')

  assert.equal(importSkill(path.join(source, 'weekly'), roots[0].dir), 'weekly')
  assert.ok(fs.existsSync(path.join(roots[0].dir, 'weekly', 'SKILL.md')))
  assert.throws(() => importSkill(path.join(source, 'weekly'), roots[0].dir), /已经有/)
  assert.throws(() => importSkill(path.join(source, 'bad'), roots[0].dir), /name 和 description/)
  assert.throws(() => importSkill(source, roots[0].dir), /没有 SKILL.md/)

  const trashed = []
  assert.equal(await removeSkill('user:weekly', roots, async (file) => trashed.push(file)), 'weekly')
  assert.deepEqual(trashed, [path.join(roots[0].dir, 'weekly')])
  writeSkill(roots[2].dir, 'team', 'name: team\ndescription: x')
  await assert.rejects(removeSkill('workspace:team', roots, async () => {}), /不在本应用管理的目录里/)
})

test('extensions IPC applies MCP changes to the session and never returns secrets', async (t) => {
  const dir = tempDir(t)
  const store = createMcpConfigStore({ file: path.join(dir, 'mcp.json'), crypto: fakeCrypto() })
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws'), env: {} })
  const handlers = new Map()
  let applied = 0
  registerExtensionsIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    store,
    roots: () => roots,
    mcpStatus: () => ({ active: ['github'], memory: true, dropped: [] }),
    applyMcp: async () => ({ mode: 'live', applied: ++applied }),
    chooseSkill: async () => null,
    trash: async () => {},
    openPath: async () => '',
  })
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)

  const added = await call('ext:add-mcp', STDIO_INPUT)
  assert.deepEqual([added.servers.map((s) => s.name), added.info.applied, added.skillDir], [['github'], 1, roots[0].dir])
  assert.equal(JSON.stringify(added).includes('ghp_example'), false)
  await assert.rejects(call('ext:add-mcp', STDIO_INPUT), /已经有名为「github」/)
  assert.equal((await call('ext:remove-mcp', 'github')).info.applied, 2)
  assert.equal((await call('ext:import-skill')).imported, null, 'cancelling the picker imports nothing')
  await call('ext:open-skill-dir')
  assert.ok(fs.existsSync(roots[0].dir), 'opening the skill folder creates it first')
})
