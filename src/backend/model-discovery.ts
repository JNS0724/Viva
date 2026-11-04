/**
 * 获取可用模型 (my-agent-workspace#9): asks a provider's endpoint which models it serves, for the settings form to
 * offer. The same reading as dsh's own (dsh-llm-pi-ai discovery.js), which dsh does not export: OpenAI protocols
 * list at `{baseURL}/models` with a bearer key, Anthropic Messages at `{root}/v1/models` with `x-api-key`; the
 * standard `data` array, or the `models` map some gateways expose. Nothing is stored; the user picks what to add.
 */

/** A model the endpoint lists, with what it says of its size when it says it. */
export interface DiscoveredModel { id: string, name: string, contextWindow?: number, maxTokens?: number }
/** Where to ask: the form as it is, with the key typed or the provider's own ('' for none). */
export interface DiscoveryRequest { api: string, baseURL: string, key: string }

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_MODEL_LIMIT = 1000
/** The endpoint is whatever URL the user typed: its answer is read only this far. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DISCOVERY_TIMEOUT_MS = 15_000
/** More than the picker offers is cut, in the endpoint's order. */
const MAX_DISCOVERED = 2000

export type DiscoveryFetch = (url: string, init: { method: string, headers: Record<string, string>, redirect: 'manual', signal: AbortSignal }) => Promise<Response>

/** Why discovery failed, for the form to word (models-ipc.ts). */
type DiscoveryReason = 'unreachable' | 'timeout' | 'refused' | 'redirected' | 'status' | 'not-json' | 'not-a-listing' | 'too-large'

export class DiscoveryError extends Error {
  readonly reason: DiscoveryReason
  readonly status: number | undefined
  constructor(reason: DiscoveryReason, url: string, status?: number) {
    super(`${url}: ${reason}${status ? ` ${status}` : ''}`)
    this.reason = reason
    this.status = status
  }
}

/** Where the protocol lists its models; a deployment path in the base (…/openai/v1) is kept. */
export function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  return `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/models?limit=${ANTHROPIC_MODEL_LIMIT}`
}

function headersFor(api: string, key: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key) headers['x-api-key'] = key
  } else if (key) headers.authorization = `Bearer ${key}`
  return headers
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** `value[key]`, or undefined for anything not an object. */
const at = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined)

/** A positive integer among the fields gateways name it by, or undefined. */
const capacity = (...candidates: unknown[]): number | undefined =>
  candidates.find((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0)
const label = (...candidates: unknown[]): string | undefined =>
  candidates.find((value): value is string => typeof value === 'string' && value.length > 0)

function entryModel(key: string | undefined, entry: unknown): DiscoveredModel | null {
  const id = label(key, at(entry, 'id'))
  if (!id) return null
  const contextWindow = capacity(at(entry, 'contextWindow'), at(entry, 'context_window'), at(entry, 'context_length'),
    at(entry, 'max_input_tokens'), at(at(entry, 'limit'), 'context'))
  const maxTokens = capacity(at(entry, 'maxOutputTokens'), at(entry, 'max_output_tokens'), at(entry, 'maxTokens'), at(entry, 'max_tokens'),
    at(at(entry, 'limit'), 'output'), at(at(entry, 'top_provider'), 'max_completion_tokens'))
  return {
    id, name: label(at(entry, 'name'), at(entry, 'display_name'), at(entry, 'displayName')) ?? id,
    ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

/**
 * The listing's models, in its order: the `data` array, else the `models` map (its keys are the ids requests use).
 * A row without an id, or one already listed, is skipped rather than failing the whole listing.
 * @throws Error when the body is neither
 */
export function readListing(body: unknown): DiscoveredModel[] {
  const data = at(body, 'data')
  const map = at(body, 'models')
  const rows: Array<[string | undefined, unknown]> | null = Array.isArray(data)
    ? data.map((entry): [undefined, unknown] => [undefined, entry])
    : isObject(map) ? Object.entries(map).filter(([, entry]) => isObject(entry)) : null
  if (!rows) throw new Error('not a model listing')
  const seen = new Set<string>()
  return rows.flatMap(([key, entry]) => {
    const model = entryModel(key, entry)
    if (!model || seen.has(model.id)) return []
    seen.add(model.id)
    return [model]
  }).slice(0, MAX_DISCOVERED)
}

class TooLarge extends Error {}

/** The body, refused once it outgrows MAX_RESPONSE_BYTES: by what it declares, then by what actually came. */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new TooLarge()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new TooLarge()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Asks the endpoint for its models.
 * @throws DiscoveryError when it cannot be reached in time, refuses the key, redirects, answers another error, or not a listing
 */
export async function discoverModels({ api, baseURL, key }: DiscoveryRequest, {
  fetch = globalThis.fetch as DiscoveryFetch, timeoutMs = DISCOVERY_TIMEOUT_MS,
}: { fetch?: DiscoveryFetch, timeoutMs?: number } = {}): Promise<DiscoveredModel[]> {
  const url = listingUrl(baseURL, api)
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    // Not followed: the key goes only to the address typed, never on to where a redirect points.
    response = await fetch(url, { method: 'GET', headers: headersFor(api, key), redirect: 'manual', signal })
  } catch {
    throw new DiscoveryError(signal.aborted ? 'timeout' : 'unreachable', url)
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {})
    throw new DiscoveryError('redirected', url, response.status || undefined)
  }
  if (response.status === 401 || response.status === 403) throw new DiscoveryError('refused', url, response.status)
  if (!response.ok) throw new DiscoveryError('status', url, response.status)
  let text: string
  try {
    text = await readBounded(response)
  } catch (err) {
    throw new DiscoveryError(err instanceof TooLarge ? 'too-large' : signal.aborted ? 'timeout' : 'unreachable', url)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new DiscoveryError('not-json', url)
  }
  try {
    return readListing(body)
  } catch {
    throw new DiscoveryError('not-a-listing', url)
  }
}
