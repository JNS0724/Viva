import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerExtensionsIpc } from '../src/main/extensions-ipc.ts'
import { createMcpConfigStore, editServer, parseServerInput, resolveCommand, serverView, toAcpServers, validateServer } from '../src/main/mcp-config.ts'
import { createSkill, importSkill, listSkills, parseFrontmatter, removeSkill, skillRoots } from '../src/main/skills.ts'

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
    env: { GITHUB_TOKEN: 'ghp_example' }, headers: {}, missing: [],
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

test('a whole server is checked the same way however it was made', () => {
  const base = { name: 'gh', type: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, missing: [] }
  assert.deepEqual(validateServer({ ...base, env: { A: '1' }, missing: ['B', 'B'] }, []).missing, ['B'])
  assert.throws(() => validateServer({ ...base, env: { A: '1' }, missing: ['A'] }, []), /重复/)
  assert.throws(() => validateServer({ ...base, missing: ['bad name'] }, []), /名称不合法/)
  assert.throws(() => validateServer({ ...base, type: 'http', url: 'https://x.example', headers: { 'X-A': 'a\nb' } }, []), /一行/)
  assert.equal(validateServer({ ...base, type: 'http', url: 'https://x.example', env: { A: '1' } }, []).env.A, undefined, 'only the fields of its type are kept')
})

test('an edit keeps saved keys unless typed again, and lists the ones still without a value', () => {
  const current = { name: 'sentry', type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp-server'], url: '', env: { SENTRY_HOST: 'h' }, headers: {}, missing: ['SENTRY_TOKEN'] }
  const taken = ['memory', 'sentry']

  const unchanged = editServer(current, { keys: [{ name: 'SENTRY_HOST', value: '' }, { name: 'SENTRY_TOKEN', value: '  ' }] }, taken)
  assert.deepEqual([unchanged.env, unchanged.missing], [{ SENTRY_HOST: 'h' }, ['SENTRY_TOKEN']], 'blank keeps what is saved')

  const filled = editServer(current, { args: ['@sentry/mcp-server@2'], keys: [{ name: 'SENTRY_HOST', value: '' }, { name: 'SENTRY_TOKEN', value: 'tok' }] }, taken)
  assert.deepEqual([filled.args, filled.env, filled.missing], [['@sentry/mcp-server@2'], { SENTRY_HOST: 'h', SENTRY_TOKEN: 'tok' }, []])

  const dropped = editServer(current, { keys: [{ name: 'SENTRY_TOKEN', value: 'tok' }, { name: 'EXTRA', value: '' }] }, taken)
  assert.deepEqual([dropped.env, dropped.missing], [{ SENTRY_TOKEN: 'tok' }, ['EXTRA']], 'a key left off the list is removed; a new one without a value is missing')

  const renamed = editServer(current, { name: 'sentry2' }, taken)
  assert.deepEqual([renamed.name, renamed.env, renamed.missing], ['sentry2', { SENTRY_HOST: 'h' }, ['SENTRY_TOKEN']], 'no keys given: all kept')
  assert.throws(() => editServer(current, { name: 'Memory' }, taken), /已经有名为/)
  assert.equal(editServer(current, { name: 'Sentry' }, taken).name, 'Sentry', 'its own name is not taken')

  const fromCard = editServer(current, { values: { SENTRY_TOKEN: 'card' } }, taken)
  assert.deepEqual([fromCard.env, fromCard.missing], [{ SENTRY_HOST: 'h', SENTRY_TOKEN: 'card' }, []])

  assert.throws(() => editServer(current, { type: 'http', url: 'https://sentry.example/mcp' }, taken), /请求头名称不合法：SENTRY_HOST/)
  const http = editServer({ ...current, env: { TOKEN: 't' }, missing: [] }, { type: 'http', url: 'https://sentry.example/mcp' }, taken)
  assert.deepEqual([http.command, http.args, http.env, http.headers], ['', [], {}, { TOKEN: 't' }], 'keys follow the server to its new type')
  assert.throws(() => editServer(current, { type: 'http' }, taken), /服务器地址/)
  assert.throws(() => editServer({ ...http, headers: { 'X-Host': 'h' } }, { type: 'stdio', command: 'npx' }, taken), /名称不合法/,
    'a header name that is no variable name is refused, not carried over silently')
})

test('the store updates in place, imports at once, and keeps missing names', (t) => {
  const file = path.join(tempDir(t), 'mcp-servers.json')
  const store = createMcpConfigStore({ file, crypto: fakeCrypto() })
  store.add(parseServerInput(STDIO_INPUT, []))
  store.addMany([
    { name: 'web', type: 'http', command: '', args: [], url: 'https://w.example/', env: {}, headers: { Authorization: 'Bearer s' }, missing: [] },
    { name: 'sentry', type: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, missing: ['SENTRY_TOKEN'] },
  ])
  assert.deepEqual(store.list().map((s) => s.name), ['github', 'web', 'sentry'])
  assert.deepEqual(serverView(store.list()[2]).missingNames, ['SENTRY_TOKEN'])
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Bearer s/)

  const [, , sentry] = store.list()
  store.update('sentry', editServer(sentry, { values: { SENTRY_TOKEN: 'tok' } }, ['github', 'web', 'sentry']))
  assert.deepEqual([store.list()[2].env, store.list()[2].missing], [{ SENTRY_TOKEN: 'tok' }, []])
  store.update('web', { ...store.list()[1], name: 'web2' })
  assert.deepEqual(store.list().map((s) => s.name), ['github', 'web2', 'sentry'], 'an edit keeps its place')
  assert.throws(() => store.update('nope', store.list()[0]), /没有名为/)

  const many = Array.from({ length: 18 }, (_, i) => ({ name: `s${i}`, type: 'stdio', command: 'node', args: [], url: '', env: {}, headers: {}, missing: [] }))
  assert.throws(() => store.addMany(many), /最多添加/)
  assert.equal(store.list().length, 3, 'an import past the limit adds none')
})

