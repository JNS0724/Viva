import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../src/main/config.ts'
import { patchFor } from '../src/main/dsh-profile.ts'
import {
  createModelStore, defaultModel, keyEnvName, modelValue, parseModelValue, parseProviderInput, piAiProviders, providerEnv, providerView,
} from '../src/main/model-providers.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { scratch } from './fixtures/scratch.js'

const SAMPLE_KEY = 'sk-gateway-0000000000wxyz'
const FORM = { name: '公司网关', api: 'openai-completions', baseURL: ' https://llm.example.com/v1/ ', models: 'glm-5.2\nqwen3.8-flash, kimi-k2.6', key: ` ${SAMPLE_KEY} ` }

/** Reversible stand-in for Electron safeStorage; output never contains the plaintext. */
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decryptString: (buffer) => [...buffer.toString().slice(4)].reverse().join(''),
})

function setup(t, crypto = fakeCrypto()) {
  const { dir } = scratch(t, 'model-providers-')
  const file = path.join(dir, 'models.json')
  let next = 0
  const store = createModelStore({ file, crypto, newId: () => `custom-${String(++next).padStart(8, '0')}` })
  return { file, store }
}

test('the form is trimmed: models by line or comma, the URL without a trailing slash, the key optional', () => {
  assert.deepEqual(parseProviderInput(FORM, []), {
    name: '公司网关', api: 'openai-completions', baseURL: 'https://llm.example.com/v1', models: ['glm-5.2', 'qwen3.8-flash', 'kimi-k2.6'], key: SAMPLE_KEY,
  })
  assert.equal(parseProviderInput({ ...FORM, key: '' }, []).key, '', 'a local server needs no key')
})

test('what cannot be served is refused with the reason', () => {
  const refused = (changes, taken = []) => assert.throws(() => parseProviderInput({ ...FORM, ...changes }, taken))
  refused({}, ['公司网关'])
  refused({ name: ' ' })
  refused({ api: 'google-generative-ai' })
  refused({ baseURL: 'ftp://llm.example.com' })
  refused({ baseURL: 'https://user:pass@llm.example.com/v1' })
  refused({ baseURL: 'https://llm.example.com/v1?key=1' })
  refused({ models: '' })
  refused({ models: 'glm 5' })
  refused({ models: 'glm-5\nglm-5' })
  refused({ key: 'short' })
})

