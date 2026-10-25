import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkCheckResult, checkConfigValues, checkManifest, checkMessage, checkPollResult, LIMITS, missingFields } from '../src/main/source-contract.ts'
import { listSourceFolders } from '../src/main/source-folders.ts'
import { createSourceSettings } from '../src/main/source-settings.ts'
import { openSourcesDb } from '../src/main/sources-db.ts'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Stand-in for safeStorage: reversible, and visibly not plain text. */
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().replace(/^enc:/, ''), 'base64').toString(),
})

const MANIFEST = Object.freeze({
  contract: 1,
  id: 'acme-alerts',
  name: 'Acme 告警',
  kind: 'alert',
  run: ['node', 'index.js'],
  reads: '告警名、级别、时间',
  config: {
    endpoint: { type: 'string', title: '地址', required: true },
    token: { type: 'secret', title: '访问令牌', required: true },
    minLevel: { type: 'enum', title: '最低级别', values: ['P0', 'P1', 'P2'], default: 'P1' },
  },
})

const manifestOf = (extra = {}) => {
  const checked = checkManifest({ ...MANIFEST, ...extra })
  assert.equal(checked.problem, undefined, checked.problem)
  return checked.manifest
}

const message = (extra = {}) => ({ id: 'm1', at: '2026-10-23T06:00:00Z', from: '[发件人]', title: '周报', text: '请周五前交', ...extra })

test('a manifest says who the source is, how to run it, what it reads and what it needs set', () => {
  const manifest = manifestOf()
  assert.equal(manifest.everyMinutes, 5, 'the interval has a default')
  assert.deepEqual(Object.keys(manifest.config), ['endpoint', 'token', 'minLevel'])
  assert.match(checkManifest({ ...MANIFEST, id: '../x' }).problem, /id/)
  assert.match(checkManifest({ ...MANIFEST, kind: 'fax' }).problem, /kind/)
  assert.match(checkManifest({ ...MANIFEST, run: [] }).problem, /run/)
  assert.match(checkManifest({ ...MANIFEST, everyMinutes: 0 }).problem, /everyMinutes/)
  assert.match(checkManifest({ ...MANIFEST, config: { 'bad key': { type: 'string', title: 'x' } } }).problem, /配置项名/)
  assert.match(checkManifest({ ...MANIFEST, config: { a: { type: 'enum', title: 'x', values: ['a'], default: 'b' } } }).problem, /默认值/)
  assert.match(checkManifest({ ...MANIFEST, contract: 2 }).problem, /需要更新 Viva/)
  assert.match(checkManifest(null).problem, /viva-source\.json/)
})

test('a message is checked field by field and comes out in one shape, its time in ms', () => {
  assert.deepEqual(checkMessage(message({ link: 'https://mail.example/1', level: 'P1', thread: 't1' })), {
    message: { id: 'm1', at: Date.parse('2026-10-23T06:00:00Z'), from: '[发件人]', title: '周报', text: '请周五前交', link: 'https://mail.example/1', level: 'P1', thread: 't1' },
  })
  assert.equal(checkMessage(message({ at: 1761199200000 })).message.at, 1761199200000)
  assert.deepEqual(Object.keys(checkMessage({ id: 'm', at: 1, title: 't', from: '' }).message).sort(), ['at', 'id', 'title'], 'empty fields are left out')
  assert.match(checkMessage(message({ id: '' })).problem, /id/)
  assert.match(checkMessage(message({ at: 'yesterday' })).problem, /at/)
  assert.match(checkMessage(message({ text: 'x'.repeat(LIMITS.textChars + 1) })).problem, /text/)
  assert.match(checkMessage(message({ link: 'javascript:alert(1)' })).problem, /link/)
  assert.match(checkMessage(message({ link: 'not a link' })).problem, /link/)
  assert.match(checkMessage(message({ title: undefined, text: undefined })).problem, /title 和 text/)
})

test('a poll keeps the messages that fit and says why the others were dropped; a bad cursor fails it all', () => {
  const checked = checkPollResult({ cursor: 'c2', messages: [message(), message({ id: 'm2', at: 'nope' }), 42] })
  assert.deepEqual(checked.result.messages.map((m) => m.id), ['m1'])
  assert.equal(checked.result.cursor, 'c2')
  assert.equal(checked.result.dropped.length, 2)
  assert.match(checked.result.dropped[0], /消息 m2/)
  assert.match(checked.result.dropped[1], /一条消息/)
  assert.match(checkPollResult({ cursor: 3, messages: [] }).problem, /cursor/)
  assert.match(checkPollResult({ cursor: null, messages: Array(LIMITS.messagesPerPoll + 1).fill(message()) }).problem, /messages/)
  assert.deepEqual(checkCheckResult({ ok: false, problem: '令牌不对' }).result, { ok: false, problem: '令牌不对' })
  assert.match(checkCheckResult({ ok: false }).problem, /check/)
})

test('settings values are checked against the declared fields, defaults filled in, required ones named', () => {
  const { config } = manifestOf()
  assert.deepEqual(checkConfigValues(config, { endpoint: 'https://x.example' }).values, { endpoint: 'https://x.example', minLevel: 'P1' })
  assert.match(checkConfigValues(config, { minLevel: 'P9' }).problem, /最低级别/)
  assert.match(checkConfigValues(config, { other: 1 }).problem, /没有这个配置项/)
  assert.match(checkConfigValues(config, { endpoint: 3 }).problem, /要填文本/)
  assert.deepEqual(missingFields(config, { endpoint: 'x' }), ['访问令牌'])
})