test('frontmatter: plain, quoted and folded values', () => {
  assert.deepEqual(parseFrontmatter('---\nname: weekly\ndescription: "写周报"\n---\nbody'), { name: 'weekly', description: '写周报' })
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: >\n  第一行\n  第二行\nmetadata: {}\n---'), { name: 'x', description: '第一行 第二行' })
  assert.equal(parseFrontmatter('# no frontmatter'), null)
})

test('skills are listed from every root, with the reason dsh would skip a broken one', (t) => {
  const dir = tempDir(t)
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws') })
  assert.deepEqual(roots.map((root) => root.id), ['user', 'workspace', 'workspace-agents'], "the user's ~/.agents is not the app's")
  writeSkill(roots[0].dir, 'weekly', 'name: weekly\ndescription: 按团队模板写周报')
  writeSkill(roots[0].dir, '.system', 'name: hidden\ndescription: x')
  writeSkill(roots[1].dir, 'broken', 'name: broken')
  fs.mkdirSync(roots[2].dir, { recursive: true })
  fs.writeFileSync(path.join(roots[2].dir, 'flat.md'), '---\nname: flat\ndescription: 单文件 skill\n---')
  fs.writeFileSync(path.join(roots[2].dir, 'notes.txt'), 'not a skill')

  assert.deepEqual(listSkills(roots).map((s) => [s.name, s.root, s.managed, s.problem]), [
    ['weekly', 'user', true, ''],
    ['broken', 'workspace', false, '缺少 name 或 description'],
    ['flat', 'workspace-agents', false, ''],
  ])
})

test('a skill made in the conversation is written so dsh can read it, and never over another', (t) => {
  const dir = tempDir(t)
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws') })
  assert.equal(createSkill({ name: 'weekly-report', description: '按团队模板写周报："先结论"', instructions: '1. 先写结论\n2. 再列进展' }, roots[0].dir), 'weekly-report')
  const [skill] = listSkills(roots)
  assert.deepEqual([skill.name, skill.description, skill.problem], ['weekly-report', '按团队模板写周报：”先结论”', ''])
  assert.match(fs.readFileSync(path.join(roots[0].dir, 'weekly-report', 'SKILL.md'), 'utf8'), /\n---\n\n1\. 先写结论\n2\. 再列进展\n$/)
  assert.throws(() => createSkill({ name: 'weekly-report', description: 'x', instructions: 'y' }, roots[0].dir), /已经有/)
})

test('importing copies into the user root; removing goes to the trash, only there', async (t) => {
  const dir = tempDir(t)
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws') })
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
  writeSkill(roots[1].dir, 'team', 'name: team\ndescription: x')
  await assert.rejects(removeSkill('workspace:team', roots, async () => {}), /不在本应用管理的目录里/)
})

