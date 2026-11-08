import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPluginSourceStore, normalizeRegistry } from '../src/backend/plugin-source.ts'

/** The company's own plugin source (plugin-source.ts): a registry, and its token kept encrypted, never written out. */

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decryptString: (data: Buffer) => Buffer.from(data.toString().slice(4), 'base64').toString(),
}

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-source-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'plugin-source.json') }
}

test('the token kept goes to its own registry only: a new host needs it typed again; a new path on the same host keeps it', (t) => {
  const { file } = setup(t)
  const store = createPluginSourceStore({ file, crypto })
  store.save({ registry: 'https://npm.example.com/', token: 'npm_secret_value' })
  assert.throws(() => store.save({ registry: 'https://elsewhere.example/' }), Error, 'left blank, it would be sent to another host')
  assert.deepEqual([store.registry(), store.token()], ['https://npm.example.com/', 'npm_secret_value'], 'nothing changed')
  assert.deepEqual(store.save({ registry: 'https://npm.example.com/v2/' }), { registry: 'https://npm.example.com/v2/', hasToken: true })
  assert.deepEqual(store.save({ registry: 'https://elsewhere.example/', token: 'npm_other' }), { registry: 'https://elsewhere.example/', hasToken: true })
  assert.deepEqual(store.save({ registry: 'https://third.example/', token: '' }), { registry: 'https://third.example/', hasToken: false }, 'cleared, it may go anywhere')
})

test('a registry is an https address, or http on this computer; kept with one slash at the end', () => {
  assert.equal(normalizeRegistry(' https://npm.example.com/repo '), 'https://npm.example.com/repo/')
  assert.equal(normalizeRegistry('http://localhost:4873'), 'http://localhost:4873/')
  for (const bad of ['npm.example.com', 'http://npm.example.com', 'ftp://npm.example.com', 'https://user:pass@npm.example.com', '']) {
    assert.throws(() => normalizeRegistry(bad), Error, bad)
  }
})

test('kept encrypted: the file has neither the token nor anything decodable without the key; the window is told only whether there is one', (t) => {
  const { file } = setup(t)
  const store = createPluginSourceStore({ file, crypto })
  assert.deepEqual(store.view(), { registry: null, hasToken: false })
  store.save({ registry: 'https://npm.example.com/', token: 'npm_secret_value' })
  assert.ok(!fs.readFileSync(file, 'utf8').includes('npm_secret_value'))
  assert.deepEqual(store.view(), { registry: 'https://npm.example.com/', hasToken: true })
  assert.equal(store.token(), 'npm_secret_value')
  store.save({ registry: 'https://npm.example.com/v2' })
  assert.deepEqual([store.view(), store.token()], [{ registry: 'https://npm.example.com/v2/', hasToken: true }, 'npm_secret_value'], 'a token not given is kept')
  store.save({ registry: 'https://npm.example.com/v2', token: '' })
  assert.deepEqual(store.view(), { registry: 'https://npm.example.com/v2/', hasToken: false }, 'an empty one clears it')
  store.save({ registry: null })
  assert.deepEqual([store.view(), fs.existsSync(file)], [{ registry: null, hasToken: false }, false], 'no source: nothing kept')
})

test('a token with spaces is refused; without the keychain a token cannot be kept, a source without one can', (t) => {
  const { file } = setup(t)
  assert.throws(() => createPluginSourceStore({ file, crypto }).save({ registry: 'https://npm.example.com', token: 'a b' }))
  const locked = createPluginSourceStore({ file, crypto: { ...crypto, isEncryptionAvailable: () => false } })
  assert.throws(() => locked.save({ registry: 'https://npm.example.com', token: 'npm_secret_value' }))
  locked.save({ registry: 'https://npm.example.com' })
  assert.deepEqual(locked.view(), { registry: 'https://npm.example.com/', hasToken: false })
})
