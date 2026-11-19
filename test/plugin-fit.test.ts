import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { WEB_HOST, vivaFit } from '../src/backend/plugin-fit.ts'

/** What a dsh plugin's package.json says of it working in Viva (plugin-fit.ts): only what is known. */

const manifest = (name: string): { dependencies?: object, peerDependencies?: object } =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
const needed = (name: string) => Object.keys({ ...manifest(name).dependencies, ...manifest(name).peerDependencies })
const runtime = getDshRuntimeVersion()
const webHost = '@deepseek-ai/dsh-host-webserver'
const pkg = { name: 'example-plugin', version: '1.0.0' }

test('the browser host is what dsh\'s Web app brings and Viva\'s ACP composition does not', () => {
  assert.ok(needed('@deepseek-ai/dsh-web-app').includes('@deepseek-ai/dsh-host-webserver'))
  const composed = [...needed('@deepseek-ai/dsh-base'), ...needed('@deepseek-ai/dsh-acp-app')]
  assert.deepEqual(WEB_HOST.filter((name) => composed.includes(name)), [])
})

test('a plugin needing the browser host does not work in Viva: said with what it needs', () => {
  assert.deepEqual(vivaFit({ peerDependencies: { [webHost]: runtime, '@deepseek-ai/dsh-session': runtime } }),
    { kind: 'needs-web', needs: [webHost] })
  assert.deepEqual(vivaFit({ dependencies: { '@deepseek-ai/dsh-web-app': '1' } }), { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web-app'] })
})

test('optional Web peers and optional dependencies do not require the browser host', () => {
  assert.deepEqual(vivaFit({ peerDependencies: { [webHost]: runtime }, peerDependenciesMeta: { [webHost]: { optional: true } } }), { kind: 'no-conflict' })
  assert.deepEqual(vivaFit({ dependencies: { [webHost]: runtime }, optionalDependencies: { [webHost]: runtime } }), { kind: 'no-conflict' })
  assert.deepEqual(vivaFit({ ...pkg, peerDependencies: { [webHost]: '99.0.0' }, peerDependenciesMeta: { [webHost]: { optional: true } } }),
    { kind: 'dsh-version', current: runtime, requirements: { [webHost]: '99.0.0' } }, 'DSH still checks the optional peer version')
})

test('what dsh-base brings Viva has too: web search and fetch (dsh-web), the API gateway', () => {
  const base = needed('@deepseek-ai/dsh-base')
  for (const name of ['@deepseek-ai/dsh-web', '@deepseek-ai/dsh-api-gateway']) {
    assert.ok(base.includes(name), `${name} is in dsh-base`)
    assert.deepEqual(vivaFit({ peerDependencies: { [name]: runtime } }), { kind: 'no-conflict' })
  }
})

test('one with a part for dsh\'s Web client: that part is not shown; one with neither: nothing known against it', () => {
  assert.deepEqual(vivaFit({ dsh: { bundle: { patch: 'p.yml' }, client: { platform: 'web' } } }), { kind: 'web-part' })
  assert.deepEqual(vivaFit({ dsh: { bundle: { patch: 'p.yml' } }, peerDependencies: { '@deepseek-ai/cordis': '~4.0.4' } }), { kind: 'no-conflict' })
})

test('developer declarations do not override version requirements or Web dependencies', () => {
  const declared = { ...pkg, viva: { supports: true } }
  assert.deepEqual(vivaFit(declared), { kind: 'declared' })
  assert.deepEqual(vivaFit({ ...declared, dependencies: { [webHost]: runtime } }), { kind: 'needs-web', needs: [webHost] })
  assert.deepEqual(vivaFit({ ...declared, dsh: { client: { platform: 'web' } } }), { kind: 'web-part' })
  assert.deepEqual(vivaFit({ ...declared, engines: { dsh: '>=99' } }), { kind: 'dsh-version', current: runtime, requirements: { 'engines.dsh': '>=99' } })
})

test('the preflight applies the runtime engines precedence and exact-version exemptions', () => {
  const peers = { '@deepseek-ai/dsh-tools': '^0.1.0' }
  assert.deepEqual(vivaFit({ ...pkg, peerDependencies: peers }), { kind: 'dsh-version', current: runtime, requirements: peers })
  assert.deepEqual(vivaFit({ ...pkg, peerDependencies: peers, engines: { dsh: runtime } }), { kind: 'no-conflict' })
  assert.deepEqual(vivaFit({ ...pkg, peerDependencies: peers }, { exemptions: { 'example-plugin@1.0.0': [runtime] } }), { kind: 'no-conflict' })
  assert.deepEqual(vivaFit({ ...pkg, peerDependencies: peers }, { runtimeVersion: null }), { kind: 'unknown' })
  assert.deepEqual(vivaFit({ ...pkg, engines: { dsh: 99 } }), { kind: 'unknown' })
  assert.deepEqual(vivaFit(null), { kind: 'unknown' })
  assert.deepEqual(vivaFit('not a manifest'), { kind: 'unknown' })
})
