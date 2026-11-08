import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchMessage, packageManagerOf } from '../src/backend/dsh-launch.ts'
import { dshRuntime } from '../src/backend/dsh-runtime.ts'
import { pnpmScopes } from '../src/backend/plugin-registry.ts'
import { pnpmEntry, pnpmLauncher } from '../src/backend/pnpm-launcher.ts'

/**
 * The company registry with the pnpm the app ships (11): what dsh's plugin manager is handed (dsh-launch.ts) gets the
 * token to the registry, and keeps a scope another .npmrc sends elsewhere asking the company registry instead.
 */
const TOKEN = 'npm_real_pnpm_token'
const execFileAsync = promisify(execFile)

/** A registry that writes down what it is asked and with what token, and has nothing. */
async function registry(t: TestContext) {
  const asked: Array<{ url: string, auth: string | null }> = []
  const server = http.createServer((req, res) => {
    asked.push({ url: req.url ?? '', auth: req.headers.authorization ?? null })
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, asked }
}

test('real pnpm: the token reaches the company registry, and scopes set elsewhere in any .npmrc ask it too', { timeout: 120_000 }, async (t) => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-plugin-registry-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const company = await registry(t)
  const elsewhere = await registry(t)
  const home = path.join(dir, 'home')
  const profile = path.join(dir, 'profile')
  fs.mkdirSync(path.join(home, '.config'), { recursive: true })
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(home, '.npmrc'), `@mine:registry=${elsewhere.url}\n`)
  fs.writeFileSync(path.join(profile, '.npmrc'), `@company:registry=${elsewhere.url}\n`)
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"profile","version":"1.0.0","private":true}\n')
  // Run by npm, the tests have its npm_config_* (npm_config_userconfig among them), which would point pnpm at the real ~/.npmrc.
  const unsteered = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)))
  const env = { ...unsteered, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') }
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const launcher = pnpmLauncher({ dir: path.join(dir, 'bin'), appRoot: root, runtime })
  const entry = pnpmEntry(root)
  assert.ok(launcher && entry, 'the app ships pnpm')

  const scopes = pnpmScopes({ command: launcher, cwd: profile, env })
  assert.ok(['@mine', '@company'].every((scope) => scopes.includes(scope)), JSON.stringify(scopes))
  const pnpm = packageManagerOf(launchMessage({ pnpmCommand: launcher, registry: company.url, registryToken: TOKEN, scopes }))!
  // Asynchronously: the registries answer from this process, which a synchronous child would hold up.
  for (const spec of ['@company/search', '@mine/tool']) {
    await execFileAsync(runtime.nodeBin, [entry, ...pnpm.args, 'add', spec, `--registry=${company.url}`], {
      cwd: profile, env: { ...env, ...pnpm.env, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, timeout: 60_000,
    }).catch(() => {}) // the registries have nothing: pnpm fails, after asking
  }
  const packages = company.asked.filter((request) => request.url.startsWith('/@'))
  assert.deepEqual(packages.map((request) => request.url.toLowerCase()).sort(), ['/@company%2fsearch', '/@mine%2ftool'], JSON.stringify(company.asked))
  assert.ok(packages.every((request) => request.auth === `Bearer ${TOKEN}`), JSON.stringify(packages))
  assert.deepEqual(elsewhere.asked, [], 'no scope is taken from the registry another .npmrc names')
  for (const file of [path.join(home, '.npmrc'), path.join(profile, '.npmrc')]) assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN), file)
})
