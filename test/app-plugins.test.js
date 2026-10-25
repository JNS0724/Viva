import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../plugins/memory/lib/store.ts'
import { APP_PLUGINS, CONTRACTS, installedDshVersion, PERSONA, resolvePlugins } from '../src/main/app-plugins.ts'
import { ROOT } from './fixtures/dsh-harness.js'

/** The app's plugin list: what it puts in the profile, and what it leaves out and why. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-plugins-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakePlugin(root, manifest) {
  const dir = path.join(root, 'plugins', 'memory')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

const memoryOnly = [APP_PLUGINS.find((plugin) => plugin.name === 'viva-memory')]

test('the plugins shipped with the app all pass, each with its data file under userData', () => {
  const { plugins, problems } = resolvePlugins({ codeRoot: ROOT, userData: '/data', dshVersion: installedDshVersion(ROOT) })
  assert.deepEqual(problems, [])
  assert.deepEqual(plugins.map((plugin) => [plugin.name, plugin.config]), [
    ['viva-memory', { file: path.join('/data', 'memory.db') }],
    ['viva-trace', { file: path.join('/data', 'trace.db') }],
    ['viva-policy', {}],
    ['viva-questions', {}],
    ['viva-config', {}],
    ['viva-steer', {}],
    ['viva-fork', {}],
    ['viva-followups', {}],
    ['viva-messages', {}],
    ['viva-permission', { preset: 'workspace-write' }],
  ])
  assert.deepEqual(plugins.find((plugin) => plugin.name === 'viva-questions').stock.map((entry) => entry.name), ['@deepseek-ai/dsh-tool-ask-user'])
  // The level the user picked goes to viva-permission, with dsh's Auto review loaded for 自动.
  const auto = resolvePlugins({ codeRoot: ROOT, userData: '/data', dshVersion: installedDshVersion(ROOT), permission: 'auto' })
  const permission = auto.plugins.find((plugin) => plugin.name === 'viva-permission')
  assert.deepEqual(permission.config, { preset: 'auto' })
  assert.deepEqual(permission.stock.map((entry) => entry.name), ['@deepseek-ai/dsh-experimental-auto-review'])
  assert.match(PERSONA.prefix, /个人工作助手/)
  assert.match(PERSONA.prefix, /ask_user_question/, 'the model is told when to ask instead of guessing')
  assert.match(PERSONA.prefix, /memory_remember/, 'and to keep what the user told it')
  assert.doesNotMatch(PERSONA.prefix, /coding agent/)
})

test('a plugin with another contract version, another dsh, or no manifest is left out with the reason', (t) => {
  const dir = tempDir(t)
  const resolve = (manifest) => {
    if (manifest) fakePlugin(dir, manifest)
    return resolvePlugins({ codeRoot: dir, userData: '/data', dshVersion: '0.2.0-rc.2', plugins: memoryOnly })
  }
  const ok = { name: 'viva-memory', viva: { contract: { memory: CONTRACTS.memory } }, peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.0-rc.2', zod: '^4.0.0' } }

  assert.match(resolve(null).problems[0].problem, /找不到插件/)
  assert.deepEqual(resolve(ok).problems, [])
  assert.match(resolve({ ...ok, viva: { contract: { memory: 2 } } }).problems[0].problem, /约定 memory 的版本是 2，应用需要 1/)
  assert.match(resolve({ ...ok, viva: undefined }).problems[0].problem, /未声明/)
  assert.match(resolve({ ...ok, peerDependencies: { '@deepseek-ai/dsh-llm': '0.3.0' } }).problems[0].problem, /需要 dsh 0\.3\.0，当前是 0\.2\.0-rc\.2/)
  assert.deepEqual(resolve({ ...ok, peerDependencies: { '@deepseek-ai/cordis': '~4.0.4' } }).problems, [], 'ranges are left to dsh')
  assert.match(resolve({ ...ok, name: 'other' }).problems[0].problem, /插件名是 other/)
})

test('memory.db records its contract version and refuses one written by a newer contract', (t) => {
  const file = path.join(tempDir(t), 'memory.db')
  openMemoryDb({ file }).close()
  const raw = new DatabaseSync(file)
  assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'contract_version'").get().value, '1')
  raw.prepare("UPDATE meta SET value = '2' WHERE key = 'contract_version'").run()
  raw.close()
  assert.throws(() => openMemoryDb({ file }), /更新的版本（约定 2）/)
})
