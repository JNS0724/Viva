import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { createHash, randomUUID } from 'node:crypto'
import type { MemorySendPermit } from '../../../src/memory/core/send-fence.ts'

import type { NativeOutputAttempt } from '../../../src/memory/node/native-output-attempts.ts'

export type MemoryTransportOrigin = { session: string, contextGeneration?: number, output?: NativeOutputAttempt } | { jobId: string }
interface OriginContext { owner: MemoryTransportOwner; origin: MemoryTransportOrigin }
interface Sending { permit: MemorySendPermit; created: boolean; origin?: string; path?: string }
export interface MemoryTransportOwner {
  acquireSend(id: string, origin: MemoryTransportOrigin, payload: string): MemorySendPermit & { recordBody?(): void }
}
const calls = new AsyncLocalStorage<OriginContext>()
const sends = new AsyncLocalStorage<Sending>()
const owners = new Set<MemoryTransportOwner>()
const requests = new WeakMap<object, Sending>()
let baseFetch: typeof fetch | undefined
const create = channel('undici:request:create')
const sent = channel('undici:request:bodySent')
const failed = channel('undici:request:error')
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
function requestCreated(event: unknown) {
  const request = object(object(event)?.request), sending = sends.getStore()
  if (request && sending && request.method === 'POST' && request.origin === sending.origin && request.path === sending.path) {
    sending.created = true; requests.set(request, sending)
  }
}
function requestSettled(event: unknown) {
  const request = object(object(event)?.request)
  if (request) requests.get(request)?.permit.settled()
}
// Provider protocol fields, never business predicates. New transports require an explicit audit.
const fields = new Set(['model', 'messages', 'input', 'instructions', 'system', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream',
  'stream_options', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stop_sequences',
  'frequency_penalty', 'presence_penalty', 'response_format', 'reasoning', 'reasoning_effort', 'thinking', 'output_config', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'service_tier', 'store', 'metadata',
  'include', 'user', 'seed', 'n', 'logprobs', 'top_logprobs', 'dsh_plugin_packages'])
function validatePayload(body: string) {
  const data = object(JSON.parse(body))
  if (!data || Object.keys(data).some(key => !fields.has(key))) throw new Error('Unsupported model payload or history upload extension')
  const packages = data.dsh_plugin_packages
  if (packages !== undefined) {
    const value = object(packages)
    if (!value || Object.keys(value).some(key => key !== 'version' && key !== 'packages') || !Array.isArray(value.packages)
      || value.packages.some(item => { const pkg = object(item); return !pkg || Object.keys(pkg).some(key => key !== 'name' && key !== 'version')
        || typeof pkg.name !== 'string' || typeof pkg.version !== 'string' })) throw new Error('Unsupported plugin metadata payload')
  }
}
const guardedFetch: typeof fetch = async (input, init) => {
  const context = calls.getStore()
  if (!context) return baseFetch!(input, init)
  if (!owners.has(context.owner)) throw new Error('Memory transport was unloaded')
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (method.toUpperCase() !== 'POST') {
    if (init?.body || input instanceof Request && input.body) throw new Error('Unsupported model transport method')
    return baseFetch!(input, init)
  }
  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  if (typeof body !== 'string') throw new Error('Memory requires a prepared JSON request body')
  validatePayload(body)
  const permit = context.owner.acquireSend(randomUUID(), context.origin, createHash('sha256').update(body).digest('hex'))
  const sending: Sending = { permit, created: false }
  try {
    const url = new URL(input instanceof Request ? input.url : String(input))
    sending.origin = url.origin; sending.path = url.pathname + url.search
    const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = originalSignal ? AbortSignal.any([permit.signal, originalSignal]) : permit.signal
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const bytes = new TextEncoder().encode(body)
    headers.set('content-length', String(bytes.byteLength))
    if (!permit.current() || signal.aborted) { permit.settled(); throw new Error('Memory send permit was revoked') }
    // One-shot stream prevents Undici's transparent 421 replay; SDK retries return to this gate.
    const options: RequestInit & { duplex: 'half' } = { ...init, method, headers, signal, redirect: 'error', duplex: 'half',
      body: new ReadableStream<Uint8Array>({ pull(controller) {
        // Request construction must announce the audited physical boundary before any body byte is
        // handed over. An opaque fetch wrapper cannot consume the prompt and only then be rejected.
        if (!sending.created || !permit.current() || signal.aborted) {
          controller.error(new Error('Transport has no admitted observable request boundary'))
          return
        }
        permit.recordBody?.()
        controller.enqueue(bytes); controller.close()
      } }, { highWaterMark: 0 }) }
    const result = await sends.run(sending, () => baseFetch!(input, options))
    if (!sending.created) throw new Error('Transport supplied no observable request boundary')
    return result
  } catch (error) {
    // No transport request was constructed; otherwise diagnostic bodySent/error owns acknowledgment.
    if (!sending.created) permit.settled()
    throw error
  }
}

/** Shared interception with per-owner ALS context; other plugins' unrelated fetch calls are unaffected. */
export function createMemoryTransport(owner: MemoryTransportOwner) {
  if (owners.has(owner)) throw new Error('Memory transport already installed')
  if (!owners.size) {
    baseFetch = globalThis.fetch
    globalThis.fetch = guardedFetch
    create.subscribe(requestCreated); sent.subscribe(requestSettled); failed.subscribe(requestSettled)
  }
  owners.add(owner)
  return {
    run<T>(origin: MemoryTransportOrigin, work: () => T): T { return calls.run({ owner, origin }, work) },
    dispose() {
      owners.delete(owner)
      if (!owners.size) {
        if (globalThis.fetch === guardedFetch) globalThis.fetch = baseFetch!
        create.unsubscribe(requestCreated); sent.unsubscribe(requestSettled); failed.unsubscribe(requestSettled)
      }
    },
  }
}
