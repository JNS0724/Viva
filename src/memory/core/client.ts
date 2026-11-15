import { z } from 'zod'
import {
  MEMORY_SERVICE_PROTOCOL, MEMORY_HOST_METHODS, MEMORY_RECOVERY_METHODS,
  memoryCommandSchemas, memoryRequestEnvelope, memoryResultSchemas, memoryServiceStatus, memoryServiceError,
} from '../contracts/service.ts'
import type {
  MemoryClientBinding, MemoryCommand, MemoryInput, MemoryMethod, MemoryOutput, MemoryResponseEnvelope,
  MemoryResult, MemoryServiceFailure, MemoryServiceStatus,
} from '../contracts/service.ts'

export class MemoryServiceError extends Error {
  readonly failure: MemoryServiceFailure
  constructor(failure: MemoryServiceFailure) {
    super(failure.code)
    this.name = 'MemoryServiceError'
    this.failure = failure
  }
}

export type MemoryTransport = (request: unknown) => Promise<unknown>
export type MemoryServiceOptions = {
  /** Supplied by an authenticated adapter; never deserialize a binding from caller input. */
  binding: MemoryClientBinding,
  epoch: () => string,
  state: () => MemoryServiceStatus['state'],
  supported: readonly MemoryMethod[],
  /** Resolve real target/source scopes here; possession of an opaque ID is not authorization. */
  authorize: (binding: MemoryClientBinding, command: MemoryCommand) => boolean | Promise<boolean>,
  /** Owns durable operation-id receipts. The protocol never fabricates acceptance or caches writes in memory. */
  execute: (command: MemoryCommand, binding: MemoryClientBinding) => MemoryResult | Promise<MemoryResult>,
}

function operationMatches(method: MemoryMethod, input: unknown, result: unknown): boolean {
  if (!input || typeof input !== 'object' || !('operationId' in input)) return true
  if (method === 'getOperation' && result === null) return true
  if (!result || typeof result !== 'object') return false
  const outcome = method === 'prepareSourceChange' && 'operation' in result ? result.operation : result
  return Boolean(outcome && typeof outcome === 'object' && 'operationId' in outcome && outcome.operationId === input.operationId)
}

/** In-process P1 endpoint. The same DTOs can later travel over authenticated P2 IPC/Remote adapters. */
export function createMemoryService(options: MemoryServiceOptions): MemoryTransport {
  const binding: MemoryClientBinding = Object.freeze({ ...options.binding, capabilities: Object.freeze([...options.binding.capabilities]) })
  const supported = new Set(options.supported)
  const allowed = new Set(binding.capabilities.filter(method => supported.has(method)
    && (!MEMORY_HOST_METHODS.has(method) || binding.kind === 'host')))
  const status = (): MemoryServiceStatus => ({
    protocol: MEMORY_SERVICE_PROTOCOL, instanceEpoch: options.epoch(), state: options.state(), capabilities: [...allowed],
  })
  return async (raw: unknown): Promise<MemoryResponseEnvelope> => {
    const envelope = memoryRequestEnvelope.safeParse(raw)
    const requestId = envelope.success ? envelope.data.requestId : 'invalid-request'
    const instanceEpoch = options.epoch()
    const fail = (error: MemoryServiceFailure): MemoryResponseEnvelope => ({ requestId, instanceEpoch, ok: false, error })
    if (!envelope.success) return fail({ code: 'invalid-input' })
    const request = envelope.data
    if (request.protocol !== MEMORY_SERVICE_PROTOCOL) return fail({ code: 'protocol-mismatch' })
    if (request.method === 'connect') {
      if (!z.strictObject({}).safeParse(request.input).success || request.instanceEpoch !== undefined) return fail({ code: 'invalid-input' })
      return { requestId, instanceEpoch, ok: true, result: status() }
    }
    if (request.instanceEpoch !== instanceEpoch) return fail({ code: 'unavailable', reason: 'stale-epoch' })
    const parsed = memoryCommandSchemas[request.method].safeParse(request.input)
    if (!parsed.success) return fail({ code: 'invalid-input' })
    if (!allowed.has(request.method)) return fail({ code: 'unauthorized' })
    if (binding.kind === 'model' && request.method === 'remember'
      && memoryCommandSchemas.remember.parse(parsed.data).input.kind === 'explicit-user') return fail({ code: 'unauthorized' })
    if (request.method !== 'status' && (options.state() === 'unavailable' || (options.state() === 'recovering' && !MEMORY_RECOVERY_METHODS.has(request.method)))) {
      return fail({ code: 'unavailable', reason: options.state() })
    }
    // The method's schema validated its own input immediately above; this preserves the correlated union.
    const command = { method: request.method, input: parsed.data } as MemoryCommand
    try {
      if (!await options.authorize(binding, command)) return fail({ code: 'unauthorized' })
      // Authorization may await a host lookup. Never cross a changed owner epoch/readiness boundary afterwards.
      if (options.epoch() !== instanceEpoch) return fail({ code: 'unavailable', reason: 'stale-epoch' })
      if (command.method !== 'status' && (options.state() === 'unavailable' || (options.state() === 'recovering' && !MEMORY_RECOVERY_METHODS.has(command.method)))) {
        return fail({ code: 'unavailable', reason: options.state() })
      }
      const result = command.method === 'status' ? status() : await options.execute(command, binding)
      if (options.epoch() !== instanceEpoch) return fail({ code: 'unavailable', reason: 'stale-epoch' })
      const checked = memoryResultSchemas[command.method].safeParse(result)
      if (!checked.success || !operationMatches(command.method, command.input, checked.data)) return fail({ code: 'unavailable', reason: 'invalid-service-result' })
      return { requestId, instanceEpoch, ok: true, result: checked.data }
    } catch (error) {
      return fail(error instanceof MemoryServiceError ? error.failure : { code: 'unavailable' })
    }
  }
}

