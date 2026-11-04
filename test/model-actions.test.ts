import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelActions, type ProviderForm } from '../src/renderer/model-actions.ts'
import { adoptPicked, openDraft, shownDiscovered, type ModelDraft } from '../src/renderer/model-state.ts'
import { initialState, reduce } from '../src/renderer/state.ts'

/** The 模型 form (my-agent-workspace#9): a row per model, 获取可用模型 to pick from, and editing a provider. */

const PROVIDER = { id: 'custom-a', name: 'Gateway', api: 'openai-completions', baseURL: 'https://gw.example/v1', keyHint: '••••abcd',
  models: [{ id: 'glm-5.2', contextWindow: 131072, image: true }, { id: 'kimi-k2.6' }] }
const FOUND = [{ id: 'qwen3:8b', name: 'qwen3:8b', contextWindow: 40960 }, { id: 'glm-5.2', name: 'GLM 5.2' }, { id: 'llama4', name: 'Llama 4', maxTokens: 8192 }]
const ENDPOINT = { api: 'openai-completions', baseURL: 'https://gw.example/v1', key: '' }

function setup(api: Partial<AgentApi> = {}) {
  let state = reduce(initialState as State, { type: 'models_loaded', view: { providers: [PROVIDER], protocols: {}, defaults: { contextWindow: 262144, maxTokens: 32768 } } })
  const actions = createModelActions({
    api: api as AgentApi, getState: () => state, dispatch: (action) => { state = reduce(state, action) }, errorMessage: (err) => (err as Error).message,
  })
  return { actions, state: () => state, draft: () => state.models.draft as ModelDraft }
}

const FORM: ProviderForm = { name: 'Gateway', api: 'openai-completions', baseURL: 'https://gw.example/v1', key: '', models: [{ id: 'glm-5.2', contextWindow: '', maxTokens: '', image: false }] }

test('a new provider opens with one empty row; editing one opens its models, each time with fields started afresh', () => {
  const fresh = openDraft(1, null)
  assert.deepEqual([fresh.editing, fresh.rows, fresh.nextKey, fresh.version], [null, [{ key: 0, id: '' }], 1, 1])
  const editing = openDraft(2, PROVIDER)
  assert.deepEqual([editing.editing, editing.rows, editing.nextKey, editing.version], [
    'custom-a', [{ key: 0, id: 'glm-5.2', contextWindow: 131072, image: true }, { key: 1, id: 'kimi-k2.6' }], 2, 2,
  ])
})

test('rows are added and removed by key; the form closes on cancel, and nothing changes while none is open', () => {
  const { actions, state, draft } = setup()
  actions.addModelRow()
  assert.equal(state().models.draft, null, 'no form, nothing to add to')
  actions.openProviderForm()
  actions.addModelRow()
  actions.addModelRow()
  actions.removeModelRow(1)
  assert.deepEqual(draft().rows.map((row) => row.key), [0, 2])
  actions.closeProviderForm()
  assert.equal(state().models.draft, null)
})

test('saving adds a new provider, or changes the one edited', async () => {
  const calls: unknown[][] = []
  const { actions, state } = setup({
    addModelProvider: async (form) => { calls.push(['add', form]); return { providers: [], added: 'Gateway' } },
    updateModelProvider: async (id, form) => { calls.push(['update', id, form]); return { providers: [PROVIDER], updated: 'Gateway' } },
  })
  actions.openProviderForm()
  await actions.saveProvider(FORM)
  actions.openProviderForm(PROVIDER)
  await actions.saveProvider({ ...FORM, key: '' })
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [['add', FORM], ['update', 'custom-a']])
  assert.match(state().models.notice ?? '', /Gateway/)
  assert.equal(state().models.draft, null, 'saved closes the form')
})

test('获取可用模型 asks with the form endpoint, and with the provider edited so its own key serves when none is typed', async () => {
  const asked: unknown[][] = []
  const { actions, draft } = setup({ discoverModels: async (endpoint, providerId) => { asked.push([endpoint, providerId]); return { models: FOUND } } })
  actions.openProviderForm(PROVIDER)
  await actions.discoverModels(ENDPOINT)
  assert.deepEqual(asked, [[ENDPOINT, 'custom-a']])
  assert.deepEqual([draft().discovery.busy, draft().discovery.found?.length, draft().discovery.error], [false, 3, null])
})

