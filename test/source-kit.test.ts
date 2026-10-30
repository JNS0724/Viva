import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFolder } from '../src/main/source-check.ts'
import { readManifest } from '../src/main/source-folders.ts'
import { commandFor } from '../src/main/source-run.ts'

/** The kit as a developer gets it: templates, the defineSource runtime, and `viva-source` built from the app's code. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KIT = path.join(ROOT, 'packages', 'viva-source-kit')
const BIN = path.join(KIT, 'bin', 'viva-source.js')
/** This runtime as plain Node, as the tests and the app run sources. */
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const viva = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { env: nodeEnv, encoding: 'utf8' })

function tempDir(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-kit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the JS template passes the app\'s own checks', async () => {
  const report = await checkFolder(path.join(KIT, 'templates', 'js'))
  assert.equal(report.ok, true, JSON.stringify(report.steps))
  assert.deepEqual(report.steps.filter((s) => s.status !== 'ok'), [])
})

test('the Python template passes too, and says what to run on Windows', async (t) => {
  const dir = path.join(KIT, 'templates', 'python')
  const read = readManifest(dir)
  assert.ok('manifest' in read)
  const { manifest } = read
  if (!commandFor({ dir, manifest }, { dataDir: os.tmpdir() }).ok) return t.skip('no Python on this machine')
  const report = await checkFolder(dir)
  assert.equal(report.ok, true, JSON.stringify(report.steps))
  assert.deepEqual(manifest.runOn?.win32, ['py', '-3', 'main.py'])
})

test('the command template turns a CLI\'s JSON into messages, reading on from the newest it saw', async (t) => {
  const dir = tempDir(t)
  const cli = path.join(dir, 'fake-mail-cli.js')
  fs.writeFileSync(cli, `process.stdout.write(JSON.stringify([
    { id: 'm1', date: '2026-10-25T01:00:00Z', from: '[发件人]', subject: '周报' },
    { id: 'm2', date: '2026-10-25T02:00:00Z', from: '[发件人]', subject: '合同' },
  ]))`)
  const report = await checkFolder(path.join(KIT, 'templates', 'command'), { values: { command: process.execPath, args: cli } })
  assert.equal(report.ok, true, JSON.stringify(report.steps))
  assert.deepEqual(report.steps.map((s) => s.title).slice(-2), ['第一次 poll（从头）：交回 2 条消息', '第二次 poll（接着上次的游标）：交回 0 条消息'])
})

test('a source whose poll throws says why on stderr and exits non-zero, as the app expects', (t) => {
  // Inside the kit's own folder, so `viva-source-kit` resolves to it as it would from node_modules.
  const file = path.join(KIT, `.failing-${process.pid}.mjs`)
  t.after(() => fs.rmSync(file, { force: true }))
  fs.writeFileSync(file, `import { defineSource } from 'viva-source-kit'\ndefineSource({ poll() { throw new Error('CLI 没登录') } })\n`)
  const ran = spawnSync(process.execPath, [file], { env: nodeEnv, input: JSON.stringify({ contract: 1, action: 'poll', config: {}, cursor: null }), encoding: 'utf8' })
  assert.equal(ran.status, 1)
  assert.equal(ran.stderr.trim(), 'CLI 没登录')
  const check = spawnSync(process.execPath, [file], { env: nodeEnv, input: JSON.stringify({ contract: 1, action: 'check', config: {} }), encoding: 'utf8' })
  assert.deepEqual(JSON.parse(check.stdout), { ok: true }, 'no check: always fine')
})

test('viva-source: built from the app\'s code, it starts a source from a template and checks a folder', (t) => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-source-kit.mjs')], { env: nodeEnv, stdio: 'pipe' })
  const dir = tempDir(t)
  const made = viva('new', path.join(dir, 'Team Alerts'), '--template', 'python')
  assert.equal(made.status, 0, made.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'Team Alerts', 'viva-source.json'), 'utf8')).id, 'team-alerts')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'Team Alerts', 'viva-source.json'), 'utf8')).name, 'My source')
  const chinese = viva('new', path.join(dir, 'Chinese Alerts'), '--template', 'python', '--language', 'zh-CN')
  assert.equal(chinese.status, 0, chinese.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'Chinese Alerts', 'viva-source.json'), 'utf8')).name, '我的消息源')
  assert.equal(viva('new', path.join(dir, 'Team Alerts')).status, 2, 'a folder with something in it is not overwritten')

  const fixture = path.join(ROOT, 'test', 'fixtures', 'sources', 'fake-alerts')
  const passed = viva('test', fixture, '--language', 'zh-CN', '--set', 'token=good', '--set', 'total=1')
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.match(passed.stdout, /第一次 poll（从头）：交回 1 条消息/)
  const english = viva('test', fixture, '--set', 'token=good', '--set', 'total=2')
  assert.equal(english.status, 0, english.stderr)
  assert.match(english.stdout, /First poll \(from the start\): returned 2 messages/)
  assert.equal(viva('test', fixture, '--language', 'bad').status, 2)
  const missing = viva('test', fixture, '--language', 'zh-CN')
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /缺少必填的配置\n {4}访问令牌/)
  assert.equal(viva('frobnicate').status, 2)
})
