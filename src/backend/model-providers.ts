import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
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
/** 2: models are entries (`{ id, contextWindow?, maxTokens?, image? }`); a file of 1 lists ids, read as entries. */
const FILE_VERSION = 2
const MAX_PROVIDERS = 20
const MAX_MODELS = 50
const MAX_NAME_CHARS = 40
const MAX_MODEL_CHARS = 200
const MAX_URL_CHARS = 2000
/** No model's window comes near this; a number past it is a typo. */
const MAX_TOKEN_COUNT = 100_000_000
/**
 * What dsh's pi-ai assumes of a model the profile does not size (dsh-llm-pi-ai DEFAULT_CONTEXT_WINDOW,
 * DEFAULT_MAX_TOKENS): the form shows them as placeholders. Pictures it assumes a model cannot read.
 */
export const MODEL_DEFAULTS = Object.freeze({ contextWindow: 262144, maxTokens: 32768 })
/** dsh's own DeepSeek route; the stock ACP default points at it. */
const DEEPSEEK_PROVIDER = 'deepseek-official'
/** The wire protocols dsh's pi-ai adapter speaks, as the settings form names them. */
export let PROTOCOLS = Object.freeze({
  'openai-completions': t("main.model-providers.openai.compatible.chat.completions"),
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': t("main.model-providers.anthropic.compatible.messages"),
})
/** Route ids look like this, so they never collide with pi-ai's catalog providers (openai, anthropic, …). */
const ID_PREFIX = 'custom-'
const KEY_ENV_PREFIX = 'VIVA_MODEL_KEY_'

/** One model of a provider, with what the user set of it; what is unset dsh assumes (MODEL_DEFAULTS). */
export interface ModelEntry { id: string, contextWindow?: number, maxTokens?: number, image?: boolean }
/** A provider as the settings form sends it, checked. */
interface ProviderInput { name: string, api: string, baseURL: string, models: ModelEntry[], key: string }
/** A provider as the main process holds it: with its route id, and its key decrypted ('' for none). */
export interface Provider extends ProviderInput { id: string }
/** A model to start on: which route, which model of it. */
interface ModelChoice { provider: string, model: string }

/** The environment variable that carries one provider's key into dsh. */
export const keyEnvName = (id: string): string => `${KEY_ENV_PREFIX}${id.slice(ID_PREFIX.length).toUpperCase()}`

function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(t("main.mcp-config.enter", { what: what }))
  if (value.trim().length > max) throw new Error(t("main.mcp-config.is.too.long", { what: what }))
  return value.trim()
}

function parseBaseUrl(value: unknown): string {
  const text = requireText(value, t("main.model-providers.api.address"), MAX_URL_CHARS)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(t("main.model-providers.api.address.is.not.a.valid.url"))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(t("main.model-providers.api.address.must.start.with.http.or"))
  if (url.username || url.password || url.search || url.hash) throw new Error(t("main.model-providers.api.address.cannot.contain.credentials.query.parameters"))
  // The adapter appends its own path (/chat/completions, /v1/messages); a trailing slash would double it.
  return text.replace(/\/+$/, '')
}

/** A token count as typed: blank for unset, else a whole number in range; null when it is neither. */
function tokenCount(value: unknown): number | undefined | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : value == null ? '' : null
  if (text === null) return null
  if (!text) return undefined
  const count = Number(text)
  return Number.isInteger(count) && count > 0 && count <= MAX_TOKEN_COUNT ? count : null
}

/** One model row of the form: its id, and the window, output and pictures the user set. */
function parseModel(value: unknown): ModelEntry {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id.length > MAX_MODEL_CHARS || /\s/.test(id)) throw new Error(t("main.model-providers.model.ids.cannot.contain.spaces.or.be", { value1: id.slice(0, 40) }))
  const contextWindow = tokenCount(row.contextWindow)
  if (contextWindow === null) throw new Error(t("main.model-providers.context.window.must.be.a.whole.number", { model: id }))
  const maxTokens = tokenCount(row.maxTokens)
  if (maxTokens === null) throw new Error(t("main.model-providers.max.output.must.be.a.whole.number", { model: id }))
  if (maxTokens && maxTokens > (contextWindow ?? MODEL_DEFAULTS.contextWindow)) throw new Error(t("main.model-providers.max.output.exceeds.the.context.window", { model: id }))
  return { id, ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), ...(row.image === true ? { image: true } : {}) }
}

/** The form's model rows; a row left without an id is dropped. */
function parseModels(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) throw new Error(t("main.model-providers.enter.at.least.one.model.id"))
  if (value.length > MAX_MODELS) throw new Error(t("main.model-providers.up.to.models.allowed", { MAX_MODELS: MAX_MODELS }))
  const models = value.map(parseModel).filter((model) => model.id)
  if (models.length === 0) throw new Error(t("main.model-providers.enter.at.least.one.model.id"))
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error(t("main.model-providers.duplicate.model.ids"))
  return models
}

/** Models as a file keeps them: ids (version 1) or entries; anything unreadable is dropped. */
function storedModels(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ModelEntry[] => {
    if (typeof item === 'string') return item ? [{ id: item }] : []
    try {
      const model = parseModel(item)
      return model.id ? [model] : []
    } catch {
      return []
    }
  })
}

