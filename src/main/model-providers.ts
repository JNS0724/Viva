import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { type Encryption, keyHint, validateApiKey } from './settings-store.ts'

/**
 * Model providers the user adds in settings, besides DeepSeek. dsh serves them through its `llm-pi-ai`
 * plugin (mounted dormant in every profile): the app writes each provider's route into its profile and
 * hands the key over in an environment variable that only the dsh process sees. Keys are encrypted with
 * the OS keychain like the DeepSeek key; the UI only sees their last characters.
 */
const FILE_VERSION = 1
export const MAX_PROVIDERS = 20
const MAX_MODELS = 50
const MAX_NAME_CHARS = 40
const MAX_MODEL_CHARS = 200
const MAX_URL_CHARS = 2000
/** dsh's own DeepSeek route; the stock ACP default points at it. */
export const DEEPSEEK_PROVIDER = 'deepseek-official'
/** The wire protocols dsh's pi-ai adapter speaks, as the settings form names them. */
export const PROTOCOLS = Object.freeze({
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic 兼容（Messages）',
})
/** Route ids look like this, so they never collide with pi-ai's catalog providers (openai, anthropic, …). */
const ID_PREFIX = 'custom-'
const KEY_ENV_PREFIX = 'VIVA_MODEL_KEY_'

/** A provider as the settings form sends it, checked. */
export interface ProviderInput { name: string, api: string, baseURL: string, models: string[], key: string }
/** A provider as the main process holds it: with its route id, and its key decrypted ('' for none). */
export interface Provider extends ProviderInput { id: string }
/** A model to start on: which route, which model of it. */
export interface ModelChoice { provider: string, model: string }

/** The environment variable that carries one provider's key into dsh. */
export const keyEnvName = (id: string): string => `${KEY_ENV_PREFIX}${id.slice(ID_PREFIX.length).toUpperCase()}`

