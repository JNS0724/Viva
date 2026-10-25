import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkManifest } from '../src/main/source-contract.ts'
import { createSourcePoller, retryDelayMs } from '../src/main/source-poller.ts'
import { createSourceSettings } from '../src/main/source-settings.ts'
import { openSourcesDb } from '../src/main/sources-db.ts'
import { registerSourcesIpc } from '../src/main/sources-ipc.ts'

const MINUTE = 60_000
const plainCrypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }

const manifest = checkManifest({
  contract: 1, id: 'acme', name: 'Acme', kind: 'alert', run: ['node', 'index.js'], reads: '告警', everyMinutes: 5,
  config: { token: { type: 'secret', title: '令牌', required: true }, level: { type: 'enum', title: '级别', values: ['P0', 'P1'], default: 'P1' } },
}).manifest
const folder = { dir: '/sources/acme', manifest }

/** A poller over a real store and settings file, with its timers in the test's hands and a scripted poll. */
function setup(t, script = () => ({ ok: true, value: { cursor: 'c', messages: [], dropped: [] } })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-'))
  const db = openSourcesDb({ file: path.join(dir, 'sources.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const settings = createSourceSettings({ file: path.join(dir, 'source-settings.json'), crypto: plainCrypto })
  let clock = 0
  const timers = []
  const calls = []
  const poller = createSourcePoller({
    folders: () => [folder],
    settings,
    db,
    poll: async (_folder, config, cursor) => {
      calls.push({ config, cursor })
      return script(calls.length, config)
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms, done: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { timer.done = true },
  })
  /** Moves the clock on by `ms`, firing what falls due, and lets the polls settle. */
  async function advance(ms) {
    clock += ms
    for (const timer of timers) {
      if (!timer.done && timer.at <= clock) {
        timer.done = true
        timer.fn()
      }
    }
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  }
  const nextIn = () => Math.min(...timers.filter((timer) => !timer.done).map((timer) => timer.at - clock))
  return { db, settings, poller, calls, advance, nextIn }
}

test('a source is asked only once switched on, then every interval, from where it stopped', async (t) => {
  let n = 0
  const { settings, poller, calls, advance, db } = setup(t, () => ({ ok: true, value: { cursor: `c${++n}`, messages: [{ id: `m${n}`, at: n, title: 't' }], dropped: [] } }))
  poller.refresh({ launching: true })
  await advance(MINUTE)
  assert.equal(calls.length, 0, 'off by default')

  settings.save(manifest, { enabled: true, values: { token: 'tok' } })
  poller.refresh()
  await advance(0)
  assert.deepEqual(calls.map((c) => c.cursor), [null])
  assert.equal(calls[0].config.token, 'tok', 'secrets reach the source')
  await advance(5 * MINUTE)
  assert.deepEqual(calls.map((c) => c.cursor), [null, 'c1'])
  assert.equal(db.health('acme').count, 2)
})

test('a change in settings applies at the next run, and a new interval counts from the last run', async (t) => {
  const { settings, poller, calls, advance, nextIn } = setup(t)
  settings.save(manifest, { enabled: true, values: { token: 'tok' } })
  poller.refresh()
  await advance(0)
  settings.save(manifest, { values: { level: 'P0' }, everyMinutes: 2 })
  poller.refresh()
  assert.equal(nextIn(), 2 * MINUTE)
  await advance(2 * MINUTE)
  assert.deepEqual(calls.map((c) => c.config.level), ['P1', 'P0'])

  settings.save(manifest, { enabled: false })
  poller.refresh()
  await advance(60 * MINUTE)
  assert.equal(calls.length, 2, 'switched off: never asked again')
})

test('after failures the source is asked later and later, from the same place', async (t) => {
  assert.deepEqual([1, 2, 3, 4, 9].map((failures) => retryDelayMs(failures, 5) / MINUTE), [5, 5, 15, 60, 60])
  assert.equal(retryDelayMs(1, 1) / MINUTE, 1)
  const { settings, poller, calls, advance, nextIn, db } = setup(t, (n) => (n < 3 ? { ok: false, problem: '没登录' } : { ok: true, value: { cursor: 'c', messages: [], dropped: [] } }))
  settings.save(manifest, { enabled: true, everyMinutes: 1, values: { token: 'tok' } })
  poller.refresh()
  await advance(0)
  assert.equal(nextIn(), 1 * MINUTE)
  await advance(MINUTE)
  assert.equal(nextIn(), 5 * MINUTE)
  assert.deepEqual([db.health('acme').failures, db.health('acme').lastError], [2, '没登录'])
  await advance(5 * MINUTE)
  assert.deepEqual(calls.map((c) => c.cursor), [null, null, null])
  assert.equal(db.health('acme').failures, 0)
})

test('what a source read while it was switched off is let go', async (t) => {
  let settingsRef
  const { settings, poller, advance, db } = setup(t, () => {
    settingsRef.save(manifest, { enabled: false })
    return { ok: true, value: { cursor: 'c', messages: [{ id: 'm', at: 1, title: 't' }], dropped: [] } }
  })
  settingsRef = settings
  settings.save(manifest, { enabled: true, values: { token: 'tok' } })
  poller.refresh()
  await advance(0)
  assert.equal(db.health('acme').count, 0)
})

test('settings IPC: the form saves and applies, tests without saving, and never sends a secret back', async (t) => {
  const { settings, poller, db, calls, advance } = setup(t)
  const handlers = new Map()
  const checked = []
  // As ipcMain.handle does, a handler that throws answers with a rejection.
  registerSourcesIpc({ handle: (channel, fn) => handlers.set(channel, async (...args) => fn({}, ...args)) }, {
    list: () => ({ sources: [folder], broken: [{ dir: '/sources/x', name: 'x', problem: '没有 viva-source.json' }] }),
    root: '/sources',
    label: (dir) => dir.replace('/sources', '~/sources'),
    settings,
    db,
    poller,
    check: async (_folder, config) => {
      checked.push(config)
      return { ok: true, value: config.token === 'good' ? { ok: true } : { ok: false, problem: '令牌不对' } }
    },
    openFolder: async () => {},
    chooseFolder: async () => null,
    trash: async () => {},
    dropData: () => {},
  })
  const first = await handlers.get('sources:get')()
  assert.deepEqual(first.broken, [{ name: 'x', problem: '没有 viva-source.json' }])
  assert.deepEqual(first.sources[0].fields.map((f) => [f.key, f.type]), [['token', 'secret'], ['level', 'enum']])
  assert.equal(first.sources[0].settings.enabled, false)

  assert.deepEqual(await handlers.get('sources:check')('acme', { values: { token: 'bad' } }), { ok: false, problem: '令牌不对' })
  assert.equal(settings.view(manifest).savedSecrets.length, 0, 'testing does not save')

  await assert.rejects(handlers.get('sources:save')('acme', { enabled: true }), /先填好：令牌/)
  const saved = await handlers.get('sources:save')('acme', { enabled: true, values: { token: 'good' } })
  assert.deepEqual(saved.sources[0].settings.savedSecrets, ['token'])
  assert.doesNotMatch(JSON.stringify(saved), /"good"/)
  await advance(0)
  assert.equal(calls.length, 1, 'switched on from settings: asked right away')

  assert.deepEqual(await handlers.get('sources:check')('acme', { values: { token: '' } }), { ok: true }, 'a blank secret tests the saved one')
  assert.equal(checked.at(-1).token, 'good')

  await handlers.get('sources:poll-now')('acme')
  assert.equal(calls.length, 2)
  await assert.rejects(handlers.get('sources:save')('gone', {}), /已经不在了/)
  await assert.rejects(handlers.get('sources:save')('acme', { enabled: 'yes' }), /invalid enabled/)
})