test('the sources folder lists each usable source once, and says what is wrong with the others', (t) => {
  const root = tempDir(t)
  const write = (folder, manifest) => {
    fs.mkdirSync(path.join(root, folder), { recursive: true })
    if (manifest !== undefined) fs.writeFileSync(path.join(root, folder, 'viva-source.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  }
  write('a-good', MANIFEST)
  write('b-twin', MANIFEST)
  write('c-broken', '{ nope')
  write('d-empty')
  write('.hidden', MANIFEST)
  const { sources, broken } = listSourceFolders(root)
  assert.deepEqual(sources.map((s) => [path.basename(s.dir), s.manifest.id]), [['a-good', 'acme-alerts']])
  assert.deepEqual(broken.map((b) => b.name), ['b-twin', 'c-broken', 'd-empty'])
  assert.match(broken[0].problem, /重复/)
  assert.match(broken[1].problem, /JSON/)
  assert.match(broken[2].problem, /没有 viva-source\.json/)
  assert.deepEqual(listSourceFolders(path.join(root, 'missing')), { sources: [], broken: [] })
})

test('settings keep secrets encrypted and out of the view; a blank secret keeps the saved one', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'source-settings.json')
  const store = createSourceSettings({ file, crypto: fakeCrypto() })
  const manifest = manifestOf()
  assert.deepEqual(store.view(manifest), { enabled: false, everyMinutes: 5, values: { minLevel: 'P1' }, savedSecrets: [], missing: ['地址', '访问令牌'] })
  assert.throws(() => store.save(manifest, { enabled: true, values: { endpoint: 'https://x.example' } }), /先填好：访问令牌/)

  store.save(manifest, { enabled: true, everyMinutes: 10, values: { endpoint: 'https://x.example', token: 'tok-secret' } })
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /tok-secret/)
  assert.deepEqual(store.view(manifest), { enabled: true, everyMinutes: 10, values: { endpoint: 'https://x.example', minLevel: 'P1' }, savedSecrets: ['token'], missing: [] })
  assert.equal(store.get(manifest).values.token, 'tok-secret')

  store.save(manifest, { values: { token: '', minLevel: 'P0' } })
  assert.deepEqual([store.get(manifest).values.token, store.get(manifest).values.minLevel], ['tok-secret', 'P0'])
  assert.throws(() => store.save(manifest, { everyMinutes: 0 }), /轮询间隔/)

  store.remove(manifest.id)
  assert.equal(store.get(manifest).enabled, false)
})

test('settings refuse to keep a secret without the keychain, and a field the source dropped is let go', (t) => {
  const dir = tempDir(t)
  const manifest = manifestOf()
  const locked = createSourceSettings({ file: path.join(dir, 'a.json'), crypto: fakeCrypto(false) })
  assert.throws(() => locked.save(manifest, { values: { token: 'x' } }), /钥匙串/)

  const store = createSourceSettings({ file: path.join(dir, 'b.json'), crypto: fakeCrypto() })
  store.save(manifest, { values: { endpoint: 'https://x.example', token: 't' } })
  const { endpoint: _dropped, ...config } = manifest.config
  assert.deepEqual(store.get({ ...manifest, config }).values, { token: 't', minLevel: 'P1' })
})

test('the store keeps each message once with its source\'s place, and only the latest few per source', (t) => {
  const dir = tempDir(t)
  let clock = 5
  const db = openSourcesDb({ file: path.join(dir, 'sources.db'), keep: 3, now: () => clock })
  const at = (n) => ({ id: `m${n}`, at: n, title: `t${n}` })
  assert.equal(db.save('acme', [at(1), at(2)], 'c1'), 2)
  clock = 6
  assert.equal(db.save('acme', [at(2), at(3), at(4)], 'c2', ['消息 x：at 不对']), 2)
  assert.equal(db.cursorOf('acme'), 'c2')
  assert.deepEqual(db.latest('acme').map((m) => m.id), ['m4', 'm3', 'm2'])
  assert.deepEqual(db.latest('acme', 1)[0], { source: 'acme', id: 'm4', at: 4, title: 't4', receivedAt: 6 })

  assert.equal(db.fail('acme', '没登录'), 1)
  assert.equal(db.fail('acme', '还是没登录'), 2)
  const health = db.health('acme')
  assert.deepEqual([health.lastError, health.failures, health.lastOkAt, health.lastReceivedAt, health.count, health.dropped],
    ['还是没登录', 2, 6, 6, 3, ['消息 x：at 不对']])

  clock = 7
  db.save('acme', [], 'c2')
  const after = db.health('acme')
  assert.deepEqual([after.failures, after.lastError, after.lastOkAt, after.lastReceivedAt], [0, null, 7, 6], 'an empty poll is a success that received nothing')

  db.forget('acme')
  assert.deepEqual([db.cursorOf('acme'), db.health('acme').count], [null, 0])
  // Closed before the folder goes: Windows does not remove a file that is still open.
  db.close()
})
