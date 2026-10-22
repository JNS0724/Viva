import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { imageResponse } from '../src/main/image-protocol.js'
import { createImageStore, MOVED_FOLDER_NAME } from '../src/main/image-store.js'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))

function storeIn() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-images-'))
  let dir = path.join(root, 'images')
  const store = createImageStore({ dir: () => dir })
  return { root, store, dir: () => dir, setDir: (next) => { dir = next } }
}

test('a pasted picture is kept under its contents, once however often it is pasted', () => {
  const { store } = storeIn()
  const first = store.keep(PNG)
  const again = store.keep(PNG)
  assert.match(first.id, /^[a-f0-9]{64}\.png$/)
  assert.deepEqual(again, first)
  assert.equal(first.mimeType, 'image/png')
  assert.deepEqual(fs.readFileSync(store.pathOf(first.id)), Buffer.from(PNG))
  assert.equal(store.usage().count, 1)
})

test('only pictures the model reads, and not too big', () => {
  const { store } = storeIn()
  assert.throws(() => store.keep(Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), /PNG、JPG/)
  assert.throws(() => store.keep(new Uint8Array(0)), /PNG、JPG/)
  assert.throws(() => store.keep('not bytes'), /PNG、JPG/)
  const huge = new Uint8Array(20 * 1024 * 1024 + 1)
  huge.set(PNG)
  assert.throws(() => store.keep(huge), /太大/)
})

test('pathOf refuses names that are not pictures, and says when one is gone', () => {
  const { store } = storeIn()
  assert.equal(store.pathOf('../../etc/passwd'), null)
  assert.equal(store.pathOf(`${'c'.repeat(64)}.png`), null)
})

test('usage counts dsh copies too; emptying removes only the picture folders', () => {
  const { store, dir } = storeIn()
  store.keep(PNG)
  fs.mkdirSync(path.join(dir(), 'attachments', 'v1'), { recursive: true })
  fs.writeFileSync(path.join(dir(), 'attachments', 'v1', 'obj'), 'x'.repeat(100))
  fs.writeFileSync(path.join(dir(), 'notes.txt'), 'the user\'s own file')
  const used = store.usage()
  assert.equal(used.bytes, PNG.length + 100)
  assert.equal(used.count, 1)
  store.clear()
  assert.deepEqual(store.usage(), { dir: dir(), bytes: 0, count: 0 })
  assert.equal(fs.readFileSync(path.join(dir(), 'notes.txt'), 'utf8'), 'the user\'s own file')
})

test('moving copies into a folder of its own in the one picked, then empties the old place', () => {
  const { root, store, dir, setDir } = storeIn()
  const { id } = store.keep(PNG)
  const picked = path.join(root, 'elsewhere')
  fs.mkdirSync(picked)
  const old = dir()
  const moved = store.moveTo(picked)
  assert.equal(moved, path.join(picked, MOVED_FOLDER_NAME))
  assert.equal(fs.existsSync(path.join(old, 'pasted')), false)
  setDir(moved)
  assert.ok(store.pathOf(id))
})

test('viva-image:// serves a kept picture by name, and nothing else', async () => {
  const { store } = storeIn()
  const { id } = store.keep(PNG)
  const shown = imageResponse(`viva-image://img/${id}`, store)
  assert.equal(shown.status, 200)
  assert.equal(shown.headers.get('content-type'), 'image/png')
  assert.deepEqual(new Uint8Array(await shown.arrayBuffer()), PNG)
  assert.equal(imageResponse(`viva-image://img/${'d'.repeat(64)}.png`, store).status, 404, 'gone after emptying')
  assert.equal(imageResponse('viva-image://img/..%2F..%2Fsettings.json', store).status, 404)
  assert.equal(imageResponse(`viva-image://other/${id}`, store).status, 404)
})

test('moving refuses a place inside the folder, or one that already has Viva pictures', () => {
  const { root, store, dir } = storeIn()
  store.keep(PNG)
  assert.throws(() => store.moveTo(dir()), /里面/)
  const taken = path.join(root, 'taken')
  fs.mkdirSync(path.join(taken, MOVED_FOLDER_NAME, 'pasted'), { recursive: true })
  assert.throws(() => store.moveTo(taken), /已经有/)
  assert.ok(fs.existsSync(path.join(dir(), 'pasted')))
})
