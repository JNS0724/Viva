import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REGISTRY_TOKEN_ENV, authKey, createPluginSourceStore, normalizeRegistry, npmrcWith } from '../src/backend/plugin-source.ts'

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

test('a registry is an https address, or http on this computer; kept with one slash at the end', () => {
  assert.equal(normalizeRegistry(' https://npm.example.com/repo '), 'https://npm.example.com/repo/')
  assert.equal(normalizeRegistry('http://localhost:4873'), 'http://localhost:4873/')
  for (const bad of ['npm.example.com', 'http://npm.example.com', 'ftp://npm.example.com', 'https://user:pass@npm.example.com', '']) {
    assert.throws(() => normalizeRegistry(bad), Error, bad)
  }
})

test('the token is named for its registry in .npmrc by a variable only; the value never goes there', () => {
  assert.equal(authKey('https://npm.example.com:8443/repo/'), '//npm.example.com:8443/repo/')
  const written = npmrcWith('strict-ssl=true\n', 'https://npm.example.com/repo/')
  assert.equal(written, `strict-ssl=true\n# viva: plugin source\n//npm.example.com/repo/:_authToken=\${${REGISTRY_TOKEN_ENV}}\n`)
  assert.equal(npmrcWith(written, 'https://other.example/'), `strict-ssl=true\n# viva: plugin source\n//other.example/:_authToken=\${${REGISTRY_TOKEN_ENV}}\n`, 'the old line goes, the user\'s stay')
  assert.equal(npmrcWith(written, null), 'strict-ssl=true\n', 'no source: only the user\'s lines are left')
  assert.equal(npmrcWith('', null), '')
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
