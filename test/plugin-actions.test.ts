import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createPluginActions } from '../src/renderer/plugin-actions.ts'
import { sourceFormVersion } from '../src/renderer/view/plugin-source.ts'

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
