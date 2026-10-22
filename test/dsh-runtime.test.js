import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createAcpBridge } from '../src/main/acp-bridge.ts'
import { adoptDshSessions, adoptDshSkills, projectKey, removeOwnProfiles } from '../src/main/dsh-migrate.ts'
import { CRASH_WINDOW_MS, dshEnv, dshHomeFor, dshRuntime, RESTART_DELAYS_MS, restartDelay } from '../src/main/dsh-runtime.ts'
import { scratch } from './fixtures/scratch.js'

test("dsh gets the user's environment without anything that steers dsh, then what the app sets", () => {
  const base = {
    PATH: '/usr/bin', HOME: '/Users/a', DSH_HOME: '/Users/a/.dsh', dsh_node: '/opt/node', DEEPSEEK_BASE_URL: 'https://gateway.internal',
    DEEPSEEK_API_KEY: 'users-own', ELECTRON_RUN_AS_NODE: '', VIVA_MODEL_KEY_OLD: 'stale', OPENAI_API_KEY: 'kept',
  }
  const env = dshEnv({ base, dshHome: '/data/Viva/dsh', runtime: { electron: true }, settings: { DEEPSEEK_API_KEY: 'app-key' } })
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/Users/a', OPENAI_API_KEY: 'kept',
    DSH_HOME: '/data/Viva/dsh', DSH_AGENTS_HOME: path.join('/data/Viva/dsh', 'agents'), ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: 'app-key',
  })
  assert.equal(dshEnv({ base, dshHome: '/h', runtime: { electron: false }, settings: {} }).ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(dshHomeFor('/data/Viva'), path.join('/data/Viva', 'dsh'))
  assert.deepEqual(dshRuntime({ env: {}, execPath: '/apps/Viva' }), { nodeBin: '/apps/Viva', electron: true })
})

test('a crashed dsh is started again, waiting longer each time, until it keeps crashing', () => {
  const now = 1_000_000
  assert.deepEqual([1, 2, 3].map((n) => restartDelay(Array.from({ length: n }, (_, i) => now - i), now)), RESTART_DELAYS_MS)
  assert.equal(restartDelay([now - 3, now - 2, now - 1, now], now), null)
  assert.equal(restartDelay([now - CRASH_WINDOW_MS - 1, now - CRASH_WINDOW_MS, now], now), RESTART_DELAYS_MS[0], 'old crashes do not count')
})

test('session folders are named the way dsh names them', () => {
  assert.equal(projectKey('/Users/victorlin/Desktop/my-agent/workspace'), '--Users-victorlin-Desktop-my-agent-workspace--')
  assert.equal(projectKey('C:\\Users\\Administrator\\my-agent\\workspace'), '--C-Users-Administrator-my-agent-workspace--')
  assert.equal(projectKey('/工作区/a b'), '--~5DE5~4F5C~533A-a~0020b--')
})

function oldHome(t) {
  const { dir } = scratch(t, 'dsh-migrate-')
  const from = path.join(dir, 'user-dsh')
  const to = path.join(dir, 'Viva', 'dsh')
  const cwd = path.join(dir, 'workspace')
  const session = (home, key, id) => {
    fs.mkdirSync(path.join(home, 'sessions', key, id), { recursive: true })
    fs.writeFileSync(path.join(home, 'sessions', key, id, 'session.v4.jsonl.zstd'), id)
  }
  return { dir, from, to, cwd, session }
}

test("the app's sessions come along once; the user's own stay where they are", (t) => {
  const { from, to, cwd, session } = oldHome(t)
  session(from, projectKey(cwd), 'viva-1')
  session(from, projectKey(cwd), 'viva-2')
  session(from, projectKey('/Users/a/code'), 'users-own')

  assert.equal(adoptDshSessions({ fromHome: from, toHome: to, cwd }), 2)
  assert.deepEqual(fs.readdirSync(path.join(to, 'sessions')), [projectKey(cwd)])
  assert.ok(fs.existsSync(path.join(from, 'sessions', projectKey(cwd), 'viva-1')), 'copied, not moved')
  session(from, projectKey(cwd), 'viva-3')
  assert.equal(adoptDshSessions({ fromHome: from, toHome: to, cwd }), 0, 'once the app has its own, nothing more comes')
  assert.equal(adoptDshSessions({ fromHome: to, toHome: to, cwd }), 0)
})

