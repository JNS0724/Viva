import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCall, serveCalls, type Manager } from '../plugins/plugins/lib/channel.ts'
import { createPluginsDesk } from '../src/backend/plugins-channel.ts'

/** A plugin manager that records what it was asked. */
function fakeManager(calls: unknown[][]): Manager {
  const answer = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args])
    return { name, args }
  }
  return {
    listBundles: async () => [{ name: 'b' }], listPlugins: async () => [{ entryId: 'e' }],
    inspect: answer('inspect'), installBundle: answer('installBundle'), removeBundle: answer('removeBundle'),
    setBundleEnabled: answer('setBundleEnabled'), setPluginEnabled: answer('setPluginEnabled'),
  }
}

/** The app's desk and the plugin, talking over one in-memory channel. */
function wired(manager: Manager) {
  const listeners = new Set<(message: unknown) => void>()
  let desk: ReturnType<typeof createPluginsDesk> | null = null
  const port = {
    send: (message: object) => queueMicrotask(() => desk!.receive(JSON.parse(JSON.stringify(message)))),
    on: (_event: 'message', handler: (message: unknown) => void) => listeners.add(handler),
    off: (_event: 'message', handler: (message: unknown) => void) => listeners.delete(handler),
  }
  const stop = serveCalls(manager, port)
  desk = createPluginsDesk({ send: (message) => queueMicrotask(() => listeners.forEach((listener) => listener(JSON.parse(JSON.stringify(message))))) })
  return { desk, stop, listeners }
}

test('each call goes to dsh\'s plugin manager and its answer comes back', async () => {
  const calls: unknown[][] = []
  const { desk, stop, listeners } = wired(fakeManager(calls))
  assert.deepEqual(await desk.call('list'), { ok: true, value: { bundles: [{ name: 'b' }], plugins: [{ entryId: 'e' }] } })
  await desk.call('install', { spec: ' demo ', approvedBuilds: ['esbuild'] })
  await desk.call('setBundle', { name: 'demo', enabled: false })
  await desk.call('remove', { name: 'demo' })
  assert.deepEqual(calls, [['installBundle', 'demo', { approvedBuilds: ['esbuild'] }], ['setBundleEnabled', 'demo', false], ['removeBundle', 'demo']])
  stop()
  assert.equal(listeners.size, 0)
})

test('malformed calls are refused before they reach the manager', async () => {
  const calls: unknown[][] = []
  const manager = fakeManager(calls)
  await assert.rejects(runCall(manager, 'install', { spec: '' }), /invalid argument/)
  await assert.rejects(runCall(manager, 'setBundle', { name: 'x', enabled: 'yes' }), /invalid argument/)
  await assert.rejects(runCall(manager, 'install', { spec: 'x', approvedBuilds: 'all' }), /invalid argument/)
  await assert.rejects(runCall(manager, 'drop-tables', {}), /unknown operation/)
  assert.deepEqual(calls, [])
  const { desk } = wired(manager)
  assert.deepEqual(await desk.call('remove', { name: '' }), { ok: false, problem: 'invalid argument' })
})

test('a call nobody answers times out, and closing settles what still waits', async () => {
  const timers: Array<() => void> = []
  const desk = createPluginsDesk({ send: () => {}, setTimer: (fn) => { timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }, clearTimer: () => {} })
  const late = desk.call('list')
  timers[0]()
  assert.deepEqual(await late, { ok: false, problem: 'timeout' })
  const pending = desk.call('install', { spec: 'x' })
  desk.close()
  assert.deepEqual(await pending, { ok: false, problem: 'disconnected' })
  const failing = createPluginsDesk({ send: () => { throw new Error('channel closed') } })
  assert.deepEqual(await failing.call('list'), { ok: false, problem: 'channel closed' })
})
