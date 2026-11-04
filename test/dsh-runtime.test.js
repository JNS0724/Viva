import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { CRASH_WINDOW_MS, dshEnv, dshHomeFor, dshRuntime, RESTART_DELAYS_MS, restartDelay } from '../src/backend/dsh-runtime.ts'

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