/** Where to ask for a provider's models: its protocol and address, checked as the form's are. */
export function parseEndpoint(input: unknown): { api: string, baseURL: string, key: string } {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  if (typeof value.api !== 'string' || !Object.hasOwn(PROTOCOLS, value.api)) throw new Error(t("main.model-providers.choose.an.api.protocol"))
  const keyText = typeof value.key === 'string' ? value.key.trim() : ''
  return { api: value.api, baseURL: parseBaseUrl(value.baseURL), key: keyText ? validateApiKey(keyText) : '' }
}

/**
 * Validates what the settings form sends.
 * @param input untrusted `{ name, api, baseURL, models, key }`, each field checked below: models as rows
 *   `{ id, contextWindow?, maxTokens?, image? }` (counts as typed, blank for unset), key optional
 * @param takenNames names already in use (when editing, without the provider's own)
 */
export function parseProviderInput(input: unknown, takenNames: readonly string[]): ProviderInput {
  if (!input || typeof input !== 'object') throw new Error('invalid model provider')
  const value = input as Record<string, unknown>
  const name = requireText(value.name, t("main.mcp-config.name"), MAX_NAME_CHARS)
  if (takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase())) throw new Error(t("main.model-providers.a.model.provider.named.already.exists", { name: name }))
  // A local server (Ollama, LM Studio) usually needs no key.
  const { api, baseURL, key } = parseEndpoint(value)
  return { name, api, baseURL, models: parseModels(value.models), key }
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
    models: provider.models.map(({ id, contextWindow, maxTokens, image }) => ({
      id, name: id, ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}), ...(image ? { input: ['text', 'image'] } : {}),
    })),
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
  lastModel: ModelChoice | null, providers: ReadonlyArray<{ id: string, models: ReadonlyArray<{ id: string }> }>, hasDeepSeek: boolean,
}): ModelChoice | null {
  const offered = (choice: ModelChoice) => (choice.provider === DEEPSEEK_PROVIDER
    ? hasDeepSeek
    : providers.some((provider) => provider.id === choice.provider && provider.models.some((model) => model.id === choice.model)))
  if (lastModel && offered(lastModel)) return lastModel
  if (hasDeepSeek) return DEEPSEEK_DEFAULT
  if (providers.length === 0) return null
  return { provider: providers[0].id, model: providers[0].models[0].id }
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

/** A provider as kept on disk: its key encrypted (base64), or null; models as entries, or ids (FILE_VERSION 1). */
interface StoredProvider { id: string, name: string, api: string, baseURL: string, models?: Array<string | ModelEntry>, key: string | null }

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
      id: stored.id, name: stored.name, api: stored.api, baseURL: stored.baseURL, models: storedModels(stored.models), key: decryptKey(stored),
    }))
  }

  function add(config: ProviderInput): Provider {
    const { stored, lastModel } = read()
    if (stored.length >= MAX_PROVIDERS) throw new Error(t("main.model-providers.up.to.model.providers.allowed", { MAX_PROVIDERS: MAX_PROVIDERS }))
    if (config.key && !crypto.isEncryptionAvailable()) throw new Error(t("main.model-providers.system.keychain.unavailable.the.key.cannot.be"))
    const id = newId()
    const key = config.key ? crypto.encryptString(config.key).toString('base64') : null
    write({ stored: [...stored, { id, name: config.name, api: config.api, baseURL: config.baseURL, models: config.models, key }], lastModel })
    return { ...config, id }
  }

  /** The provider changed as the form says; a key left blank keeps the one it has. */
  function update(id: string, config: ProviderInput): Provider {
    const { stored, lastModel } = read()
    const before = stored.find((provider) => provider.id === id)
    if (!before) throw new Error(t("main.model-providers.model.provider.not.found"))
    if (config.key && !crypto.isEncryptionAvailable()) throw new Error(t("main.model-providers.system.keychain.unavailable.the.key.cannot.be"))
    const key = config.key ? crypto.encryptString(config.key).toString('base64') : before.key
    const next = { id, name: config.name, api: config.api, baseURL: config.baseURL, models: config.models, key }
    write({ stored: stored.map((provider) => (provider.id === id ? next : provider)), lastModel })
    return { ...config, id, key: config.key || decryptKey(before) }
  }

  function remove(id: string): void {
    const { stored, lastModel } = read()
    const next = stored.filter((provider) => provider.id !== id)
    if (next.length === stored.length) throw new Error(t("main.model-providers.model.provider.not.found"))
    write({ stored: next, lastModel: lastModel?.provider === id ? null : lastModel })
  }

  const lastModel = (): ModelChoice | null => read().lastModel

  /** Remembers the model the user picked, for the next conversation and the next launch. */
  function setLastModel(choice: ModelChoice): void {
    write({ stored: read().stored, lastModel: choice })
  }

  return { list, add, update, remove, lastModel, setLastModel }
}

onLocaleChange(() => {
  PROTOCOLS = Object.freeze({
  'openai-completions': t("main.model-providers.openai.compatible.chat.completions"),
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': t("main.model-providers.anthropic.compatible.messages"),
})
})