test('skills in the old home come along once; what the app has, or later removes, is left alone', (t) => {
  const { from, to } = oldHome(t)
  const skill = (home, name, text) => {
    fs.mkdirSync(path.join(home, 'skills', name), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills', name, 'SKILL.md'), text)
  }
  skill(from, 'weekly', 'old')
  skill(from, 'review', 'old')
  fs.writeFileSync(path.join(from, 'skills', 'flat.md'), '---\nname: flat\n---')
  fs.mkdirSync(path.join(from, 'skills', '.system'))
  skill(to, 'review', 'the app already has this one')

  assert.deepEqual(adoptDshSkills({ fromHome: from, toHome: to }).sort(), ['flat.md', 'weekly'])
  assert.equal(fs.readFileSync(path.join(to, 'skills', 'review', 'SKILL.md'), 'utf8'), 'the app already has this one')
  assert.ok(fs.existsSync(path.join(from, 'skills', 'weekly')), 'copied, not moved')

  fs.rmSync(path.join(to, 'skills', 'weekly'), { recursive: true })
  assert.deepEqual(adoptDshSkills({ fromHome: from, toHome: to }), [], 'a skill removed in the app does not come back')
  assert.equal(fs.existsSync(path.join(to, 'skills', 'weekly')), false)
})

test('only the profiles the app wrote are removed from the old home, and their links are not followed', (t) => {
  const { dir, from, to } = oldHome(t)
  const plugin = path.join(dir, 'plugins', 'memory')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'index.js'), 'kept')
  const profile = (name, manifestName) => {
    const at = path.join(from, 'profiles', name)
    fs.mkdirSync(path.join(at, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name: manifestName }))
    fs.symlinkSync(plugin, path.join(at, 'node_modules', 'viva-memory'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  profile('viva', 'dsh-profile-viva')
  profile('my-agent', 'dsh-profile-my-agent')
  profile('acp', 'dsh-profile-acp')
  fs.mkdirSync(path.join(from, 'profiles', 'web'))

  assert.deepEqual(removeOwnProfiles({ fromHome: from, toHome: to }).sort(), ['my-agent', 'viva'])
  assert.deepEqual(fs.readdirSync(path.join(from, 'profiles')).sort(), ['acp', 'web'])
  assert.equal(fs.readFileSync(path.join(plugin, 'index.js'), 'utf8'), 'kept')
})

/** A stand-in child process: exits when told to, records signals. */
function fakeChild({ pid = 4321 } = {}) {
  const child = new EventEmitter()
  Object.assign(child, { pid, exitCode: null, signalCode: null, signals: [], stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  child.kill = (signal) => { child.signals.push(signal) }
  child.exit = (code, signal = null) => {
    Object.assign(child, { exitCode: code, signalCode: signal })
    child.emit('exit', code, signal)
  }
  return child
}

function bridgeWith(t, { platform = 'darwin' } = {}) {
  const spawned = []
  const exits = []
  const errors = []
  const spawnFn = (command, args) => {
    const child = fakeChild()
    spawned.push({ command, args, child })
    return child
  }
  const bridge = createAcpBridge({
    dshBin: '/app/dsh.js', nodeBin: '/apps/Viva', cwd: '/w', emit: (event) => event.type === 'error' && errors.push(event), spawnFn, platform,
    onExit: (exit) => exits.push(exit),
  })
  bridge.start().catch(() => {})
  t.after(() => spawned.forEach(({ child }) => child.exitCode ?? child.exit(0)))
  return { bridge, spawned, exits, errors }
}

test('dsh dying on its own goes to onExit, not to the window; stopping it on purpose goes nowhere', async (t) => {
  const { spawned, exits, errors } = bridgeWith(t)
  spawned[0].child.exit(1)
  assert.deepEqual([exits.length, errors.length], [1, 0])
  assert.match(exits[0].message, /dsh 已退出（1）/)

  const second = bridgeWith(t)
  const stopped = second.bridge.dispose()
  second.spawned[0].child.exit(0)
  await stopped
  assert.deepEqual(second.exits, [])
})

test('on Windows the whole process tree is ended when dsh does not stop by itself', async (t) => {
  const { bridge, spawned } = bridgeWith(t, { platform: 'win32' })
  const stopped = bridge.dispose()
  assert.equal(spawned[0].child.stdin.writableEnded, true, 'dsh is first asked to stop by closing its input')
  await new Promise((resolve) => setTimeout(resolve, 1_600))
  assert.deepEqual(spawned.slice(1).map(({ command, args }) => [command, ...args]), [['taskkill', '/pid', '4321', '/T', '/F']])
  spawned[0].child.exit(1)
  await stopped
})