const response = z.discriminatedUnion('ok', [
  z.strictObject({ requestId: z.string(), instanceEpoch: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ requestId: z.string(), instanceEpoch: z.string(), ok: z.literal(false), error: memoryServiceError }),
])

/** Request IDs are transport-local; callers retain operation IDs themselves across timeout/reconnect. */
export function createMemoryClient({ transport, requestId }: { transport: MemoryTransport, requestId: () => string }) {
  let epoch: string | null = null
  let connectionGeneration = 0
  async function send(method: MemoryMethod | 'connect', input: unknown, capturedEpoch: string | null) {
    const id = requestId()
    const raw = await transport({ protocol: MEMORY_SERVICE_PROTOCOL, requestId: id, method, input,
      ...(capturedEpoch === null ? {} : { instanceEpoch: capturedEpoch }) })
    const checked = response.safeParse(raw)
    if (!checked.success || checked.data.requestId !== id) throw new MemoryServiceError({ code: 'unavailable', reason: 'invalid-service-response' })
    const reply = checked.data
    if (!reply.ok) throw new MemoryServiceError(reply.error)
    if (capturedEpoch !== null && reply.instanceEpoch !== capturedEpoch) throw new MemoryServiceError({ code: 'unavailable', reason: 'stale-epoch' })
    return reply
  }
  return {
    async connect(): Promise<MemoryServiceStatus> {
      const generation = ++connectionGeneration
      const result = await send('connect', {}, null)
      const state = memoryServiceStatus.safeParse(result.result)
      if (!state.success || state.data.instanceEpoch !== result.instanceEpoch) throw new MemoryServiceError({ code: 'unavailable', reason: 'invalid-service-response' })
      if (generation !== connectionGeneration) throw new MemoryServiceError({ code: 'unavailable', reason: 'superseded-connection' })
      epoch = state.data.instanceEpoch
      return state.data
    },
    async call<M extends MemoryMethod>(method: M, input: MemoryInput<M>): Promise<MemoryOutput<M>> {
      if (epoch === null) throw new MemoryServiceError({ code: 'unavailable', reason: 'not-connected' })
      const generation = connectionGeneration
      const result = await send(method, memoryCommandSchemas[method].parse(input), epoch)
      if (generation !== connectionGeneration) throw new MemoryServiceError({ code: 'unavailable', reason: 'superseded-connection' })
      const value = memoryResultSchemas[method].safeParse(result.result)
      if (!value.success || !operationMatches(method, input, value.data)) throw new MemoryServiceError({ code: 'unavailable', reason: 'invalid-service-response' })
      return value.data as MemoryOutput<M>
    },
    disconnect() { epoch = null; connectionGeneration += 1 },
  }
}
export type MemoryClient = ReturnType<typeof createMemoryClient>
