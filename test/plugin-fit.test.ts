import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { WEB_HOST, vivaFit } from '../src/backend/plugin-fit.ts'

/** What a dsh plugin's package.json says of it working in Viva (plugin-fit.ts): only what is known. */

const manifest = (name: string): { dependencies?: object, peerDependencies?: object } =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
const needed = (name: string) => Object.keys({ ...manifest(name).dependencies, ...manifest(name).peerDependencies })

test('the browser host is what dsh\'s Web app brings and Viva\'s ACP composition does not', () => {
  assert.ok(needed('@deepseek-ai/dsh-web-app').includes('@deepseek-ai/dsh-host-webserver'))
  const composed = [...needed('@deepseek-ai/dsh-base'), ...needed('@deepseek-ai/dsh-acp-app')]
  assert.deepEqual(WEB_HOST.filter((name) => composed.includes(name)), [])
})

test('a plugin needing the browser host does not work in Viva: said with what it needs', () => {
  assert.deepEqual(vivaFit({ peerDependencies: { '@deepseek-ai/dsh-host-webserver': '0.2.0-rc.2', '@deepseek-ai/dsh-session': '0.2.0-rc.2' } }),
    { kind: 'needs-web', needs: ['@deepseek-ai/dsh-host-webserver'] })
  assert.deepEqual(vivaFit({ dependencies: { '@deepseek-ai/dsh-web-app': '1' } }), { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web-app'] })
})

test('what dsh-base brings Viva has too: web search and fetch (dsh-web), the API gateway', () => {
  const base = needed('@deepseek-ai/dsh-base')
  for (const name of ['@deepseek-ai/dsh-web', '@deepseek-ai/dsh-api-gateway']) {
    assert.ok(base.includes(name), `${name} is in dsh-base`)
    assert.deepEqual(vivaFit({ peerDependencies: { [name]: '1' } }), { kind: 'no-conflict' })
  }
})

test('one with a part for dsh\'s Web client: that part is not shown; one with neither: nothing known against it', () => {
  assert.deepEqual(vivaFit({ dsh: { bundle: { patch: 'p.yml' }, client: { platform: 'web' } } }), { kind: 'web-part' })
  assert.deepEqual(vivaFit({ dsh: { bundle: { patch: 'p.yml' } }, peerDependencies: { '@deepseek-ai/cordis': '~4.0.4' } }), { kind: 'no-conflict' })
})

test('its author saying it supports Viva is taken as said; a manifest that cannot be read says nothing either way', () => {
  assert.deepEqual(vivaFit({ viva: { supports: true }, peerDependencies: { '@deepseek-ai/dsh-host-webserver': '1' } }), { kind: 'declared' })
  assert.deepEqual(vivaFit(null), { kind: 'unknown' })
  assert.deepEqual(vivaFit('not a manifest'), { kind: 'unknown' })
})