test('keys are stored encrypted, shown by their last characters, and handed to dsh only by environment', (t) => {
  const { file, store } = setup(t)
  const added = store.add(parseProviderInput(FORM, []))
  store.add(parseProviderInput({ ...FORM, name: 'Ollama', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', models: 'qwen3:8b', key: '' }, []))

  assert.equal(fs.readFileSync(file, 'utf8').includes(SAMPLE_KEY), false)
  assert.equal(store.list()[0].key, SAMPLE_KEY)
  assert.equal(providerView(store.list()[0]).keyHint, '••••wxyz')
  assert.equal(Object.hasOwn(providerView(store.list()[0]), 'key'), false)
  assert.deepEqual(providerEnv(store.list()), { [keyEnvName(added.id)]: SAMPLE_KEY })
  assert.deepEqual(piAiProviders(store.list()), {
    'custom-00000001': {
      displayName: '公司网关', api: 'openai-completions', baseURL: 'https://llm.example.com/v1', apiKeyEnv: 'VIVA_MODEL_KEY_00000001',
      models: [{ id: 'glm-5.2', name: 'glm-5.2' }, { id: 'qwen3.8-flash', name: 'qwen3.8-flash' }, { id: 'kimi-k2.6', name: 'kimi-k2.6' }],
    },
    'custom-00000002': { displayName: 'Ollama', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }] },
  })
})

test('a key is not saved when the keychain is unavailable; a provider without one still is', (t) => {
  const { store } = setup(t, fakeCrypto(false))
  assert.throws(() => store.add(parseProviderInput(FORM, [])), /钥匙串不可用/)
  store.add(parseProviderInput({ ...FORM, key: '' }, []))
  assert.equal(store.list().length, 1)
})

test('the last picked model is kept, and forgotten with its provider', (t) => {
  const { store } = setup(t)
  const added = store.add(parseProviderInput(FORM, []))
  store.setLastModel({ provider: added.id, model: 'glm-5.2' })
  assert.deepEqual(store.lastModel(), { provider: added.id, model: 'glm-5.2' })
  assert.equal(store.list()[0].key, SAMPLE_KEY, 'remembering a model keeps the keys')

  store.remove(added.id)
  assert.deepEqual([store.list(), store.lastModel()], [[], null])
  assert.throws(() => store.remove(added.id), /没有这个模型提供方/)
})

test('new conversations start on the last pick while it is offered, else DeepSeek, else the first added model', () => {
  const providers = [{ id: 'custom-a', models: ['m1', 'm2'] }]
  const pick = { provider: 'custom-a', model: 'm2' }
  assert.deepEqual(defaultModel({ lastModel: pick, providers, hasDeepSeek: true }), pick)
  // Named, not left to dsh: only then does dsh take pictures in prompts.
  assert.deepEqual(defaultModel({ lastModel: { provider: 'custom-a', model: 'gone' }, providers, hasDeepSeek: true }), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(defaultModel({ lastModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, providers, hasDeepSeek: false }), { provider: 'custom-a', model: 'm1' })
  assert.deepEqual(defaultModel({ lastModel: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, providers, hasDeepSeek: true }), { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(defaultModel({ lastModel: null, providers: [], hasDeepSeek: false }), null)
})

test('a picker value is a model choice only when it names a provider and a model', () => {
  assert.deepEqual(parseModelValue(modelValue({ provider: 'custom-a', model: 'm1' })), { provider: 'custom-a', model: 'm1' })
  for (const value of ['high', '["only-one"]', '["a", 2]', '{"provider":"a"}', '']) assert.equal(parseModelValue(value), null)
})

test('the profile offers the providers, drops DeepSeek without a key and names the starting model', () => {
  const providers = { 'custom-a': { displayName: "It's 网关", api: 'anthropic-messages', baseURL: 'https://x.example', models: [{ id: 'm1', name: 'm1' }] } }
  const patch = patchFor({ plugins: [], models: { providers, deepseek: false, defaultModel: { provider: 'custom-a', model: 'm1' } } })
  assert.match(patch, /^- id: llm-pi-ai\n {2}config: \{"providers":\{"custom-a":\{"displayName":"It's 网关"/m)
  assert.match(patch, /^- id: llm-deepseek\n {2}disabled: true$/m)
  assert.match(patch, /^- id: llm-deepseek-account\n {2}disabled: true$/m)
  assert.match(patch, /^- id: acp\n {2}config: \{"provider":"custom-a","model":"m1"\}$/m)

  const stock = patchFor({ plugins: [], models: { providers: {}, deepseek: true, defaultModel: null } })
  assert.doesNotMatch(stock, /llm-pi-ai|disabled|id: acp/)
})

test('a provider is enough to start without a DeepSeek key', () => {
  const always = () => true
  assert.equal(resolveConfig({}, always, '', true).problem, null)
  assert.equal(resolveConfig({}, always, '', false).problem, 'no-key')
})

test('models state: load, add form, save in flight, fail, saved closes the form', () => {
  const view = { providers: [{ id: 'custom-a', name: 'A' }], protocols: { 'openai-completions': 'OpenAI 兼容' } }
  const steps = [
    { type: 'models_loaded', view },
    { type: 'models_adding', adding: true },
    { type: 'models_busy' },
    { type: 'models_failed', message: '请填写名称' },
    { type: 'models_busy' },
    { type: 'models_saved', view, notice: '已添加' },
  ]
  const states = steps.reduce((all, action) => [...all, reduce(all.at(-1), action)], [initialState]).slice(1)
  assert.deepEqual(states.map(({ models }) => [models.loaded, models.adding, models.busy, models.error, models.notice]), [
    [true, false, false, null, null],
    [true, true, false, null, null],
    [true, true, true, null, null],
    [true, true, false, '请填写名称', null],
    [true, true, true, null, null],
    [true, false, false, null, '已添加'],
  ])
})
