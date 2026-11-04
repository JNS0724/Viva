import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DiscoveryError, type DiscoveryRequest } from '../src/backend/model-discovery.ts'
import { createModelStore, type ModelEntry } from '../src/backend/model-providers.ts'
import { registerModelsIpc } from '../src/backend/models-ipc.ts'
import type { Encryption } from '../src/backend/settings-store.ts'
import { scratch } from './fixtures/scratch.js'

const KEY = 'sk-gateway-0000000000wxyz'
const crypto: Encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`),
  decryptString: (buffer: Buffer) => buffer.toString().slice(4),
}
const FORM = { name: 'Gateway', api: 'openai-completions', baseURL: 'https://gw.example/v1', key: KEY, models: [{ id: 'glm-5.2', contextWindow: '131072', maxTokens: '', image: true }] }

/** What the section's channels answer. */
type View = { providers: Array<{ models: ModelEntry[], keyHint: string }>, defaults: object, updated?: string }

function setup(t: TestContext, discover: (request: DiscoveryRequest) => Promise<never[]> = async () => []) {
  const { dir } = scratch(t, 'models-ipc-')
  const store = createModelStore({ file: path.join(dir, 'models.json'), crypto, newId: () => 'custom-0000000a' })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let restarts = 0
  registerModelsIpc({ handle: (channel, fn) => handlers.set(channel, fn as (...args: unknown[]) => unknown) }, {
    store, restart: async () => { restarts += 1; return {} }, discover,
  })
  const invoke = async (channel: string, ...args: unknown[]) => await handlers.get(channel)!({}, ...args) as View
  return { invoke, restarts: () => restarts, channels: [...handlers.keys()].sort() }
}

test('the section is listed with what dsh assumes of a model left unsized; adding and editing restart dsh', async (t) => {
  const { invoke, restarts, channels } = setup(t)
  assert.deepEqual(channels, ['models:add', 'models:discover', 'models:get', 'models:remove', 'models:update'])
  assert.deepEqual((await invoke('models:get')).defaults, { contextWindow: 262144, maxTokens: 32768 })

  const added = await invoke('models:add', FORM)
  assert.deepEqual(added.providers[0].models, [{ id: 'glm-5.2', contextWindow: 131072, image: true }])
  const updated = await invoke('models:update', 'custom-0000000a', { ...FORM, key: '', models: [{ id: 'glm-5.2', contextWindow: '', maxTokens: '4096', image: false }] })
  assert.deepEqual([updated.updated, updated.providers[0].models, updated.providers[0].keyHint], ['Gateway', [{ id: 'glm-5.2', maxTokens: 4096 }], '••••wxyz'])
  assert.equal(restarts(), 2)
  await assert.rejects(invoke('models:update', 'custom-0000000a', { ...FORM, models: [] }), /至少|at least/i)
})

test('a saved key does not follow the address to another host; typed again, it goes', async (t) => {
  const { invoke } = setup(t)
  await invoke('models:add', FORM)
  await assert.rejects(invoke('models:update', 'custom-0000000a', { ...FORM, key: '', baseURL: 'https://elsewhere.example/v1' }), /主机|another host/)
  const moved = await invoke('models:update', 'custom-0000000a', { ...FORM, key: '', baseURL: 'https://gw.example/openai/v1' })
  assert.equal(moved.providers[0].keyHint, '••••wxyz', 'another path of the same host keeps the key')
  const retyped = await invoke('models:update', 'custom-0000000a', { ...FORM, baseURL: 'https://elsewhere.example/v1' })
  assert.equal(retyped.providers[0].keyHint, '••••wxyz')
})

test('获取可用模型 uses the key typed, else the edited provider\'s own; the endpoint is checked as the form\'s is', async (t) => {
  const asked: DiscoveryRequest[] = []
  const { invoke } = setup(t, async (request) => { asked.push(request); return [] })
  await invoke('models:add', FORM)
  await invoke('models:discover', { api: 'anthropic-messages', baseURL: 'https://x.example/', key: ' sk-typed-0000000000 ' })
  await invoke('models:discover', { api: 'openai-completions', baseURL: 'https://gw.example/v1', key: '' }, 'custom-0000000a')
  await invoke('models:discover', { api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', key: '' })
  assert.deepEqual(asked, [
    { api: 'anthropic-messages', baseURL: 'https://x.example', key: 'sk-typed-0000000000' },
    { api: 'openai-completions', baseURL: 'https://gw.example/v1', key: KEY },
    { api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', key: '' },
  ])
  // The saved key goes only where it went: another path of that host, never another host.
  await invoke('models:discover', { api: 'openai-completions', baseURL: 'https://gw.example/openai/v2', key: '' }, 'custom-0000000a')
  await invoke('models:discover', { api: 'openai-completions', baseURL: 'https://elsewhere.example/v1', key: '' }, 'custom-0000000a')
  assert.deepEqual(asked.slice(3).map((request) => request.key), [KEY, ''])
  asked.splice(3)
  await assert.rejects(invoke('models:discover', { api: 'nope', baseURL: 'https://x.example' }))
  await assert.rejects(invoke('models:discover', { api: 'openai-completions', baseURL: 'file:///etc' }))
  assert.equal(asked.length, 3, 'nothing asked for an endpoint refused')
})

test('why discovery failed reads in words, the key refused named as such', async (t) => {
  const { invoke } = setup(t, async () => { throw new DiscoveryError('refused', 'https://gw.example/v1/models', 401) })
  await assert.rejects(invoke('models:discover', { api: 'openai-completions', baseURL: 'https://gw.example/v1', key: '' }), /401.*API key/)
})
