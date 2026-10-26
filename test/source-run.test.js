import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSourceFolders } from '../src/main/source-folders.ts'
import { checkSource, commandFor, pollSource } from '../src/main/source-run.ts'

/** The real thing: test/fixtures/sources/fake-alerts run as a process by the app's own runtime, as sources are. */
const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sources')
const [fake] = listSourceFolders(SOURCES).sources

function options(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-data-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  return { dataDir, ...extra }
}

test('the fixture source is a valid source folder', () => {
  assert.equal(fake?.manifest.id, 'fake-alerts')
})

test('a poll reads on from the cursor it is given, past the log lines before its answer', async (t) => {
  const first = await pollSource(fake, { token: 'good', mode: 'ok', total: 3 }, null, options(t))
  assert.equal(first.ok, true, first.problem)
  assert.deepEqual([first.value.cursor, first.value.messages.map((m) => m.id)], ['2', ['a1', 'a2']])
  assert.equal(first.value.messages[0].at, Date.parse('2026-10-25T01:00:00Z'))
  const next = await pollSource(fake, { token: 'good', mode: 'ok', total: 3 }, '2', options(t))
  assert.deepEqual([next.value.cursor, next.value.messages.map((m) => m.id)], ['3', ['a3']])
})

test('a message that does not fit is dropped and said, the rest kept', async (t) => {
  const ran = await pollSource(fake, { token: 'good', mode: 'bad-message', total: 3 }, null, options(t))
  assert.deepEqual(ran.value.messages.map((m) => m.id), ['a1', 'a2'])
  assert.match(ran.value.dropped[0], /消息 bad/)
})

test('a failing, silent, slow or flooding source comes back as a problem, never as messages', async (t) => {
  const failed = await pollSource(fake, { token: 'good', mode: 'fail' }, null, options(t))
  assert.deepEqual(failed, { ok: false, problem: 'CLI 没登录' })
  const garbage = await pollSource(fake, { token: 'good', mode: 'garbage' }, null, options(t))
  assert.match(garbage.problem, /没有输出 JSON/)
  const slow = await pollSource(fake, { token: 'good', mode: 'slow' }, null, options(t, { timeoutMs: 500 }))
  assert.match(slow.problem, /没有结果，已停止/)
  const flood = await pollSource(fake, { token: 'good', mode: 'flood' }, null, options(t, { maxOutputBytes: 64 * 1024 }))
  assert.match(flood.problem, /输出超过/)
})

test('the source sees the system basics and its own folder, not the app\'s keys', async (t) => {
  const run = options(t, { env: { ...process.env, DEEPSEEK_API_KEY: 'sk-should-not-pass', DSH_HOME: '/x', HOME: os.homedir() } })
  const ran = await pollSource(fake, { token: 'good', mode: 'env' }, null, run)
  const names = ran.value.messages[0].text.split(',')
  assert.ok(names.includes('VIVA_SOURCE_DATA') && names.includes('PATH') && names.includes('HOME'))
  assert.ok(!names.includes('DEEPSEEK_API_KEY') && !names.includes('DSH_HOME'))
  assert.ok(fs.existsSync(run.dataDir))
})

test('check answers in the source\'s own words', async (t) => {
  assert.deepEqual(await checkSource(fake, { token: 'good' }, options(t)), { ok: true, value: { ok: true } })
  assert.deepEqual(await checkSource(fake, { token: 'bad' }, options(t)), { ok: true, value: { ok: false, problem: '令牌不对' } })
})

test('the command is the app\'s runtime for node, a file in the folder, or a program on PATH', (t) => {
  const dataDir = '/data'
  const node = commandFor(fake, { dataDir, execPath: '/app/Viva' })
  assert.deepEqual([node.value.command, node.value.args, node.value.env.ELECTRON_RUN_AS_NODE], ['/app/Viva', ['index.js'], '1'])
  const missing = commandFor({ ...fake, manifest: { ...fake.manifest, run: ['./no-such-file'] } }, { dataDir })
  assert.match(missing.problem, /找不到要运行的程序/)
  const unknown = commandFor({ ...fake, manifest: { ...fake.manifest, run: ['no-such-program-anywhere'] } }, { dataDir, env: { PATH: '' } })
  assert.match(unknown.problem, /找不到要运行的程序/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-cmd-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'mail.cmd'), '')
  const cmd = path.join(dir, 'mail.cmd')
  const windows = commandFor({ dir, manifest: { ...fake.manifest, run: ['./mail.cmd', 'list', '--json'] } }, { dataDir, platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } })
  assert.deepEqual([windows.value.command, windows.value.args, windows.value.verbatim], ['C:\\Windows\\cmd.exe', ['/d', '/s', '/c', `""${cmd}" list --json"`], true])
  const unsafe = commandFor({ dir, manifest: { ...fake.manifest, run: ['./mail.cmd', 'a&b'] } }, { dataDir, platform: 'win32' })
  assert.match(unsafe.problem, /参数只能是简单的词/)
})

test('a platform of its own may run the source otherwise, and Windows variables are found whatever their case', () => {
  const manifest = { ...fake.manifest, run: ['python3', 'main.py'], runOn: { win32: ['node', 'main.js'] } }
  const windows = commandFor({ ...fake, manifest }, { dataDir: 'D', platform: 'win32', execPath: 'C:\\Viva\\Viva.exe', env: { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', PATHEXT: '.EXE' } })
  assert.deepEqual([windows.value.command, windows.value.args], ['C:\\Viva\\Viva.exe', ['main.js']])
  assert.deepEqual([windows.value.env.PATH, windows.value.env.SYSTEMROOT, windows.value.env.PATHEXT], ['C:\\bin', 'C:\\Windows', '.EXE'])
  const elsewhere = commandFor({ ...fake, manifest }, { dataDir: 'D', platform: 'linux', env: { PATH: '' } })
  assert.match(elsewhere.problem, /找不到要运行的程序：python3/)
})

test('Windows: a name without an extension finds the runnable one first, as npm leaves a sh script beside its .cmd', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-win-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'mail-cli'), '#!/bin/sh')
  fs.writeFileSync(path.join(dir, 'mail-cli.cmd'), '@echo off')
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'cmd.exe' }
  const found = commandFor({ ...fake, manifest: { ...fake.manifest, run: ['mail-cli', 'list'] } }, { dataDir: 'D', platform: 'win32', env })
  assert.equal(found.value.command, 'cmd.exe')
  assert.match(found.value.args.at(-1), /mail-cli\.cmd" list"$/)
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'tool.cmd'), '')
  const local = commandFor({ dir, manifest: { ...fake.manifest, run: ['./bin/tool'] } }, { dataDir: 'D', platform: 'win32', env })
  assert.match(local.value.args.at(-1), /tool\.cmd"/)
})

test('output is read as UTF-8 across chunks: a long Chinese answer arrives whole', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-utf8-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // About 200 KB of three-byte characters: many pipe chunks, some cut through a character.
  fs.writeFileSync(path.join(dir, 'big.js'), `process.stdin.resume()
process.stdin.on('end', () => {
  const text = '告'.repeat(7000)
  process.stdout.write(JSON.stringify({ cursor: 'c', messages: Array.from({ length: 10 }, (_, i) => ({ id: 'm' + i, at: 1, text })) }) + '\\n')
})`)
  const ran = await pollSource({ dir, manifest: { ...fake.manifest, run: ['node', 'big.js'] } }, {}, null, options(t))
  assert.equal(ran.ok, true, ran.problem)
  assert.equal(ran.value.messages.length, 10)
  assert.ok(ran.value.messages.every((m) => m.text === '告'.repeat(7000)))
})
