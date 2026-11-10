import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpBridge } from '../src/backend/acp-bridge.ts'
import { installedDshVersion, PERSONA, resolvePlugins } from '../src/backend/app-plugins.ts'
import { launchMessage } from '../src/backend/dsh-launch.ts'
import { authVariable } from '../src/backend/plugin-registry.ts'
import { ensureDshProfile, vivaLayerFile } from '../src/backend/dsh-profile.ts'
import { dshEnv, dshRuntime } from '../src/backend/dsh-runtime.ts'
import { launcherText } from '../src/backend/pnpm-launcher.ts'
import { startFakeLlm } from './fixtures/fake-llm.js'
import { testRequests } from './fixtures/request-routing.ts'

/**
 * The company's plugin source with real dsh, started through the app's entry (dsh-entry.ts): the token reaches the
 * pnpm dsh's plugin manager runs, and only by the launch over IPC; the profile's files name it by a variable only.
 */
const TOKEN = 'npm_test_token_value'
const REGISTRY = 'https://npm.example.com/'

/** A pnpm that writes down how it was called and the token it was given, then answers as a registry that has nothing. */
const FAKE_PNPM = `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify({ args, token: process.env[${JSON.stringify(authVariable(REGISTRY))}] ?? null }) + '\\n')
if (args.find((arg) => !arg.startsWith('--config.')) === 'config') { console.log(${JSON.stringify(REGISTRY)}); process.exit(0) }
console.error('404 Not Found'); process.exit(1)
`

test('real dsh started by the app\'s entry hands the registry token to pnpm, and to nothing written down', { timeout: 90_000 }, async (t) => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-plugin-source-'))
  let bridge: ReturnType<typeof createAcpBridge> | undefined
  const llm = await startFakeLlm({})
  t.after(async () => {
    await bridge?.dispose()
    await llm.close()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
  const runtime = dshRuntime({ env: process.env, execPath: process.execPath })
  const log = path.join(dir, 'pnpm.log')
  fs.writeFileSync(path.join(dir, 'fake-pnpm.cjs'), FAKE_PNPM)
  const pnpm = path.join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  fs.writeFileSync(pnpm, launcherText({ runtime, entry: path.join(dir, 'fake-pnpm.cjs'), platform: process.platform }), { mode: 0o755 })

  const dshHome = path.join(dir, 'dsh-home')
  const { plugins, problems } = resolvePlugins({ codeRoot: root, userData: path.join(dir, 'userData'), dshVersion: installedDshVersion(root) })
  assert.deepEqual(problems, [])
  const profileDir = ensureDshProfile({ dshHome, profile: 'viva-source-test', plugins, persona: PERSONA, pnpmCommand: pnpm, registry: REGISTRY })

  bridge = createAcpBridge({ routing: testRequests(),
    dshBin: path.join(root, 'src', 'backend', 'dsh-entry.ts'), nodeBin: runtime.nodeBin, cwd: dir, profile: 'viva-source-test', overlay: vivaLayerFile(dshHome),
    env: dshEnv({ base: { ...process.env, FAKE_PNPM_LOG: log }, dshHome, runtime, settings: { DEEPSEEK_API_KEY: 'test-fake-key', DEEPSEEK_BASE_URL: llm.url } }),
    launch: launchMessage({ pnpmCommand: pnpm, registry: REGISTRY, registryToken: TOKEN, scopes: ['@company'] }),
    emit: () => {},
  })
  await bridge.start()
  const inspected = await bridge.plugins('inspect', { spec: '@company/search' })
  assert.ok(inspected.ok, inspected.ok ? '' : inspected.problem)

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[], token: string | null })
  assert.ok(calls.some((call) => call.args.includes('view')), JSON.stringify(calls))
  assert.ok(calls.every((call) => call.token === TOKEN), 'every pnpm call has the token')
  const views = calls.filter((call) => call.args.includes('view'))
  assert.ok(views.length && views.every((call) => call.args.includes(`--registry=${REGISTRY}`)), 'asked of the company registry')
  assert.ok(calls.every((call) => call.args[0] === `--config.@company:registry=${REGISTRY}`), 'every call sends the scope to it, first, as dsh was handed')

  assert.ok(!fs.existsSync(path.join(profileDir, '.npmrc')), 'the token is in no .npmrc, not even by a variable pnpm 11 would not expand')
  assert.ok(!fs.readFileSync(vivaLayerFile(dshHome), 'utf8').includes(TOKEN))
  assert.match(fs.readFileSync(vivaLayerFile(dshHome), 'utf8'), /"registry":"https:\/\/npm\.example\.com\/","fallbackRegistries":\[\]/)
})
