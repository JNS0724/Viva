import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changeView, inspectionView, pluginsView, registerPluginsIpc } from '../src/backend/plugins-ipc.ts'
import type { PluginsResult } from '../src/backend/plugins-channel.ts'

function profile(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-plugins-ipc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pkg = (name: string, manifest: object) => {
    fs.mkdirSync(path.join(dir, 'node_modules', ...name.split('/')), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ name, ...manifest }))
  }
  pkg('@someone/search', { dsh: { bundle: { patch: 'p.yml' }, client: { platform: 'web' } } })
  pkg('compact', { dsh: { bundle: { patch: 'p.yml' } } })
  return dir
}

const LIST = {
  bundles: [
    { name: '@deepseek-ai/dsh-base', installed: false, enabled: true, optional: false, removable: false, rows: [], overrides: [] },
    {
      name: '@someone/search', version: '1.2.0', description: 'Search', installed: true, enabled: true, optional: false, removable: true,
      rows: [{ rowId: 'search', moduleName: '@someone/search', entryId: 'e1' }, { rowId: 'search-ui', moduleName: '@someone/search/ui', entryId: 'e2' }],
      overrides: ['web-search'],
    },
    { name: 'compact', installed: true, enabled: false, optional: false, removable: true, rows: [{ rowId: 'c', moduleName: 'compact' }], overrides: [], error: { code: 'incompatible-version', diagnostic: 'needs 0.3' } },
  ],
  plugins: [{ entryId: 'e1', enabled: true, fiberPhase: 'active' }, { entryId: 'e2', enabled: true, fiberPhase: 'pending' }],
}

test('the section lists the plugins the user installed, each row as it runs, and which bring a Web interface', (t) => {
  const dir = profile(t)
  const [search, compact, ...rest] = pluginsView(LIST, dir)
  assert.equal(rest.length, 0, 'dsh\'s own bundles are not listed')
  assert.deepEqual(search, {
    name: '@someone/search', version: '1.2.0', description: 'Search', enabled: true, removable: true, error: null, webUi: true,
    rows: [{ id: 'search', entryId: 'e1', enabled: true, phase: 'active' }, { id: 'search-ui', entryId: 'e2', enabled: true, phase: 'pending' }],
    overrides: ['web-search'],
  })
  assert.equal(compact.webUi, false)
  assert.deepEqual(compact.error, { code: 'incompatible-version', detail: 'needs 0.3' })
  assert.deepEqual(compact.rows, [{ id: 'c', entryId: null, enabled: false, phase: null }])
  assert.deepEqual(pluginsView(null, dir), [], 'nothing usable, nothing listed')
})

test('what a change did, and what an inspection found, are kept to what the section shows', () => {
  assert.deepEqual(changeView({ changed: true, application: 'applied', stage: 'install', target: 'x', pendingBuilds: ['esbuild'] }),
    { changed: true, application: 'applied', error: null, pendingBuilds: ['esbuild'] })
  assert.deepEqual(changeView({}), { changed: false, application: 'failed', error: null, pendingBuilds: [] })
  assert.deepEqual(inspectionView({ status: 'accepted', kind: 'registry', name: 'n', version: '1', bundle: false }), { ok: true, name: 'n', version: '1', description: null, bundle: false })
  assert.deepEqual(inspectionView({ status: 'refused', problem: 'not-found' }), { ok: false, problem: 'not-found' })
})

test('the channels ask the plugin manager; with dsh down the section says it is not connected', async (t) => {
  const dir = profile(t)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const asked: unknown[][] = []
  let up = true
  const call = async (op: string, args?: Record<string, unknown>): Promise<PluginsResult> => {
    asked.push([op, args])
    if (!up) return { ok: false, problem: 'disconnected' }
    if (op === 'list') return { ok: true, value: LIST }
    if (op === 'inspect') return { ok: true, value: { status: 'accepted', name: 'compact', version: '2.0.0', bundle: true } }
    return { ok: true, value: { changed: true, application: 'applied' } }
  }
  registerPluginsIpc({ handle: (channel, fn) => handlers.set(channel, fn as (...args: unknown[]) => unknown) }, { call, profileDir: () => dir })
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
  assert.deepEqual([...handlers.keys()].sort(), ['plugins:get', 'plugins:inspect', 'plugins:install', 'plugins:remove', 'plugins:set-enabled'])

  assert.equal(((await invoke('plugins:get')) as { plugins: unknown[] }).plugins.length, 2)
  assert.deepEqual(await invoke('plugins:inspect', 'compact'), { ok: true, name: 'compact', version: '2.0.0', description: null, bundle: true })
  const installed = await invoke('plugins:install', 'compact', ['esbuild']) as { change: { application: string }, view: { plugins: unknown[] } }
  assert.equal(installed.change.application, 'applied')
  assert.equal(installed.view.plugins.length, 2, 'the list as it is after the change')
  await invoke('plugins:set-enabled', 'compact', true)
  await invoke('plugins:remove', 'compact')
  assert.deepEqual(asked.filter(([op]) => op !== 'list'), [
    ['inspect', { spec: 'compact' }], ['install', { spec: 'compact', approvedBuilds: ['esbuild'] }],
    ['setBundle', { name: 'compact', enabled: true }], ['remove', { name: 'compact' }],
  ])

  up = false
  assert.deepEqual(await invoke('plugins:get'), { connected: false, plugins: [] })
  await assert.rejects(Promise.resolve(invoke('plugins:remove', 'compact')), /disconnected/)
})
