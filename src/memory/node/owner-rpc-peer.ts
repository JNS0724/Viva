import { randomUUID } from 'node:crypto'
import { parseMemoryDomainErrorDetails } from '../contracts/domain-error.ts'
import {
  MEMORY_OWNER_RPC, OWNER_RPC_DEFAULT_BUDGET_MS, OWNER_RPC_MAX_ACTIVE, OWNER_RPC_MAX_BUDGET_MS, ownerRpcFrame,
  type OwnerRpcFrame,
} from '../contracts/owner-rpc.ts'
import { objectOf } from '../contracts/unknown-value.ts'
import { RequestTimeout } from '../../shared/request-budget.ts'
import type { OwnerCallOptions } from './owner-adapter.ts'

type PeerOptions = {
  send(frame: OwnerRpcFrame): void
  handle?(method: string, input: unknown, signal: AbortSignal, budgetMs: number): unknown
  onEvent?(event: unknown): void
}
type Lane = 'control' | 'release' | 'normal'
type Outbound = {
  lane: Lane
  result(frame: Extract<OwnerRpcFrame, { kind: 'result' }>): void
  disconnect(error: Error): void
}
const unavailable = () => new Error('Memory owner connection unavailable')

function laneFor(method: string, input: unknown): Lane {
  if (method === 'ping' || method === 'shutdown' || method === 'adapterExited') return 'control'
  if (method === 'adapter' && objectOf(input)?.method === 'settleSend') return 'release'
  return 'normal'
}

function hasCapacity(entries: Iterable<{ lane: Lane }>, lane: Lane) {
  let count = 0
  const limit = lane === 'control' ? 3 : OWNER_RPC_MAX_ACTIVE
  for (const entry of entries) if (entry.lane === lane && ++count >= limit) return false
  return true
}

export function createOwnerRpcPeer(options: PeerOptions) {
  const outgoing = new Map<string, Outbound>()
  const incoming = new Map<string, { lane: Lane, controller: AbortController }>()
  let closed = false

  // The caller can stop waiting while the handler is still running. Retain its slot
  // until a terminal response or disconnect, so repeated timeouts cannot build a queue.
  function call<T>(method: string, input: unknown, optionsForCall: OwnerCallOptions = {}): Promise<T> {
    const { signal, budgetMs = OWNER_RPC_DEFAULT_BUDGET_MS, waitForCompletion = false } = optionsForCall
    if (closed) return Promise.reject(unavailable())
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > OWNER_RPC_MAX_BUDGET_MS) return Promise.reject(new Error('Invalid memory owner deadline'))
    const lane = laneFor(method, input)
    if (!hasCapacity(outgoing.values(), lane)) return Promise.reject(new Error('Memory owner request limit reached'))
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      function cancel(error: unknown) {
        cleanup()
        if (!waitForCompletion) reject(error)
        if (outgoing.has(id) && !closed) {
          try { options.send({ type: MEMORY_OWNER_RPC, kind: 'cancel', id }) }
          catch { /* The connection's exit handler releases its outstanding slots. */ }
        }
      }
      const abort = () => cancel(signal?.reason)
      const timer = setTimeout(() => cancel(new RequestTimeout()), budgetMs)
      timer.unref()
      outgoing.set(id, {
        lane,
        result(frame) {
          cleanup()
          if (frame.ok) resolve(frame.result as T)
          else if (frame.error.code === 'timeout') reject(new RequestTimeout())
          else {
            const details = parseMemoryDomainErrorDetails(frame.error.details)
            reject(Object.assign(new Error(frame.error.message), {
              code: frame.error.code, reason: frame.error.reason, ...(details ? { details } : {}),
            }))
          }
        },
        disconnect(error) { cleanup(); reject(error) },
      })
      signal?.addEventListener('abort', abort, { once: true })
      try { options.send({ type: MEMORY_OWNER_RPC, kind: 'request', id, method, input, budgetMs }) }
      catch (error) { outgoing.delete(id); cleanup(); reject(error) }
    })
  }

  function reply(frame: Extract<OwnerRpcFrame, { kind: 'request' }>, result: unknown, ok: boolean) {
    if (closed) return
    const base = { type: MEMORY_OWNER_RPC, kind: 'result', id: frame.id } as const
    try {
      if (ok) options.send({ ...base, ok: true, result })
      else {
        const error = result instanceof Error ? result : new Error('Memory owner operation failed')
        const details = parseMemoryDomainErrorDetails(
          'details' in error ? error.details : 'domainDetails' in error ? error.domainDetails : undefined,
        )
        options.send({ ...base, ok: false, error: { message: error.message.slice(0, 2_048),
          ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
          ...('reason' in error && typeof error.reason === 'string' ? { reason: error.reason } : {}),
          ...(details ? { details } : {}),
        } })
      }
    } catch { /* Disconnect handles orphaned requests. */ }
  }

  function receive(value: unknown): boolean {
    const frame = ownerRpcFrame(value)
    if (!frame) return false
    if (closed) return true
    if (frame.kind === 'event') options.onEvent?.(frame.event)
    else if (frame.kind === 'result') {
      const pending = outgoing.get(frame.id)
      outgoing.delete(frame.id)
      pending?.result(frame)
    } else if (frame.kind === 'cancel') incoming.get(frame.id)?.controller.abort(new Error('Memory owner request cancelled'))
    else if (!incoming.has(frame.id)) {
      const lane = laneFor(frame.method, frame.input)
      if (!hasCapacity(incoming.values(), lane)) {
        reply(frame, new Error('Memory owner request limit reached'), false)
        return true
      }
      const controller = new AbortController()
      incoming.set(frame.id, { lane, controller })
      const timer = setTimeout(() => controller.abort(new RequestTimeout()), frame.budgetMs)
      timer.unref()
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        if (!options.handle) throw new Error('Unsupported memory owner operation')
        return options.handle(frame.method, frame.input, controller.signal, frame.budgetMs)
      }).then(result => reply(frame, result, true), error => reply(frame, error, false)).finally(() => {
        clearTimeout(timer)
        incoming.delete(frame.id)
      })
    }
    return true
  }

  return { call, receive,
    notify(event: unknown) { if (!closed) options.send({ type: MEMORY_OWNER_RPC, kind: 'event', event }) },
    close() {
      if (closed) return
      closed = true
      for (const pending of outgoing.values()) pending.disconnect(unavailable())
      outgoing.clear()
      for (const { controller } of incoming.values()) controller.abort(unavailable())
    },
  }
}
