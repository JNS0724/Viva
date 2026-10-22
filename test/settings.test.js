import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore, keyHint, validateApiKey } from '../src/main/settings-store.ts'
import { resolveConfig } from '../src/main/config.ts'
import { initialState, reduce } from '../src/renderer/state.js'

const SAMPLE_KEY = 'sk-test-0000000000000000abcd'

/** Reversible stand-in for Electron safeStorage; output never contains the plaintext. */
function fakeCrypto(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
    decryptString: (buffer) => {
      const value = buffer.toString()
      if (!value.startsWith('enc:')) throw new Error('bad ciphertext')
      return [...value.slice(4)].reverse().join('')
    },
  }
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-settings-'))
  return path.join(dir, 'nested', 'settings.json')
}

test('validateApiKey trims and rejects empty, spaced, too short or non-text keys', () => {
  assert.equal(validateApiKey(`  ${SAMPLE_KEY}\n`), SAMPLE_KEY)
  assert.throws(() => validateApiKey('   '), /请先填写/)
  assert.throws(() => validateApiKey('sk-abc def-1234567'), /空格/)
  assert.throws(() => validateApiKey('sk-1'), /长度/)
  assert.throws(() => validateApiKey(42), /文本/)
})

test('keyHint only reveals the last four characters', () => {
  assert.equal(keyHint(SAMPLE_KEY), '••••abcd')
  assert.equal(keyHint(''), '')
})

test('store saves encrypted, owner-only, and reads the key back', () => {
  // Arrange
  const file = tempFile()
  const store = createSettingsStore({ file, crypto: fakeCrypto() })

  // Act
  store.saveApiKey(` ${SAMPLE_KEY} `)

  // Assert
  const raw = fs.readFileSync(file, 'utf8')
  assert.equal(raw.includes(SAMPLE_KEY), false)
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['version', 'deepseekApiKey'])
  // Windows has no POSIX mode bits; there the file lives in the per-user profile and is DPAPI-encrypted anyway
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(store.getApiKey(), SAMPLE_KEY)
})

test('store clears the key and reports nothing saved', () => {
  const file = tempFile()
  const store = createSettingsStore({ file, crypto: fakeCrypto() })
  store.saveApiKey(SAMPLE_KEY)

  store.clearApiKey()
  store.clearApiKey()

  assert.equal(store.getApiKey(), '')
  assert.equal(fs.existsSync(file), false)
})

test('store refuses to save when the OS keychain is unavailable', () => {
  const file = tempFile()
  const store = createSettingsStore({ file, crypto: fakeCrypto(false) })

  assert.throws(() => store.saveApiKey(SAMPLE_KEY), /钥匙串不可用/)
  assert.equal(fs.existsSync(file), false)
})

test('store reports corrupt or undecryptable files and falls back to no key', () => {
  const file = tempFile()
  const errors = []
  const store = createSettingsStore({ file, crypto: fakeCrypto(), onError: (err) => errors.push(err.message) })
  fs.mkdirSync(path.dirname(file), { recursive: true })

  fs.writeFileSync(file, '{not json')
  assert.equal(store.getApiKey(), '')
  fs.writeFileSync(file, JSON.stringify({ version: 1, deepseekApiKey: Buffer.from('plain').toString('base64') }))
  assert.equal(store.getApiKey(), '')

  assert.equal(errors.length, 2)
  assert.match(errors[1], /bad ciphertext/)
})

test('config prefers the saved key over the environment and records its source', () => {
  const always = () => true
  const saved = resolveConfig({ DEEPSEEK_API_KEY: 'env-key-123456' }, always, SAMPLE_KEY)
  const fromEnv = resolveConfig({ DEEPSEEK_API_KEY: 'env-key-123456' }, always, '')
  const none = resolveConfig({}, always, '')

  assert.deepEqual([saved.problem, saved.apiKey, saved.keySource], [null, SAMPLE_KEY, 'saved'])
  assert.deepEqual([fromEnv.apiKey, fromEnv.keySource], ['env-key-123456', 'env'])
  assert.deepEqual([none.problem, none.keySource], ['no-key', null])
})

test('settings state: open, load, save in flight, fail, succeed, close', () => {
  const view = { hasKey: true, keyHint: '••••abcd', source: 'saved', encryptionAvailable: true }
  const steps = [
    { type: 'settings_open' },
    { type: 'settings_loaded', view: { hasKey: false, keyHint: '', source: null, encryptionAvailable: true } },
    { type: 'settings_busy' },
    { type: 'settings_failed', message: 'API key 长度不对' },
    { type: 'settings_busy' },
    { type: 'settings_saved', view, notice: '已连接 · deepseek-v4-flash' },
  ]
  const states = steps.reduce((acc, action) => [...acc, reduce(acc.at(-1), action)], [initialState])
  const [, opened, loaded, busy, failed, , saved] = states

  assert.equal(opened.settings.open, true)
  assert.equal(loaded.settings.loaded, true)
  assert.equal(busy.settings.busy, true)
  assert.deepEqual([failed.settings.busy, failed.settings.error], [false, 'API key 长度不对'])
  assert.deepEqual(
    [saved.settings.hasKey, saved.settings.keyHint, saved.settings.error, saved.settings.notice],
    [true, '••••abcd', null, '已连接 · deepseek-v4-flash'],
  )
  assert.equal(reduce(saved, { type: 'settings_close' }).settings.open, false)
  assert.equal(reduce(saved, { type: 'new_session' }).settings, saved.settings)
})
