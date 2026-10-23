import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConfigDesk, parseConfigRequest } from '../src/main/config-channel.ts'

const request = (op, args, extra = {}) => ({ type: 'config', id: 'c1', sessionId: 's1', op, args, ...extra })

function desk({ session = 's1', actions = {} } = {}) {
  const sent = []
  const shown = []
  const done = []
  const all = {
    listServers: () => [],
    prepareServer: () => {},
    addServer: (spec, secrets) => { done.push(['add', spec, secrets]); return `已接入「${spec.name}」` },
    removeServer: (name) => { done.push(['remove', name]); return `已移除「${name}」` },
    importServers: async (path) => { done.push(['import', path]); return `已从 ${path || '~/.dsh'} 导入` },
    prepareUpdate: () => {},
    updateServer: (spec, secrets) => { done.push(['update', spec, secrets]); return `已修改「${spec.name}」` },
    listSkills: () => [],
    createSkill: (spec) => { done.push(['create', spec]); return `已新建「${spec.name}」` },
    installSkill: (path) => `已安装 ${path}`,
    removeSkill: (id) => `已删除 ${id}`,
    ...actions,
  }
  const it = createConfigDesk({ send: (m) => sent.push(m), emit: (e) => shown.push(e), sessionId: () => session, actions: all })
  return { it, sent, shown, done }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('requests are checked: a known operation, the fields it needs, nothing too long', () => {
  assert.deepEqual(parseConfigRequest(request('mcp_add', { name: 'github', command: 'npx', args: ['-y', 'x'], secrets: ['GITHUB_TOKEN'] })), {
    id: 'c1', sessionId: 's1', op: 'mcp_add', args: { name: 'github', command: 'npx', args: ['-y', 'x'], url: '', secrets: ['GITHUB_TOKEN'] },
  })
  assert.match(parseConfigRequest(request('format_disk', {})).problem, /不支持/)
  assert.match(parseConfigRequest(request('mcp_add', { name: 'x', command: 'npx', url: 'https://a.example' })).problem, /二选一/)
  assert.match(parseConfigRequest(request('mcp_add', { name: 'x', command: 'npx', secrets: ['bad name'] })).problem, /密钥名/)
  assert.match(parseConfigRequest(request('skill_create', { name: 'x', description: 'y', instructions: 'z'.repeat(30_000) })).problem, /太长/)
  assert.match(parseConfigRequest(request('skill_create', { name: '周报', description: 'y', instructions: 'z' })).problem, /英文小写/, 'dsh only loads lower-case names')
  assert.equal(parseConfigRequest({ type: 'config' }), null, 'without an id there is nobody to answer')
})

test('a server without keys is added at once and the model is told', async () => {
  const { it, sent, done } = desk()
  it.receive(request('mcp_add', { name: 'files', command: 'npx', args: ['-y', 'fs'] }))
  await settle()
  assert.deepEqual(done, [['add', { name: 'files', command: 'npx', args: ['-y', 'fs'], url: '', secrets: [] }, {}]])
  assert.deepEqual(sent, [{ type: 'config_result', id: 'c1', ok: true, text: '已接入「files」' }])
})

test('keys are asked of the window, never of the model, and only then is the server added', async () => {
  const { it, sent, shown, done } = desk()
  it.receive(request('mcp_add', { name: 'github', command: 'npx', secrets: ['GITHUB_TOKEN'] }))
  await settle()
  assert.deepEqual(shown, [{ type: 'secret_request', requestId: 'c1', server: 'github', names: ['GITHUB_TOKEN'] }])
  assert.deepEqual([sent, done], [[], []], 'nothing happens until the user fills them in')

  assert.throws(() => it.provideSecrets('c1', { GITHUB_TOKEN: 'a\nb' }), /一行/)
  assert.throws(() => it.provideSecrets('c1', {}), /GITHUB_TOKEN/)
  assert.equal(it.provideSecrets('c1', { GITHUB_TOKEN: 'ghp_secret' }), true)
  await settle()
  assert.deepEqual(done[0][2], { GITHUB_TOKEN: 'ghp_secret' })
  assert.deepEqual(sent, [{ type: 'config_result', id: 'c1', ok: true, text: '已接入「github」' }])
  assert.ok(!JSON.stringify(sent).includes('ghp_secret'), 'the key never goes back to dsh')
  assert.equal(it.provideSecrets('c1', { GITHUB_TOKEN: 'again' }), false, 'answered once')
})

test('declining the keys, stopping the turn or leaving the conversation adds nothing', async () => {
  const declined = desk()
  declined.it.receive(request('mcp_add', { name: 'github', command: 'npx', secrets: ['GITHUB_TOKEN'] }))
  await settle()
  declined.it.provideSecrets('c1', null)
  await settle()
  assert.deepEqual(declined.done, [])
  assert.equal(declined.sent[0].ok, false)
  assert.match(declined.sent[0].text, /没有填写/)

  const stopped = desk()
  stopped.it.receive(request('mcp_add', { name: 'github', command: 'npx', secrets: ['GITHUB_TOKEN'] }))
  await settle()
  stopped.it.receive({ type: 'config_closed', id: 'c1' })
  assert.deepEqual(stopped.shown.at(-1), { type: 'secret_closed', requestId: 'c1' })
  assert.equal(stopped.it.provideSecrets('c1', { GITHUB_TOKEN: 'x' }), false)

  const elsewhere = desk({ session: 'other' })
  elsewhere.it.receive(request('mcp_remove', { name: 'github' }))
  await settle()
  assert.deepEqual([elsewhere.done, elsewhere.sent[0].ok], [[], false])
})

test('a bad server is refused before any key is asked for; failures reach the model as text', async () => {
  const { it, sent, shown } = desk({ actions: { prepareServer: () => { throw new Error('名称只能用英文字母、数字、- 和 _') } } })
  it.receive(request('mcp_add', { name: 'github', command: 'npx', secrets: ['GITHUB_TOKEN'] }))
  await settle()
  assert.deepEqual(shown, [])
  assert.deepEqual(sent, [{ type: 'config_result', id: 'c1', ok: false, text: '名称只能用英文字母、数字、- 和 _' }])
})

test('importing from dsh asks nothing of the window: the folder named, or the default', async () => {
  const { it, sent, shown, done } = desk()
  it.receive(request('mcp_import', { path: '~/work/team/.dsh' }))
  it.receive(request('mcp_import', {}, { id: 'c2' }))
  await settle()
  assert.deepEqual(done, [['import', '~/work/team/.dsh'], ['import', '']])
  assert.deepEqual(shown, [])
  assert.deepEqual(sent.map((m) => [m.id, m.ok, m.text]), [['c1', true, '已从 ~/work/team/.dsh 导入'], ['c2', true, '已从 ~/.dsh 导入']])
  assert.match(parseConfigRequest(request('mcp_import', { path: 7 })).problem, /路径要是文字/)
})

test('an update changes only what is named; new keys are typed in the window like when adding', async () => {
  assert.deepEqual(parseConfigRequest(request('mcp_update', { name: 'github', args: ['-y', 'x@2'] })).args,
    { name: 'github', newName: '', command: '', args: ['-y', 'x@2'], url: '', secrets: [] })
  assert.equal(parseConfigRequest(request('mcp_update', { name: 'github' })).args.args, null, 'args left out stay as they are')
  assert.match(parseConfigRequest(request('mcp_update', { name: 'x', command: 'npx', url: 'https://a.example' })).problem, /二选一/)

  const plain = desk()
  plain.it.receive(request('mcp_update', { name: 'github', new_name: 'gh' }))
  await settle()
  assert.deepEqual(plain.done, [['update', { name: 'github', newName: 'gh', command: '', args: null, url: '', secrets: [] }, {}]])

  const keyed = desk()
  keyed.it.receive(request('mcp_update', { name: 'sentry', secrets: ['SENTRY_TOKEN'] }))
  await settle()
  assert.deepEqual(keyed.shown, [{ type: 'secret_request', requestId: 'c1', server: 'sentry', names: ['SENTRY_TOKEN'] }])
  keyed.it.provideSecrets('c1', { SENTRY_TOKEN: 'tok' })
  await settle()
  assert.deepEqual(keyed.done[0][2], { SENTRY_TOKEN: 'tok' })
  assert.ok(!JSON.stringify(keyed.sent).includes('tok'))

  const declined = desk()
  declined.it.receive(request('mcp_update', { name: 'sentry', secrets: ['SENTRY_TOKEN'] }))
  await settle()
  declined.it.provideSecrets('c1', null)
  await settle()
  assert.deepEqual(declined.done, [])
  assert.match(declined.sent[0].text, /没有修改/)
})

test('lists come back as lines the model can read', async () => {
  const { it, sent } = desk({ actions: { listServers: () => ['github（npx -y x）'], listSkills: () => [] } })
  it.receive(request('mcp_list', {}))
  it.receive(request('skill_list', {}, { id: 'c2' }))
  await settle()
  assert.deepEqual(sent.map((m) => [m.id, m.text]), [['c1', '已接入的 MCP 服务器：\n- github（npx -y x）'], ['c2', '用户还没有 skill。']])
})
