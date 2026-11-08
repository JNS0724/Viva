import { initialState, reduce } from '../src/renderer/state.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPluginActions } from '../src/renderer/plugin-actions.ts'
import { catalogPick, problemText } from '../src/renderer/plugins-state.ts'
import { initialPlugins, PLUGIN_ACTIONS } from '../src/renderer/plugins-state.ts'
import { setLocale } from '../src/shared/i18n/locale.ts'

type Plugins = State['plugins']
const start = (changes: Partial<Plugins> = {}): State => ({ ...initialState, plugins: { ...initialPlugins, loaded: true, ...changes } })

test('the reducers return new state and leave the old one as it was', () => {
  const before = start()
  const typed = reduce(before, { type: 'plugins_spec', spec: 'compact' })
  assert.notEqual(typed, before)
  assert.equal(before.plugins.spec, '')
  assert.equal(typed.plugins.spec, 'compact')
  const found = reduce(reduce(typed, { type: 'plugins_busy' }), { type: 'plugins_inspected', inspection: { ok: true, name: 'compact' } })
  assert.deepEqual([found.plugins.busy, found.plugins.inspection.name], [false, 'compact'])
  assert.ok(Object.isFrozen(initialPlugins))
})

test('an install that asks for build scripts stays open; one that is done clears the form', () => {
  const asked = reduce(start({ spec: 'compact', inspection: { ok: true } }), { type: 'plugins_changed', view: { plugins: [] }, pendingBuilds: ['esbuild'] })
  assert.deepEqual([asked.plugins.spec, asked.plugins.pendingBuilds], ['compact', ['esbuild']])
  const done = reduce(asked, { type: 'plugins_changed', view: { plugins: [{ name: 'compact' }] }, notice: 'ok' })
  assert.deepEqual([done.plugins.spec, done.plugins.inspection, done.plugins.pendingBuilds, done.plugins.notice], ['', null, [], 'ok'])
  assert.equal(done.plugins.plugins.length, 1)
  const typedAgain = reduce(asked, { type: 'plugins_spec', spec: 'other' })
  assert.deepEqual(typedAgain.plugins.pendingBuilds, [], 'another spec forgets what the first one asked')
})

/** The actions against a fake main process, with the reducers for state. */
function harness(api: Record<string, (...args: unknown[]) => Promise<unknown>>, initial = start()) {
  let state = initial
  const calls: unknown[][] = []
  const spied = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args: unknown[]) => { calls.push([name, ...args]); return fn(...args) }]))
  const actions = createPluginActions({
    api: spied as unknown as AgentApi, getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return { actions, calls, state: () => state }
}

test('a spec is looked up before it is installed, and the build scripts it asks for are allowed on the second try', async () => {
  setLocale('en')
  const answers = [
    { change: { changed: false, application: 'applied', error: null, pendingBuilds: ['esbuild'] }, view: { connected: true, plugins: [] } },
    { change: { changed: true, application: 'applied', error: null, pendingBuilds: [] }, view: { connected: true, plugins: [{ name: 'compact' }] } },
  ]
  const { actions, calls, state } = harness({
    inspectPlugin: async () => ({ ok: true, name: 'compact', version: '2.0.0', bundle: true }),
    installPlugin: async () => answers.shift(),
  })
  await actions.inspectPlugin()
  assert.equal(state().plugins.error, 'Enter an npm package name, a git address, or a folder.')
  actions.editPluginSpec(' compact ')
  await actions.inspectPlugin()
  assert.equal(state().plugins.inspection.version, '2.0.0')
  await actions.installPlugin()
  assert.deepEqual(state().plugins.pendingBuilds, ['esbuild'])
  await actions.installPlugin()
  assert.deepEqual(calls, [['inspectPlugin', 'compact'], ['installPlugin', 'compact', undefined], ['installPlugin', 'compact', ['esbuild']]])
  assert.equal(state().plugins.notice, 'Done. It takes effect in new conversations.')
  assert.equal(state().plugins.spec, '')
  setLocale('zh-CN')
})

test('dsh\'s refusals are put in the user\'s words; a change that failed still shows the list as it is', async () => {
  setLocale('en')
  assert.equal(problemText('not-found'), 'No such package was found.')
  assert.equal(problemText('stop-profile', 'profile busy'), 'The plugin manager could not do that: profile busy')
  const { actions, state } = harness({
    inspectPlugin: async () => ({ ok: false, problem: 'network' }),
    setPluginEnabled: async () => ({ change: { changed: false, application: 'failed', error: { code: 'incompatible-version', detail: null }, pendingBuilds: [] }, view: { connected: true, plugins: [{ name: 'x' }] } }),
  }, start({ spec: 'x' }))
  await actions.inspectPlugin()
  assert.match(state().plugins.error ?? '', /package registry/)
  await actions.setPluginEnabled('x', true)
  assert.equal(state().plugins.error, 'This plugin does not support the dsh version in Viva.')
  assert.equal(state().plugins.plugins.length, 1)
  setLocale('zh-CN')
})

test('a lookup of one the source listed belongs under that one, not under the install field', () => {
  const entries = [{ name: 'dsh-notes', version: '1.2.0', description: null, fit: { kind: 'unknown' } }]
  const listed = start({ catalog: { ...initialPlugins.catalog, searched: true, entries } })
  const looked = { ok: true, name: 'dsh-notes', version: '1.2.0', bundle: true }
  assert.equal(catalogPick({ ...listed.plugins, spec: 'dsh-notes@1.2.0', inspection: looked }), 'dsh-notes')
  assert.equal(catalogPick({ ...listed.plugins, spec: 'dsh-notes@1.2.0', pendingBuilds: ['esbuild'] }), 'dsh-notes', 'its build scripts asked for there too')
  assert.equal(catalogPick({ ...listed.plugins, spec: 'dsh-notes@1.2.0' }), null, 'nothing looked up yet')
  assert.equal(catalogPick({ ...listed.plugins, spec: 'dsh-notes', inspection: looked }), null, 'typed by name: under the field')
  assert.equal(catalogPick({ ...start().plugins, spec: 'dsh-notes@1.2.0', inspection: looked }), null, 'nothing listed')
})
