import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkDirIpc } from '../src/main/work-dir-ipc.ts'

/** The window asks to see, pick, switch and forget working directories; the main process decides. */

function setup({ busy = false, problems = {} } = {}) {
  const handlers = new Map()
  const ipcMain = { handle: (channel, listener) => handlers.set(channel, (...args) => listener({}, ...args)) }
  let current = '/data/workspace'
  let saved = { recent: [], trusted: [] }
  const switched = []
  registerWorkDirIpc(ipcMain, {
    current: () => current,
    defaultDir: '/data/workspace',
    preferences: { get: () => ({ workDirs: saved }), set: (key, value) => { assert.equal(key, 'workDirs'); saved = value } },
    chooseFolder: async () => '/me/picked',
    isBusy: () => busy,
    switchTo: async (dir) => {
      switched.push(dir)
      current = dir
      return { sessionId: `s-${switched.length}`, cwd: dir }
    },
    platform: 'linux',
    problemOf: (dir) => problems[dir] ?? null,
  })
  return { call: (channel, ...args) => handlers.get(channel)(...args), switched, saved: () => saved }
}

test('the window sees the folder in use, the default, and the ones used lately', async () => {
  const { call } = setup()
  assert.deepEqual(await call('workdir:get'), { current: '/data/workspace', defaultDir: '/data/workspace', isDefault: true, recent: [] })
  assert.equal(await call('workdir:choose'), '/me/picked', 'the system folder dialog')
})

test('the first time a folder is used the user confirms it; after that it is used at once', async () => {
  const { call, switched, saved } = setup()
  assert.deepEqual(await call('workdir:switch', '/me/site'), { ok: false, needsConfirm: true, dir: '/me/site' })
  assert.deepEqual(switched, [], 'nothing changes before the user confirms')

  const done = await call('workdir:switch', '/me/site', { confirmed: true })
  assert.deepEqual([done.ok, done.info.cwd, done.state.current, done.state.isDefault], [true, '/me/site', '/me/site', false])
  assert.deepEqual(saved(), { recent: ['/me/site'], trusted: ['/me/site'] })

  await call('workdir:switch', '/data/workspace')
  const again = await call('workdir:switch', '/me/site/')
  assert.equal(again.ok, true, 'confirmed once is enough, however the path is spelt')
  assert.deepEqual(switched, ['/me/site', '/data/workspace', '/me/site/'])
  assert.deepEqual(saved().recent, ['/me/site/', '/data/workspace'])
})

test('a folder that cannot be used is refused with the reason, and nothing changes', async () => {
  const { call, switched } = setup({ problems: { '/': '不能把整个磁盘作为工作目录，请选其中的某个文件夹' } })
  assert.deepEqual(await call('workdir:switch', '/', { confirmed: true }), { ok: false, problem: '不能把整个磁盘作为工作目录，请选其中的某个文件夹' })
  assert.deepEqual(switched, [])
  await assert.rejects(() => call('workdir:switch', 42), /invalid/)
})

test('while the agent works, or for the folder already in use, nothing is switched', async () => {
  const busy = setup({ busy: true })
  assert.deepEqual(await busy.call('workdir:switch', '/me/site', { confirmed: true }), { ok: false, reason: 'busy' })
  const same = setup()
  const unchanged = await same.call('workdir:switch', '/data/workspace/')
  assert.deepEqual([unchanged.ok, unchanged.unchanged], [true, true])
  assert.deepEqual([busy.switched, same.switched], [[], []])
})

test('forgetting a folder takes it off the list and asks again next time', async () => {
  const { call, saved } = setup()
  await call('workdir:switch', '/me/site', { confirmed: true })
  await call('workdir:forget', '/me/site')
  assert.deepEqual(saved(), { recent: [], trusted: [] })
  await call('workdir:switch', '/data/workspace')
  assert.equal((await call('workdir:switch', '/me/site')).needsConfirm, true)
})