test('a failure shows in the form; an answer for a form since opened again is dropped', async () => {
  let answer: (value: { models: typeof FOUND }) => void = () => {}
  const { actions, draft } = setup({ discoverModels: () => new Promise((done) => { answer = done }) })
  actions.openProviderForm()
  const pending = actions.discoverModels(ENDPOINT)
  assert.equal(draft().discovery.busy, true)
  actions.openProviderForm(PROVIDER)
  answer({ models: FOUND })
  await pending
  assert.equal(draft().discovery.found, null, 'the answer was for the form before')

  // Closed, then opened for another provider: the version is new, so the first form's answer still does not land.
  const again = setup({ discoverModels: () => new Promise((done) => { answer = done }) })
  again.actions.openProviderForm()
  const first = again.actions.discoverModels(ENDPOINT)
  again.actions.closeProviderForm()
  again.actions.openProviderForm(PROVIDER)
  assert.equal(again.draft().version, 2, 'a version is never used twice')
  answer({ models: FOUND })
  await first
  assert.deepEqual([again.draft().discovery.found, again.draft().rows.map((row) => row.id)], [null, ['glm-5.2', 'kimi-k2.6']])

  const failing = setup({ discoverModels: async () => { throw new Error('接口拒绝了这个 key（401）') } })
  failing.actions.openProviderForm()
  await failing.actions.discoverModels({ ...ENDPOINT, key: 'sk-bad' })
  assert.deepEqual([failing.draft().discovery.busy, failing.draft().discovery.error], [false, '接口拒绝了这个 key（401）'])
  assert.equal(failing.state().models.error, null, 'the section itself has no error')
})

test('what was found is searched by id or name, picked, and joins the rows as typed: empty rows give way, no model twice', async () => {
  const { actions, draft } = setup({ discoverModels: async () => ({ models: FOUND }) })
  actions.openProviderForm(PROVIDER)
  await actions.discoverModels(ENDPOINT)
  actions.searchDiscovered('LLAMA')
  assert.deepEqual(shownDiscovered(draft().discovery).map((model) => model.id), ['llama4'])
  actions.searchDiscovered('glm')
  assert.deepEqual(shownDiscovered(draft().discovery).map((model) => model.id), ['glm-5.2'])
  for (const id of ['qwen3:8b', 'glm-5.2', 'llama4', 'llama4', 'llama4']) actions.pickDiscovered(id)
  assert.deepEqual(draft().discovery.picked, ['qwen3:8b', 'glm-5.2', 'llama4'], 'a second pick unpicks')

  // As typed now: the first row's window changed, the second emptied, and a blank row added.
  actions.adoptDiscovered([{ key: 0, id: 'glm-5.2', contextWindow: 200000 }, { key: 1, id: '' }, { key: 2, id: ' ' }])
  assert.deepEqual(draft().rows, [
    { key: 0, id: 'glm-5.2', contextWindow: 200000 },
    { key: 2, id: 'qwen3:8b', contextWindow: 40960 },
    { key: 3, id: 'llama4', maxTokens: 8192 },
  ])
  assert.deepEqual([draft().nextKey, draft().discovery.found], [4, null], 'the picker closes')
})

test('adopting with nothing picked keeps the rows as typed; closing the picker keeps the rows', async () => {
  const draft: ModelDraft = { ...openDraft(1, null), discovery: { busy: false, error: null, found: FOUND, query: '', picked: [] } }
  assert.deepEqual(adoptPicked(draft, [{ key: 0, id: 'mine' }]).rows, [{ key: 0, id: 'mine' }])

  const { actions, draft: current } = setup({ discoverModels: async () => ({ models: FOUND }) })
  actions.openProviderForm(PROVIDER)
  await actions.discoverModels(ENDPOINT)
  actions.closeDiscovered()
  assert.deepEqual([current().discovery.found, current().rows.length], [null, 2])
})
