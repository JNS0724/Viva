import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { APP_PLUGINS, CONTRACTS, installedDshVersion, PERSONA, resolvePlugins, ROUTING_PERSONA } from '../src/backend/app-plugins.ts'
import { openMemoryStore } from '../src/memory/node/memory-store.ts'
import { MEMORY_CONTRACT } from '../src/memory/contracts/memory-contract.ts'
import { ROOT } from './fixtures/dsh-harness.ts'
import appPackage from '../package.json' with { type: 'json' }

/** The app's plugin list: what it puts in the profile, and what it leaves out and why. */
function tempDir(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-plugins-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakePlugin(root: string, manifest: object) {
  const dir = path.join(root, 'plugins', 'memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

const memoryOnly = [APP_PLUGINS.find((plugin) => plugin.name === 'viva-memory')!]

test('the plugins shipped with the app all pass, each with its data file under userData', () => {
  const { plugins, problems } = resolvePlugins({ codeRoot: ROOT, userData: '/data', dshVersion: installedDshVersion(ROOT) })
  assert.deepEqual(problems, [])
  assert.deepEqual(plugins.map((plugin) => [plugin.name, plugin.config]), [
    ['viva-tasks', {}],
    ['viva-history', {}],
    ['viva-routing', { ...ROUTING_PERSONA }],
    ['viva-memory', { host: true, dataRoot: path.join('/data', 'memory'), diagnosticsRoot: path.join('/data', 'diagnostics'), diagnosticsVersion: appPackage.version }],
    ['viva-trace', { file: path.join('/data', 'trace.db') }],
    ['viva-questions', {}],
    ['viva-config', {}],
    ['viva-steer', {}],
    ['viva-fork', {}],
    ['viva-plugins', {}],
    ['viva-mcp', {}],
    ['viva-permission', { preset: 'workspace-write' }],
  ])
  assert.deepEqual(plugins.find((plugin) => plugin.name === 'viva-questions')!.stock!.map((entry) => entry.name), ['@deepseek-ai/dsh-tool-ask-user'])
  // The level the user picked goes to viva-permission, with dsh's Auto review loaded for 自动.
  const auto = resolvePlugins({ codeRoot: ROOT, userData: '/data', dshVersion: installedDshVersion(ROOT), permission: 'auto' })
  const permission = auto.plugins.find((plugin) => plugin.name === 'viva-permission')!
  assert.deepEqual(permission.config, { preset: 'auto' })
  assert.deepEqual(permission.stock!.map((entry) => entry.name), ['@deepseek-ai/dsh-experimental-auto-review'])
  // Tasks and schedules' runs do the work under the profile's persona.
  assert.match(PERSONA.prefix, /个人工作助手/)
  assert.match(PERSONA.prefix, /ask_user_question/, 'the model is told when to ask instead of guessing')
  assert.match(PERSONA.prefix, /memory_remember/, 'and to keep what the user told it')
  assert.doesNotMatch(PERSONA.prefix, /commit_route|【插话】|后台任务都归你管/, 'routing, interjections and reports are the main conversation\'s')
  assert.doesNotMatch(PERSONA.prefix, /coding agent/)
  // The main conversation routes each request (viva-routing gives it this persona instead).
  assert.match(ROUTING_PERSONA.prefix, /个人工作助手/)
  assert.match(ROUTING_PERSONA.prefix, /必须调用一次 commit_route/)
  assert.match(ROUTING_PERSONA.prefix, /第一步直接调用 commit_route/)
  assert.match(ROUTING_PERSONA.prefix, /最多 2 次只读速查/)
  assert.match(ROUTING_PERSONA.prefix, /用户粘贴的图片会自动随任务转交/)
  assert.match(ROUTING_PERSONA.prefix, /【插话】/)
  assert.match(ROUTING_PERSONA.prefix, /必须先用 list_background_tasks/)
  assert.match(ROUTING_PERSONA.prefix, /它们为空不能证明 Viva 没有后台任务/)
  assert.match(ROUTING_PERSONA.prefix, /后台任务都归你管，不论它是在哪个话题里开的/, 'the main conversation owns every task')
  assert.match(ROUTING_PERSONA.prefix, /直接在主会话 reply 回答/, 'allows direct reply when task output already covers the follow-up')
  assert.match(ROUTING_PERSONA.prefix, /先用 get_background_task 分段读完再决定/, 'reads omitted task output slices before deciding')
  assert.match(ROUTING_PERSONA.prefix, /不论你此刻在聊什么，都要把结果反馈给用户/)
  assert.match(ROUTING_PERSONA.prefix, /不能回答没有任务/)
  assert.doesNotMatch(ROUTING_PERSONA.prefix, /ask_user_question|start_background_task/, 'it asks through clarify, hands work over through commit_route')
  assert.equal(ROUTING_PERSONA.suffix, PERSONA.suffix)
})

test('a plugin with another contract version, another dsh, or no manifest is left out with the reason', (t) => {
  const dir = tempDir(t)
  const resolve = (manifest: object | null) => {
    if (manifest) fakePlugin(dir, manifest)
    return resolvePlugins({ codeRoot: dir, userData: '/data', dshVersion: '0.2.0-rc.2', plugins: memoryOnly })
  }
  const ok = { name: 'viva-memory', viva: { contract: { memory: CONTRACTS.memory } }, peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2', zod: '^4.0.0' } }

  assert.match(resolve(null).problems[0].problem, /找不到插件/)
  assert.deepEqual(resolve(ok).problems, [])
  assert.match(resolve({ ...ok, viva: { contract: { memory: 1 } } }).problems[0].problem, new RegExp(`约定 memory 的版本是 1，应用需要 ${CONTRACTS.memory}`))
  assert.match(resolve({ ...ok, viva: undefined }).problems[0].problem, /未声明/)
  assert.match(resolve({ ...ok, peerDependencies: { '@deepseek-ai/dsh-llm': '0.3.0' } }).problems[0].problem, /需要 dsh 0\.3\.0，当前是 0\.2\.0-rc\.2/)
  assert.deepEqual(resolve({ ...ok, peerDependencies: { '@deepseek-ai/cordis': '~4.0.4' } }).problems, [], 'ranges are left to dsh')
  assert.match(resolve({ ...ok, name: 'other' }).problems[0].problem, /插件名是 other/)
})

test('memory.db records its contract version and refuses incompatible databases', (t) => {
  const file = path.join(tempDir(t), 'memory.db')
  openMemoryStore(file).close()
  const raw = new DatabaseSync(file)
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, MEMORY_CONTRACT)
    raw.exec(`PRAGMA user_version = ${MEMORY_CONTRACT + 1}`)
  } finally { raw.close() }
  assert.throws(() => openMemoryStore(file), /incompatible contract version/)
})
