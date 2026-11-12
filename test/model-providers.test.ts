import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../src/backend/config.ts'
import { patchFor } from '../src/backend/dsh-profile.ts'
import {
  createModelStore, defaultModel, keyEnvName, modelValue, parseModelValue, parseProviderInput, piAiProviders, providerEnv, providerView,
} from '../src/backend/model-providers.ts'
import type { Encryption } from '../src/backend/settings-store.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { scratch } from './fixtures/scratch.js'

const SAMPLE_KEY = 'sk-gateway-0000000000wxyz'
/** The form as typed: counts as text, blank for unset. */
const row = (id: string, { contextWindow = '', maxTokens = '', image = false } = {}) => ({ id, contextWindow, maxTokens, image })
const FORM = {
  name: '公司网关', api: 'openai-completions', baseURL: ' https://llm.example.com/v1/ ', key: ` ${SAMPLE_KEY} `,
  models: [row(' glm-5.2 ', { contextWindow: ' 131072 ', maxTokens: '8192', image: true }), row('qwen3.8-flash'), row('kimi-k2.6'), row('')],
}

/** Reversible stand-in for Electron safeStorage; output never contains the plaintext. */
const fakeCrypto = (available = true): Encryption => ({
  isEncryptionAvailable: () => available,
  encryptString: (text: string) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decryptString: (buffer: Buffer) => [...buffer.toString().slice(4)].reverse().join(''),
})

function setup(t: TestContext, crypto = fakeCrypto()) {
  const { dir } = scratch(t, 'model-providers-')
  const file = path.join(dir, 'models.json')
  let next = 0
  const store = createModelStore({ file, crypto, newId: () => `custom-${String(++next).padStart(8, '0')}` })
  return { file, store }
}

test('the form is trimmed: a row per model with what was set of it, empty rows dropped, the URL without a trailing slash', () => {
  assert.deepEqual(parseProviderInput(FORM, []), {
    name: '公司网关', api: 'openai-completions', baseURL: 'https://llm.example.com/v1', key: SAMPLE_KEY,
    models: [{ id: 'glm-5.2', contextWindow: 131072, maxTokens: 8192, image: true }, { id: 'qwen3.8-flash' }, { id: 'kimi-k2.6' }],
  })
  assert.equal(parseProviderInput({ ...FORM, key: '' }, []).key, '', 'a local server needs no key')
  assert.deepEqual(parseProviderInput({ ...FORM, models: [{ id: 'm', contextWindow: 65536, maxTokens: null }] }, []).models, [{ id: 'm', contextWindow: 65536 }], 'numbers as numbers')
})

test('what cannot be served is refused with the reason', () => {
  const refused = (changes: object, taken: string[] = [], reason = /./) => assert.throws(() => parseProviderInput({ ...FORM, ...changes }, taken), reason)
  refused({}, ['公司网关'])
  refused({ name: ' ' })
  refused({ api: 'google-generative-ai' })
  refused({ baseURL: 'ftp://llm.example.com' })
  refused({ baseURL: 'https://user:pass@llm.example.com/v1' })
  refused({ baseURL: 'https://llm.example.com/v1?key=1' })
  refused({ models: [] })
  refused({ models: [row(' ')] })
  refused({ models: 'glm-5' }, [], /至少|at least/i)
  refused({ models: [row('glm 5')] })
  refused({ models: [row('glm-5'), row('glm-5')] })
  refused({ models: [row('m', { contextWindow: '128k' })] }, [], /上下文长度|context window/i)
  refused({ models: [row('m', { contextWindow: '0' })] })
  refused({ models: [row('m', { contextWindow: '1.5' })] })
  refused({ models: [row('m', { maxTokens: '-1' })] }, [], /最大输出|max output/i)
  refused({ models: [row('m', { contextWindow: '8192', maxTokens: '16384' })] }, [], /不能超过|cannot exceed/i)
  refused({ models: [row('m', { maxTokens: '300000' })] }, [], /不能超过|cannot exceed/i)
  refused({ key: 'short' })
})

