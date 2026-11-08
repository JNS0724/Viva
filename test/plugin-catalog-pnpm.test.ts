import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshRuntime } from '../src/backend/dsh-runtime.ts'
import { pnpmRunner, searchCatalog, specFit, type PnpmCall } from '../src/backend/plugin-catalog.ts'
import { authVariable, pinArgs, pnpmScopes } from '../src/backend/plugin-registry.ts'
import { pnpmLauncher } from '../src/backend/pnpm-launcher.ts'
import { startFakeRegistry, type FakePackage } from './fixtures/fake-registry.ts'

/**
 * The company source's plugins through the pnpm the app ships (11), as compose.ts runs it for the catalog: its search
 * and each package's package.json asked of the company source with its token, a scope another .npmrc sends elsewhere
 * asked of the company source too.
 */
const TOKEN = 'npm_catalog_token'

const bundle = { bundle: { patch: 'patch.yml' } }
const PACKAGES: Record<string, FakePackage> = {
  '@company/dsh-notes': { name: '@company/dsh-notes', version: '1.2.0', description: 'Notes for the team', dsh: bundle },
  'dsh-web-panel': { name: 'dsh-web-panel', version: '0.3.0', description: 'A panel', dsh: bundle, dependencies: { '@deepseek-ai/dsh-web-app': '^1' } },
  'left-pad': { name: 'left-pad', version: '1.3.0', description: 'Not a plugin' },
}

test('real pnpm: the source\'s dsh plugins are listed with whether they work in Viva, asked of the company source with its token', { timeout: 120_000 }, async (t) => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-plugin-catalog-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const company = await startFakeRegistry(PACKAGES)
  const elsewhere = await startFakeRegistry({})
  t.after(() => Promise.all([company.close(), elsewhere.close()]))
  const home = path.join(dir, 'home')
  const profile = path.join(dir, 'profile')
  fs.mkdirSync(path.join(home, '.config'), { recursive: true })
  fs.mkdirSync(profile)
  fs.writeFileSync(path.join(profile, '.npmrc'), `@company:registry=${elsewhere.url}\n`)
  fs.writeFileSync(path.join(profile, 'package.json'), '{"name":"profile","version":"1.0.0","private":true}\n')
  // Run by npm, the tests have its npm_config_* (npm_config_userconfig among them), which would point pnpm at the real ~/.npmrc.
  const unsteered = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)))
  const env = { ...unsteered, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') }
  const launcher = pnpmLauncher({ dir: path.join(dir, 'bin'), appRoot: root, runtime: dshRuntime({ env: process.env, execPath: process.execPath }) })
  assert.ok(launcher, 'the app ships pnpm')

  // As compose.ts pnpmCallFor: the scopes pnpm knows pinned to the company source, its token in pnpm's environment.
  const scopes = pnpmScopes({ command: launcher, cwd: profile, env })
  const pnpm: PnpmCall = { command: launcher, cwd: profile, args: [...pinArgs(company.url, scopes), `--registry=${company.url}`], env: { ...env, [authVariable(company.url)]: TOKEN } }
  const run = pnpmRunner()

  const answer = await searchCatalog({ query: '', pnpm, run })
  assert.deepEqual(answer, {
    ok: true,
    entries: [
      { name: '@company/dsh-notes', version: '1.2.0', description: 'Notes for the team', fit: { kind: 'no-conflict' } },
      { name: 'dsh-web-panel', version: '0.3.0', description: 'A panel', fit: { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web-app'] } },
    ],
  }, JSON.stringify(company.asked))
  assert.deepEqual(await specFit({ spec: 'dsh-web-panel@0.3.0', pnpm, run }), { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web-app'] })

  assert.ok(company.asked.some((request) => request.url.startsWith('/-/v1/search?text=dsh')), JSON.stringify(company.asked))
  assert.ok(company.asked.length > 0 && company.asked.every((request) => request.auth === `Bearer ${TOKEN}`), JSON.stringify(company.asked))
  assert.deepEqual(elsewhere.asked, [], 'a scope another .npmrc names is asked of the company source')
})
