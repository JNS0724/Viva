import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createPluginActions } from '../src/renderer/plugin-actions.ts'
import { PLUGIN_SOURCE, sourceFormVersion } from '../src/renderer/view/plugin-source.ts'
import { pluginPane } from '../src/renderer/view/capability-plugins.ts'
import { setLocale } from '../src/shared/i18n/locale.ts'

/** 能力 · 插件 · 插件源 (plugin-actions.ts): the company's registry and its token, set and taken away. */

function setup(api: Record<string, (...args: any[]) => Promise<unknown>>) {
  let state: State = initialState
  const dispatch = (action: Action) => { state = reduce(state, action) }
  const actions = createPluginActions({ api: api as never, getState: () => state, dispatch, errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)) })
  return { actions, state: () => state }
}

const view = { connected: true, plugins: [] }

test('loading the section reads the source with the plugins', async () => {
  const { actions, state } = setup({ getPlugins: async () => view, getPluginSource: async () => ({ registry: 'https://npm.example.com/', hasToken: true }) })
  await actions.loadPlugins()
  assert.deepEqual(state().plugins.source, { registry: 'https://npm.example.com/', hasToken: true })
})

test('saved: the address trimmed, a token left blank kept as it is, what was done said', async () => {
  const asked: unknown[][] = []
  const { actions, state } = setup({
    setPluginSource: async (registry, token) => { asked.push([registry, token]); return { source: { registry: 'https://npm.example.com/', hasToken: true }, view } },
  })
  await actions.savePluginSource(' https://npm.example.com ', 'npm_secret_value')
  await actions.savePluginSource('https://npm.example.com/', '')
  assert.deepEqual(asked, [['https://npm.example.com', 'npm_secret_value'], ['https://npm.example.com/', undefined]])
  assert.deepEqual([state().plugins.source, Boolean(state().plugins.notice), state().plugins.busy], [{ registry: 'https://npm.example.com/', hasToken: true }, true, false])
})

test('taken away: no registry, and no token kept; a refusal says why and changes nothing', async () => {
  const asked: unknown[][] = []
  const { actions, state } = setup({ setPluginSource: async (...args) => { asked.push(args); return { source: { registry: null, hasToken: false }, view } } })
  await actions.removePluginSource()
  assert.deepEqual([asked, state().plugins.source], [[[null, '']], { registry: null, hasToken: false }])
  const refused = setup({ setPluginSource: async () => { throw new Error('插件源地址要以 https:// 开头') } })
  await refused.actions.savePluginSource('npm.example.com', '')
  assert.deepEqual([refused.state().plugins.error, refused.state().plugins.source], ['插件源地址要以 https:// 开头', null])
})

test('every save that goes through empties the token field, even one that only replaced the token; a refused one keeps what was typed', async () => {
  const answers: Array<() => unknown> = [
    () => ({ source: { registry: 'https://npm.example.com/', hasToken: true }, view }),
    () => ({ source: { registry: 'https://npm.example.com/', hasToken: true }, view }),
    () => { throw new Error('插件源地址要以 https:// 开头') },
  ]
  const { actions, state } = setup({ setPluginSource: async () => answers.shift()!() })
  await actions.savePluginSource('https://npm.example.com/', 'npm_first')
  const first = sourceFormVersion(state())
  await actions.savePluginSource('https://npm.example.com/', 'npm_second')
  const second = sourceFormVersion(state())
  assert.notEqual(second, first, 'a replaced token must not be put back into the field, or a later host change would send it there')
  await actions.savePluginSource('npm.example.com', 'npm_third')
  assert.equal(sourceFormVersion(state()), second, 'a refused save leaves the form as typed, to fix and save again')
})