/** The extensions IPC over a real store in a temp folder, with what it would ask of the app recorded. */
function extensionsIpc(t, { chosen = null, defaultDir = '/home/me/.dsh', lastDir = '' } = {}) {
  const dir = tempDir(t)
  const store = createMcpConfigStore({ file: path.join(dir, 'mcp.json'), crypto: fakeCrypto() })
  store.add(parseServerInput(STDIO_INPUT, []))
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws') })
  const handlers = new Map()
  const seen = { applied: 0, imported: [], remembered: [] }
  registerExtensionsIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    store,
    roots: () => roots,
    mcpStatus: () => ({ active: ['github'], memory: true, dropped: [] }),
    applyMcp: async () => ({ mode: 'live', applied: ++seen.applied }),
    trash: async () => {},
    dshDirs: () => ({ defaultDir, lastDir }),
    chooseDshDir: async () => chosen,
    importDsh: async (from) => {
      seen.imported.push(from)
      return { dir: from, added: [{ name: 'web', missing: ['TOKEN'] }], skipped: ['github'], problems: [] }
    },
    rememberDshDir: (from) => seen.remembered.push(from),
  })
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)
  return { store, roots, handlers, seen, call }
}

test('extensions IPC lists and removes, never returns secrets, and has no way to add by hand', async (t) => {
  const { roots, handlers, call } = extensionsIpc(t)
  const shown = await call('ext:get')
  assert.deepEqual([shown.servers.map((s) => s.name), shown.skillDir], [['github'], roots[0].dir])
  assert.equal(JSON.stringify(shown).includes('ghp_example'), false)
  assert.equal((await call('ext:remove-mcp', 'github')).info.applied, 1)
  assert.deepEqual([...handlers.keys()].sort(), ['ext:get', 'ext:import-dsh', 'ext:remove-mcp', 'ext:remove-skill', 'ext:update-mcp'],
    'adding by hand happens in the conversation')
})

test('editing over IPC keeps the key typed before, applies once, and never sends a key back', async (t) => {
  const { store, seen, call } = extensionsIpc(t)
  const edited = await call('ext:update-mcp', 'github', {
    name: 'gh', type: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-github@2\n',
    keys: [{ name: 'GITHUB_TOKEN', value: '' }, { name: 'GITHUB_HOST', value: 'ghe.example' }],
  })
  assert.deepEqual([edited.name, edited.servers.map((s) => s.name), seen.applied], ['gh', ['gh'], 1])
  assert.deepEqual(store.list()[0].env, { GITHUB_TOKEN: 'ghp_example', GITHUB_HOST: 'ghe.example' })
  assert.equal(JSON.stringify(edited).includes('ghp_example'), false)
  await assert.rejects(call('ext:update-mcp', 'nope', {}), /没有名为/)
  await assert.rejects(call('ext:update-mcp', 'gh', { keys: 'GITHUB_TOKEN=x' }), /invalid keys/)
})

test('importing over IPC: from the default, the last or a chosen folder, never one the page names', async (t) => {
  const { seen, call } = extensionsIpc(t, { chosen: '/work/team/.dsh', lastDir: '/old/.dsh' })
  const fromDefault = await call('ext:import-dsh', 'default')
  assert.deepEqual([seen.imported, seen.remembered, fromDefault.info.applied], [['/home/me/.dsh'], [], 1])
  assert.match(fromDefault.notice, /导入 1 个：web。跳过 1 个重名的（github）。web 还缺 TOKEN/)
  await call('ext:import-dsh', 'last')
  await call('ext:import-dsh', 'choose')
  assert.deepEqual(seen.imported.slice(1), ['/old/.dsh', '/work/team/.dsh'])
  assert.deepEqual(seen.remembered, ['/old/.dsh', '/work/team/.dsh'], 'a folder other than the default is remembered')
  assert.deepEqual((await call('ext:get')).dsh.lastLabel, '/old/.dsh')
})

test('a cancelled folder dialog imports nothing', async (t) => {
  const { seen, call } = extensionsIpc(t, { chosen: null })
  const result = await call('ext:import-dsh', 'choose')
  assert.deepEqual([result.cancelled, seen.imported, seen.applied], [true, [], 0])
})
