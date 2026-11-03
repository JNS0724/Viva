import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshRuntime } from '../src/main/dsh-runtime.ts'
import { launcherText, pnpmEntry, pnpmLauncher } from '../src/main/pnpm-launcher.ts'

const ROOT = path.join(import.meta.dirname, '..')

test('the launcher runs the pnpm shipped with the app on the app\'s own runtime', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-pnpm-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const launcher = pnpmLauncher({ dir, appRoot: ROOT, runtime })
  assert.ok(launcher, 'the app ships pnpm')
  const version = execFileSync(launcher, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
  assert.equal(version, JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'pnpm', 'package.json'), 'utf8')).version)
  const written = fs.statSync(launcher).mtimeMs
  pnpmLauncher({ dir, appRoot: ROOT, runtime })
  assert.equal(fs.statSync(launcher).mtimeMs, written, 'unchanged, not rewritten')
})

test('Electron runs as Node in the launcher; quotes in paths are kept', () => {
  const posix = launcherText({ runtime: { nodeBin: "/Apps/Vi'va", electron: true }, entry: '/a b/pnpm.mjs', platform: 'darwin' })
  assert.equal(posix, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '/Apps/Vi'\\''va' '/a b/pnpm.mjs' "$@"\n`)
  assert.equal(launcherText({ runtime: { nodeBin: 'node', electron: false }, entry: '/p.mjs', platform: 'linux' }), `#!/bin/sh\nexec 'node' '/p.mjs' "$@"\n`)
  const windows = launcherText({ runtime: { nodeBin: 'C:\\Viva\\Viva.exe', electron: true }, entry: 'C:\\p\\pnpm.mjs', platform: 'win32' })
  assert.equal(windows, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Viva\\Viva.exe" "C:\\p\\pnpm.mjs" %*\r\n')
})

test('pnpm is read from outside app.asar when the package was unpacked there, and missing pnpm gives none', (t) => {
  // Electron's fs reads a folder named app.asar as an archive (and on Windows will not make one): a plain folder here.
  const electron = process as { noAsar?: boolean }
  const noAsar = electron.noAsar
  electron.noAsar = true
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-pnpm-asar-'))
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    electron.noAsar = noAsar
  })
  const asar = path.join(dir, 'app.asar')
  fs.mkdirSync(path.join(asar, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  fs.writeFileSync(path.join(asar, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ bin: { pnpm: 'bin/pnpm.mjs' } }))
  const unpacked = path.join(dir, 'app.asar.unpacked', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  assert.equal(pnpmEntry(asar, (file) => file === unpacked), unpacked)
  assert.equal(pnpmEntry(asar, () => false), null)
  assert.equal(pnpmEntry(path.join(dir, 'nowhere')), null)
})