test('the source stays reachable while dsh does not answer: it is kept by the app, and saving it starts dsh again', () => {
  const offline = (selected: string | null): State => ({
    ...initialState,
    plugins: { ...initialState.plugins, connected: false },
    capabilities: { ...initialState.capabilities, selected },
  })
  assert.equal(pluginPane(offline(PLUGIN_SOURCE)), 'source')
  assert.equal(pluginPane(offline(null)), 'not-connected')
  assert.equal(pluginPane({ ...offline(null), plugins: { ...initialState.plugins, connected: true } }), 'plugins')
})

test('the company source\'s plugins: searched with what is typed, one picked is looked at as name@version; what went wrong said in words', async () => {
  setLocale('en')
  const searched: unknown[] = []
  const inspected: unknown[] = []
  const entries = [{ name: 'dsh-notes', version: '1.2.0', description: 'Notes', fit: { kind: 'no-conflict' } }]
  const answers: unknown[] = [
    { ok: true, entries },
    { ok: false, problem: 'search', detail: 'ERR_PNPM_FETCH_404 Not Found' },
    { ok: false, problem: 'no-source', detail: null },
  ]
  const { actions, state } = setup({
    searchPluginCatalog: async (query) => { searched.push(query); return answers.shift() },
    inspectPlugin: async (spec) => { inspected.push(spec); return { ok: true, name: 'dsh-notes', version: '1.2.0', bundle: true, fit: { kind: 'no-conflict' } } },
  })
  actions.editCatalogQuery(' notes ')
  await actions.searchCatalog()
  assert.deepEqual([searched, state().plugins.catalog.entries, state().plugins.catalog.searching, state().plugins.catalog.searched], [[' notes '], entries, false, true])

  await actions.pickCatalogEntry('dsh-notes', '1.2.0')
  assert.deepEqual([state().plugins.spec, inspected, state().plugins.inspection.fit], ['dsh-notes@1.2.0', ['dsh-notes@1.2.0'], { kind: 'no-conflict' }])

  await actions.searchCatalog()
  assert.deepEqual([state().plugins.catalog.entries, state().plugins.catalog.problem], [[], 'Could not search the plugin source: ERR_PNPM_FETCH_404 Not Found'])
  await actions.searchCatalog()
  assert.equal(state().plugins.catalog.problem, 'Set the company plugin source first to browse its plugins.')
})

test('a source saved or taken away forgets what the last one listed', async () => {
  const { actions, state } = setup({
    searchPluginCatalog: async () => ({ ok: true, entries: [{ name: 'dsh-notes', version: '1.2.0', description: null, fit: { kind: 'unknown' } }] }),
    setPluginSource: async () => ({ source: { registry: 'https://other.example.com/', hasToken: false }, view }),
  })
  actions.editCatalogQuery('notes')
  await actions.searchCatalog()
  assert.equal(state().plugins.catalog.entries.length, 1)
  await actions.savePluginSource('https://other.example.com/', '')
  assert.deepEqual([state().plugins.catalog.entries, state().plugins.catalog.searched, state().plugins.catalog.query], [[], false, 'notes'], 'what is typed stays')
})

test('the install field shows what was put in it for the user, not what was typed before: a pick, or emptied after an install', async () => {
  const { actions, state } = setup({
    inspectPlugin: async () => ({ ok: true, name: 'dsh-notes', version: '1.2.0', bundle: true, fit: { kind: 'unknown' } }),
    installPlugin: async () => ({ change: { changed: true, application: 'applied', error: null, pendingBuilds: [] }, view }),
  })
  const typed = state().plugins.specVersion
  actions.editPluginSpec('dsh-no')
  assert.equal(state().plugins.specVersion, typed, 'typing keeps the field as typed')
  await actions.pickCatalogEntry('dsh-notes', '1.2.0')
  const picked = state().plugins.specVersion
  assert.notEqual(picked, typed, 'a pick replaces what was typed')
  await actions.installPlugin()
  assert.deepEqual([state().plugins.spec, state().plugins.specVersion !== picked], ['', true], 'installed, the field starts empty')
})