test('keys are stored encrypted, shown by their last characters, and handed to dsh only by environment', (t) => {
  const { file, store } = setup(t)
  const added = store.add(parseProviderInput(FORM, []))
  store.add(parseProviderInput({ ...FORM, name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', models: [row('qwen3:8b')], key: '' }, []))

  assert.equal(fs.readFileSync(file, 'utf8').includes(SAMPLE_KEY), false)
  assert.equal(store.list()[0].key, SAMPLE_KEY)
  assert.equal(providerView(store.list()[0]).keyHint, '••••wxyz')
  assert.equal(Object.hasOwn(providerView(store.list()[0]), 'key'), false)
  assert.deepEqual(providerEnv(store.list()), { [keyEnvName(added.id)]: SAMPLE_KEY })
  assert.deepEqual(piAiProviders(store.list()), {
    'custom-00000001': {
      displayName: '公司网关', api: 'openai-completions', baseURL: 'https://llm.example.com/v1', defaultContextWindow: 262144, defaultMaxTokens: 32768, apiKeyEnv: 'VIVA_MODEL_KEY_00000001',
      models: [
        { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'] },
        { id: 'qwen3.8-flash', name: 'qwen3.8-flash' },
        { id: 'kimi-k2.6', name: 'kimi-k2.6' },
      ],
    },
    'custom-00000002': { displayName: 'Ollama', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', defaultContextWindow: 262144, defaultMaxTokens: 32768, models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }] },
  })
})

test('a provider of an older file lists its model ids; they read as models with nothing set', (t) => {
  const { file, store } = setup(t)
  fs.writeFileSync(file, JSON.stringify({
    version: 1, lastModel: null,
    providers: [{ id: 'custom-old', name: 'Old', api: 'openai-completions', baseURL: 'https://old.example/v1', models: ['a', 'b', 7, ''], key: null }],
  }))
  assert.deepEqual(store.list()[0].models, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual((piAiProviders(store.list())['custom-old'] as { models: unknown[] }).models, [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }])
})

test('a provider changes as the form says; a key left blank keeps its key, the name stays its own', (t) => {
  const { file, store } = setup(t)
  const added = store.add(parseProviderInput(FORM, []))
  store.setLastModel({ provider: added.id, model: 'kimi-k2.6' })
  const others = (id: string) => store.list().filter((provider) => provider.id !== id).map((provider) => provider.name)

  const changed = store.update(added.id, parseProviderInput({ ...FORM, key: '', models: [row('glm-5.2', { contextWindow: '200000' })] }, others(added.id)))
  assert.equal(changed.key, SAMPLE_KEY)
  assert.deepEqual(store.list().map(({ id, key, models }) => ({ id, key, models })), [{ id: added.id, key: SAMPLE_KEY, models: [{ id: 'glm-5.2', contextWindow: 200000 }] }])
  assert.deepEqual(store.lastModel(), { provider: added.id, model: 'kimi-k2.6' }, 'the pick stays; defaultModel passes over a model no longer offered')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2)

  store.update(added.id, parseProviderInput({ ...FORM, key: 'sk-another-key-000000abcd' }, others(added.id)))
  assert.equal(store.list()[0].key, 'sk-another-key-000000abcd')
  assert.throws(() => store.update('custom-gone', parseProviderInput(FORM, [])), /没有这个模型提供方|not found/i)
})

test('a key is not saved when the keychain is unavailable; a provider without one still is', (t) => {
  const { store } = setup(t, fakeCrypto(false))
  assert.throws(() => store.add(parseProviderInput(FORM, [])), /钥匙串不可用|keychain/i)
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
  assert.throws(() => store.remove(added.id), /没有这个模型提供方|not found/i)
})

test('new conversations start on the last pick while it is offered, else DeepSeek, else the first added model', () => {
  const providers = [{ id: 'custom-a', models: [{ id: 'm1' }, { id: 'm2' }] }]
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
  // The model rows only: the app's layer always has rows of its own (HMR, the plugin manager, safety rows).
  assert.doesNotMatch(stock, /llm-pi-ai|llm-deepseek|^- id: acp$/m)
})

test('a provider is enough to start without a DeepSeek key', () => {
  const always = () => true
  assert.equal(resolveConfig({}, always, '', true).problem, null)
  assert.equal(resolveConfig({}, always, '', false).problem, 'no-key')
})

test('models state: load, open the form, save in flight, fail, saved closes the form', () => {
  const view = { providers: [{ id: 'custom-a', name: 'A', models: [{ id: 'm1' }] }], protocols: { 'openai-completions': 'OpenAI 兼容' } }
  const steps: Action[] = [
    { type: 'models_loaded', view },
    { type: 'models_draft_open' },
    { type: 'models_busy' },
    { type: 'models_failed', message: '请填写名称' },
    { type: 'models_busy' },
    { type: 'models_saved', view, notice: '已添加' },
  ]
  const states = steps.reduce((all: State[], action) => [...all, reduce(all.at(-1)!, action)], [initialState as State]).slice(1)
  assert.deepEqual(states.map(({ models }) => [models.loaded, Boolean(models.draft), models.busy, models.error, models.notice]), [
    [true, false, false, null, null],
    [true, true, false, null, null],
    [true, true, true, null, null],
    [true, true, false, '请填写名称', null],
    [true, true, true, null, null],
    [true, false, false, null, '已添加'],
  ])
})
