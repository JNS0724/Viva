import { memoryDomainErrorCode } from '../memory/contracts/domain-error.ts'
import { t } from '../shared/i18n/translate.ts'
import { randomUUID } from 'node:crypto'
import { MEMORY_HOST_PROTOCOL, memoryOwnerState, memoryOwnerChange, memoryOwnerContextUsed, memoryOwnerProjection, parseHostMemoryCommand } from '../memory/contracts/host.ts'
import type { HostMemoryApi, HostMemoryMethod, MemoryOwnerState, MemoryOwnerChange, MemoryOwnerContextUsed, MemoryOwnerProjection } from '../memory/contracts/host.ts'
import { objectOf } from '../shared/unknown-value.ts'

export class MemoryOwnerUnavailable extends Error {
  readonly code = 'unavailable'
  constructor(message = 'Memory owner is unavailable') { super(message) }
}
/** Parent IPC is the authentication boundary. A replaced owner never inherits pending calls. */
export function createRemoteMemoryChannel({ send, onReady, onChanged, onNotice, onContextUsed, onProjection, timeoutMs = 30_000 }: {
  send: (message: object) => void, onReady?: () => void, onChanged?: (state: MemoryOwnerState) => void, onNotice?: (notice: MemoryOwnerChange) => void,
  onContextUsed?: (notice: MemoryOwnerContextUsed) => void, onProjection?: (notice: MemoryOwnerProjection) => void, timeoutMs?: number,
}) {
  let current: MemoryOwnerState | undefined
  let closed = false
  const waiters = new Set<{ resolve(): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  const pending = new Map<string, { epoch: string, resolve(value: unknown): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  function invalidate(message: string) {
    current = undefined
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new MemoryOwnerUnavailable(message)) }
    pending.clear()
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new MemoryOwnerUnavailable(message)) }
    waiters.clear()
  }
  async function call<M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']): Promise<HostMemoryApi[M]['output']> {
    const recovery = ['getOperation', 'prepareSourceChange', 'commitSourceChange', 'sourceAlias', 'pendingHostEffects', 'ackHostEffect'].includes(method)
    if (closed || !current || current.state !== 'ready' && !(recovery && current.state === 'recovering')) throw new MemoryOwnerUnavailable()
    const command = parseHostMemoryCommand(method, input)
    const requestId = randomUUID(), epoch = current.epoch
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new MemoryOwnerUnavailable('Memory owner request timed out')) }, timeoutMs)
      pending.set(requestId, { epoch, resolve, reject, timer })
      try { send({ type: 'memory_host_request', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch, ...command }) }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error) }
    })
    // Only the authenticated child IPC can reach receive(). The method correlates this result
    // with the owner's explicit handler; callers cannot choose a runtime property to execute.
    return result as HostMemoryApi[M]['output']
  }
  function receive(raw: unknown) {
    const msg = objectOf(raw)
    if (!msg) return false
    if (msg.type === 'memory_owner_context_used') {
      const notice = memoryOwnerContextUsed.safeParse(raw)
      if (!closed && notice.success && current?.epoch === notice.data.epoch && notice.data.revision >= current.revision) onContextUsed?.(notice.data)
      return true
    }
    if (msg.type === 'memory_owner_projection') {
      const notice = memoryOwnerProjection.safeParse(raw)
      if (!closed && notice.success && current?.epoch === notice.data.epoch && notice.data.revision >= current.revision) onProjection?.(notice.data)
      return true
    }
    if (msg.type === 'memory_owner_change') {
      const notice = memoryOwnerChange.safeParse(raw)
      if (!closed && notice.success && current?.epoch === notice.data.epoch && notice.data.revision >= current.revision) onNotice?.(notice.data)
      return true
    }
    if (msg.type === 'memory_owner_state') {
      const state = memoryOwnerState.safeParse(raw)
      if (!state.success || closed) return true
      const wasReady = current?.state === 'ready' && current.epoch === state.data.epoch
      if (current && current.epoch !== state.data.epoch || state.data.state === 'unavailable') invalidate('Memory owner generation changed')
      current = state.data
      onChanged?.(state.data)
      if (current.state === 'ready') {
        for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve() }
        waiters.clear()
        if (!wasReady) onReady?.()
      }
      return true
    }
    if (msg.type !== 'memory_host_result') return false
    if (typeof msg.requestId !== 'string' || typeof msg.epoch !== 'string') return true
    const item = pending.get(msg.requestId)
    if (!item || item.epoch !== msg.epoch || current?.epoch !== msg.epoch) return true
    pending.delete(msg.requestId); clearTimeout(item.timer)
    if (msg.ok === true) item.resolve(msg.result)
    else {
      const failure = objectOf(msg.error) ?? {}
      const domain = memoryDomainErrorCode.safeParse(failure.domainCode)
      const error = new Error(domain.success ? t(`main.memory.${domain.data}`) : typeof failure.reason === 'string' ? failure.reason : 'Memory owner request failed')
      Object.assign(error, { code: typeof failure.code === 'string' ? failure.code : 'unavailable',
        ...(domain.success ? { domainCode: domain.data } : {}) })
      item.reject(error)
    }
    return true
  }
  function waitReady(): Promise<void> {
    if (current?.state === 'ready' && !closed) return Promise.resolve()
    if (closed) return Promise.reject(new MemoryOwnerUnavailable())
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { waiters.delete(waiter); reject(new MemoryOwnerUnavailable('Memory owner did not become ready')) }, timeoutMs) }
      waiters.add(waiter)
    })
  }
  return { call, receive, waitReady, ready: () => current?.state === 'ready' && !closed, state: () => current,
    processExited: () => invalidate('Memory owner disconnected'),
    close: () => { closed = true; invalidate('Memory owner connection closed') },
  }
}
export type RemoteMemoryChannel = ReturnType<typeof createRemoteMemoryChannel>