function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${what}`)
  if (value.trim().length > max) throw new Error(`${what}太长了`)
  return value.trim()
}

function parseBaseUrl(value: unknown): string {
  const text = requireText(value, '接口地址', MAX_URL_CHARS)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('接口地址不是有效的网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('接口地址要以 http:// 或 https:// 开头')
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址里不能带账号、查询参数或 #')
  // The adapter appends its own path (/chat/completions, /v1/messages); a trailing slash would double it.
  return text.replace(/\/+$/, '')
}

/** Model ids one per line or separated by commas. */
function parseModels(value: unknown): string[] {
  const models = String(value ?? '').split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)
  if (models.length === 0) throw new Error('请至少填写一个模型 ID')
  if (models.length > MAX_MODELS) throw new Error(`模型最多 ${MAX_MODELS} 个`)
  const bad = models.find((model) => model.length > MAX_MODEL_CHARS || /\s/.test(model))
  if (bad) throw new Error(`模型 ID 不能有空格，也不能太长：${bad.slice(0, 40)}`)
  if (new Set(models).size !== models.length) throw new Error('模型 ID 有重复')
  return models
}

/**
 * Validates what the settings form sends.
 * @param input untrusted `{ name, api, baseURL, models, key }`, each field checked below; models as typed (lines or commas), key optional
 * @param takenNames names already in use
 */
export function parseProviderInput(input: any, takenNames: readonly string[]): ProviderInput {
  if (!input || typeof input !== 'object') throw new Error('invalid model provider')
  const name = requireText(input.name, '名称', MAX_NAME_CHARS)
  if (takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase())) throw new Error(`已经有名为「${name}」的模型提供方了`)
  if (!Object.hasOwn(PROTOCOLS, input.api)) throw new Error('请选择接口协议')
  const keyText = typeof input.key === 'string' ? input.key.trim() : ''
  return {
    name,
    api: input.api,
    baseURL: parseBaseUrl(input.baseURL),
    models: parseModels(input.models),
    // A local server (Ollama, LM Studio) usually needs none.
    key: keyText ? validateApiKey(keyText) : '',
  }
}

/** What the settings page shows: everything except the key itself. */
export const providerView = (provider: Provider) => ({
  id: provider.id,
  name: provider.name,
  api: provider.api,
  baseURL: provider.baseURL,
  models: provider.models,
  keyHint: keyHint(provider.key),
})

/** The `llm-pi-ai` section of the dsh profile: one route per provider, keys by environment variable name. */
export function piAiProviders(providers: readonly Provider[]): Record<string, object> {
  return Object.fromEntries(providers.map((provider) => [provider.id, {
    displayName: provider.name,
    api: provider.api,
    baseURL: provider.baseURL,
    ...(provider.key ? { apiKeyEnv: keyEnvName(provider.id) } : {}),
    models: provider.models.map((id) => ({ id, name: id })),
  }]))
}

/** The keys, as the environment of the dsh process. */
export const providerEnv = (providers: readonly Provider[]): Record<string, string> => Object.fromEntries(providers.filter((provider) => provider.key).map((provider) => [keyEnvName(provider.id), provider.key]))

/**
 * DeepSeek's model that reads pictures, and the first in dsh's DeepSeek catalog. Named in the profile rather
 * than left to dsh: dsh takes pictures in prompts only when the profile names the model it starts on.
 */
export const DEEPSEEK_DEFAULT: Readonly<ModelChoice> = Object.freeze({ provider: DEEPSEEK_PROVIDER, model: 'deepseek-flash' })

/**
 * The model new conversations start with: the one last picked while it is still offered, else DeepSeek's
 * default when there is a DeepSeek key, else the first model the user added.
 */
export function defaultModel({ lastModel, providers, hasDeepSeek }: {
  lastModel: ModelChoice | null, providers: ReadonlyArray<{ id: string, models: string[] }>, hasDeepSeek: boolean,
}): ModelChoice | null {
  const offered = (choice: ModelChoice) => (choice.provider === DEEPSEEK_PROVIDER
    ? hasDeepSeek
    : providers.some((provider) => provider.id === choice.provider && provider.models.includes(choice.model)))
  if (lastModel && offered(lastModel)) return lastModel
  if (hasDeepSeek) return DEEPSEEK_DEFAULT
  if (providers.length === 0) return null
  return { provider: providers[0].id, model: providers[0].models[0] }
}

/** dsh names a model in its picker as the JSON of `[provider, model]`; anything else is not a model choice. */
export function parseModelValue(value: string): ModelChoice | null {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === 'string' && part)) {
      return { provider: parsed[0], model: parsed[1] }
    }
  } catch {
    // not a model choice
  }
  return null
}

export const modelValue = (choice: ModelChoice): string => JSON.stringify([choice.provider, choice.model])

/** A provider as kept on disk: its key encrypted (base64), or null. */
interface StoredProvider { id: string, name: string, api: string, baseURL: string, models?: string[], key: string | null }

export function createModelStore({ file, crypto, onError = () => {}, newId = () => `${ID_PREFIX}${randomBytes(4).toString('hex')}` }: {
  file: string, crypto: Encryption, onError?: (err: Error) => void, newId?: () => string,
}) {
  function read(): { stored: StoredProvider[], lastModel: ModelChoice | null } {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { stored: Array.isArray(data?.providers) ? data.providers : [], lastModel: data?.lastModel ?? null }
    } catch (err: any) {
      if (err.code !== 'ENOENT') onError(err)
      return { stored: [], lastModel: null }
    }
  }

  /** Keys stay encrypted on disk; rewriting the file never needs to decrypt the ones it keeps. */
  function write({ stored, lastModel }: { stored: StoredProvider[], lastModel: ModelChoice | null }): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, providers: stored, lastModel }), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function decryptKey(stored: StoredProvider): string {
    if (!stored.key) return ''
    try {
      return crypto.decryptString(Buffer.from(stored.key, 'base64'))
    } catch (err: any) {
      onError(new Error(`could not decrypt the key of model provider "${stored.name}": ${err.message}`))
      return ''
    }
  }

  /** The providers with their keys decrypted; only the main process ever holds these. */
  function list(): Provider[] {
    return read().stored.map((stored) => ({
      id: stored.id, name: stored.name, api: stored.api, baseURL: stored.baseURL, models: stored.models ?? [], key: decryptKey(stored),
    }))
  }

  function add(config: ProviderInput): Provider {
    const { stored, lastModel } = read()
    if (stored.length >= MAX_PROVIDERS) throw new Error(`最多添加 ${MAX_PROVIDERS} 个模型提供方`)
    if (config.key && !crypto.isEncryptionAvailable()) throw new Error('系统钥匙串不可用，无法安全保存 key')
    const id = newId()
    const key = config.key ? crypto.encryptString(config.key).toString('base64') : null
    write({ stored: [...stored, { id, name: config.name, api: config.api, baseURL: config.baseURL, models: config.models, key }], lastModel })
    return { ...config, id }
  }

  function remove(id: string): void {
    const { stored, lastModel } = read()
    const next = stored.filter((provider) => provider.id !== id)
    if (next.length === stored.length) throw new Error('没有这个模型提供方')
    write({ stored: next, lastModel: lastModel?.provider === id ? null : lastModel })
  }

  const lastModel = (): ModelChoice | null => read().lastModel

  /** Remembers the model the user picked, for the next conversation and the next launch. */
  function setLastModel(choice: ModelChoice): void {
    write({ stored: read().stored, lastModel: choice })
  }

  return { list, add, remove, lastModel, setLastModel }
}
