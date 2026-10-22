import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { imagesForPrompt, registerImageIpc } from '../src/main/image-ipc.js'
import { createImageStore, MOVED_FOLDER_NAME } from '../src/main/image-store.js'

/** 设置 › 贴过的图片 in the main process: moving the folder (dsh restarting on it), emptying it, and reading pictures for the model. */

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

function setup({ picked = null, busy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-image-ipc-'))
  let dir = path.join(root, 'images')
  const store = createImageStore({ dir: () => dir })
  const handlers = new Map()
  const events = []
  registerImageIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    store,
    setDir: (next) => { events.push(['setDir', next]); dir = next },
    chooseFolder: async () => (picked ? path.join(root, picked) : null),
    reveal: async () => '',
    isBusy: () => busy,
    restart: async () => { events.push(['restart', dir]) },
  })
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args)
  return { root, store, call, events, dir: () => dir }
}

test('改位置… moves the pictures to the folder picked, remembers it, and restarts dsh there', async () => {
  const { root, call, events, store } = setup({ picked: 'Pictures' })
  fs.mkdirSync(path.join(root, 'Pictures'))
  const { id } = await call('images:keep', PNG)
  const usage = await call('images:move')
  const moved = path.join(root, 'Pictures', MOVED_FOLDER_NAME)
  assert.deepEqual(events, [['setDir', moved], ['restart', moved]], 'saved before dsh starts again, so it starts on the new folder')
  assert.equal(usage.dir, moved)
  assert.equal(usage.count, 1)
  assert.ok(store.pathOf(id).startsWith(moved))
  assert.equal(fs.existsSync(path.join(root, 'images', 'pasted')), false, 'nothing left where they were')
})

test('no folder picked: nothing moves', async () => {
  const { call, events } = setup()
  await call('images:keep', PNG)
  assert.equal(await call('images:move'), null)
  assert.deepEqual(events, [])
})

test('not while the agent works, and emptying leaves nothing', async () => {
  const busy = setup({ picked: 'x', busy: true })
  await assert.rejects(busy.call('images:move'), /正在工作/)
  await assert.rejects(busy.call('images:clear'), /正在工作/)
  const { call } = setup()
  await call('images:keep', PNG)
  assert.deepEqual(await call('images:clear'), { dir: (await call('images:usage')).dir, bytes: 0, count: 0 })
})

test('what the model gets: the picture as base64 with its kind; one emptied away is said to be gone', async () => {
  const { call, store } = setup()
  const { id } = await call('images:keep', PNG.buffer.slice(0))
  assert.deepEqual(imagesForPrompt(store, [{ id }]), [{ data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png' }])
  await call('images:clear')
  assert.throws(() => imagesForPrompt(store, [{ id }]), /不在图片文件夹/)
  assert.throws(() => imagesForPrompt(store, [{ id: '../../etc/passwd' }]), /invalid images/)
  await assert.rejects(call('images:keep', 'not bytes'), /无效的图片/)
})
