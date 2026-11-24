import type { OwnerCallOptions } from '../memory/node/owner-adapter.ts'
import { DAILY_MEMORY_DEFAULTS } from '../memory/contracts/memory-daily-defaults.ts'
import { memoryDomainErrorCode, memoryHostFailure, parseMemoryDomainErrorDetails } from '../memory/contracts/domain-error.ts'
import { t } from '../shared/i18n/translate.ts'
import { randomUUID } from 'node:crypto'
import { MEMORY_HOST_PROTOCOL, MEMORY_PAGE_READ_METHODS, memoryOwnerState, memoryOwnerChange, memoryOwnerContextUsed, parseHostMemoryCommand } from '../memory/contracts/host.ts'
import type { HostMemoryApi, HostMemoryCaller, HostMemoryMethod, MemoryOwnerState, MemoryOwnerChange, MemoryOwnerContextUsed } from '../memory/contracts/host.ts'
import { createRequestBudget, MEMORY_PAGE_READ_LIMIT, MEMORY_READ_BUDGET_MS, RequestTimeout } from '../shared/request-budget.ts'
import { objectOf } from '../shared/unknown-value.ts'
import { diagnosticContext, emitDiagnostic, withOperation } from '../diagnostics/node/context.ts'
import { safeDiagnosticReason } from '../diagnostics/contracts.ts'
import type { DiagnosticContext, DiagnosticFields, DiagnosticStage } from '../diagnostics/contracts.ts'

// Protocol read labels only; they never affect admission, dispatch, or memory facts.
const READ_STAGE: Partial<Record<HostMemoryMethod, DiagnosticStage>> = { profilePage: 'profile', cleanupPending: 'cleanup', revision: 'revision' }

export class MemoryOwnerUnavailable extends Error {
  readonly code = 'unavailable'
  constructor(message = 'Memory owner is unavailable') { super(message) }
}
export class MemoryReadBusy extends Error {
  readonly code = 'busy'
  constructor() { super('Memory reads are busy; retry after an active read finishes') }
}
type ReadBatch = { id: string, epoch: string, lifetime: ReturnType<typeof createRequestBudget>, sealed: boolean, executions: number }
type OwnerTransport = <M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input'],
  options: OwnerCallOptions) => Promise<HostMemoryApi[M]['output']>
export interface MemoryChannelEvents {
  onReady?: () => void
  onChanged?: (state: MemoryOwnerState) => void
  onNotice?: (notice: MemoryOwnerChange) => void
  onContextUsed?: (notice: MemoryOwnerContextUsed) => void
}

function channelError(failure: Record<string, unknown>) {
  const domain = memoryDomainErrorCode.safeParse(failure.domainCode)
  const details = parseMemoryDomainErrorDetails(failure.domainDetails)
  const message = !domain.success
    ? (typeof failure.reason === 'string' ? failure.reason : 'Memory owner request failed')
    : domain.data === 'profile.confirmed_too_long'
      ? t('main.memory.profile.confirmed_too_long', details ?? { limit: 800, actual: 0 })
      : t(`main.memory.${domain.data}`)
  const error = new Error(message)
  return Object.assign(error, {
    code: typeof failure.code === 'string' ? failure.code : 'unavailable',
    ...(domain.success ? { domainCode: domain.data } : {}),
    ...(details ? { details } : {}),
  })
}

/** The desktop supervisor owns its RPC transport. Only the native dsh channel sends legacy host frames. */
export function createRemoteMemoryChannel({ send, callOwner, onReady, onChanged, onNotice, onContextUsed, timeoutMs = 30_000 }:
  MemoryChannelEvents & { timeoutMs?: number } & ({ send(message: object): void, callOwner?: never } | { callOwner: OwnerTransport, send?: never })) {
  let connectionLifetime = new AbortController()
  let current: MemoryOwnerState | undefined
  let closed = false
  // These are actual executions, not caller waiters. Timeout does not free an owner slot.
  const batches = new Map<string, ReadBatch>()
  const executions = new Map<string, ReadBatch>()
  function settleExecution(requestId: string, epoch: string) {
    const batch = executions.get(requestId)
    if (!batch || batch.epoch !== epoch) return
    executions.delete(requestId); releaseExecution(batch)
  }
  function releaseExecution(batch: ReadBatch) {
    batch.executions--
    if (batch.sealed && !batch.executions) batches.delete(batch.id)
  }
  const waiters = new Set<{ resolve(): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  const pending = new Map<string, { epoch: string, context?: DiagnosticContext, fields: DiagnosticFields, started: number, resolve(value: unknown): void, reject(error: Error): void, timer: ReturnType<typeof setTimeout> }>()
  function invalidate(message: string, releaseExecutions = true) {
    current = undefined
    connectionLifetime.abort(new MemoryOwnerUnavailable(message))
    connectionLifetime = new AbortController()
    for (const item of pending.values()) {
      emitDiagnostic({ ...item.fields, event: 'wait.end', operation: 'memory.owner', reason: 'epoch_changed', metrics: { durationMs: performance.now() - item.started } }, item.context)
      clearTimeout(item.timer); item.reject(new MemoryOwnerUnavailable(message))
    }
    pending.clear()
    for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new MemoryOwnerUnavailable(message)) }
    waiters.clear()
    for (const batch of batches.values()) { batch.lifetime.cancel(new MemoryOwnerUnavailable(message)); batch.lifetime.close() }
    if (releaseExecutions) { batches.clear(); executions.clear() }
  }
  async function execute<M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input'], batch?: ReadBatch, intake?: ReturnType<typeof createRequestBudget>): Promise<HostMemoryApi[M]['output']> {
    const budgetMs = batch?.lifetime.remainingMs() ?? intake?.remainingMs()
    if (batch && (!MEMORY_PAGE_READ_METHODS.has(method) || batch.epoch !== current?.epoch || !batches.has(batch.id))) throw new MemoryOwnerUnavailable()
    const recovery = method === 'getOperation'
    if (closed || !current || current.state !== 'ready' && !(recovery && current.state === 'recovering')) {
      emitDiagnostic({ event: 'operation.progress', operation: 'memory.owner', stage: READ_STAGE[method], reason: closed ? 'closed' : 'not_ready', identities: { methodId: method, ownerEpoch: current?.epoch ?? null } })
      throw new MemoryOwnerUnavailable()
    }
    if (callOwner) {
      const request = batch?.lifetime ?? intake
      const signal = request ? AbortSignal.any([request.signal, connectionLifetime.signal]) : connectionLifetime.signal
      if (batch) batch.executions++
      const fields: DiagnosticFields = { stage: READ_STAGE[method], identities: { methodId: method, ownerEpoch: current.epoch, readBatchId: batch?.id } }
      const started = performance.now()
      try {
        emitDiagnostic({ ...fields, event: 'wait.begin', operation: 'memory.owner' })
        // readBatch owns the caller deadline. This promise observes actual completion
        // so a timed-out caller cannot free one of the two physical execution slots.
        const value = await callOwner(method, input, { signal, budgetMs: budgetMs ?? timeoutMs, waitForCompletion: Boolean(batch),
          ...(intake && budgetMs !== undefined ? { deadlineAt: Date.now() + budgetMs } : {}) })
        signal.throwIfAborted()
        emitDiagnostic({ ...fields, event: 'wait.end', operation: 'memory.owner', metrics: { ok: true, durationMs: performance.now() - started } })
        return value
      } catch (error) {
        emitDiagnostic({ ...fields, event: 'wait.end', operation: 'memory.owner', reason: safeDiagnosticReason(error), metrics: { ok: false, durationMs: performance.now() - started } })
        signal.throwIfAborted()
        if (error instanceof RequestTimeout) throw error
        throw channelError(memoryHostFailure(error))
      } finally { if (batch) releaseExecution(batch) }
    }
    const command = parseHostMemoryCommand(method, input)
    const requestId = randomUUID(), epoch = current.epoch
    const fields: DiagnosticFields = { stage: READ_STAGE[method], identities: { requestId, ownerEpoch: epoch, methodId: method, ...(batch ? { readBatchId: batch.id } : {}) } }
    const started = performance.now()
    const result = await new Promise<unknown>((resolve, reject) => {
      const timedOut = () => {
        pending.delete(requestId)
        emitDiagnostic({ ...fields, event: 'wait.end', operation: 'memory.owner', reason: 'timeout', outcome: 'timed_out', metrics: { durationMs: performance.now() - started } })
        finish()
        reject(batch?.lifetime.signal.reason ?? new RequestTimeout())
      }
      const timer = setTimeout(timedOut, Math.min(timeoutMs, budgetMs ?? timeoutMs))
      const finish = () => { clearTimeout(timer); batch?.lifetime.signal.removeEventListener('abort', timedOut) }
      batch?.lifetime.signal.addEventListener('abort', timedOut, { once: true })
      pending.set(requestId, { epoch, context: diagnosticContext(), fields, started,
        resolve: value => { finish(); resolve(value) }, reject: error => { finish(); reject(error) }, timer })
      try {
        emitDiagnostic({ ...fields, event: 'wait.begin', operation: 'memory.owner', metrics: { pendingCount: pending.size } })
        const read = batch ? { readBatchId: batch.id, budgetMs: batch.lifetime.remainingMs() } : undefined
        if (batch) { executions.set(requestId, batch); batch.executions++ }
        send({ type: 'memory_host_request', protocol: MEMORY_HOST_PROTOCOL, requestId, epoch, ...command,
          ...(read ? { read } : {}), diagnostics: diagnosticContext() })
      }
      catch (error) {
        finish(); pending.delete(requestId)
        settleExecution(requestId, epoch)
        emitDiagnostic({ ...fields, event: 'wait.end', operation: 'memory.owner', outcome: 'failed', reason: safeDiagnosticReason(error), metrics: { durationMs: performance.now() - started } })
        reject(error)
      }
    })
    // Only the authenticated child IPC can reach receive(). The method correlates this result
    // with the owner's explicit handler; callers cannot choose a runtime property to execute.
    return result as HostMemoryApi[M]['output']
  }
  // A caller operation already owns this wait; do not create a second proxy span inside each read step.
  const call = <M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) => diagnosticContext() ? execute(method, input)
    : withOperation('memory.owner', () => execute(method, input), { identities: { methodId: method, ownerEpoch: current?.epoch ?? '' } })
  async function callIntake<M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input']) {
    const budget = createRequestBudget(DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs)
    // Send the intake frame before dispatching the agent request on its separate channel.
    try {
      const pending = execute(method, input, undefined, budget)
      return await budget.run(() => pending)
    }
    finally { budget.close() }
  }
  async function readBatch<T>(work: (read: HostMemoryCaller) => Promise<T>, options: { budgetMs?: number, signal?: AbortSignal } = {}): Promise<T> {
    if (closed || current?.state !== 'ready') throw new MemoryOwnerUnavailable()
    if (batches.size >= MEMORY_PAGE_READ_LIMIT) {
      emitDiagnostic({ event: 'operation.progress', operation: 'memory.get', reason: 'busy', metrics: { pendingCount: batches.size } })
      throw new MemoryReadBusy()
    }
    const lifetime = createRequestBudget(Math.min(MEMORY_READ_BUDGET_MS, options.budgetMs ?? MEMORY_READ_BUDGET_MS), options.signal)
    const batch: ReadBatch = { id: randomUUID(), epoch: current.epoch, lifetime, sealed: false, executions: 0 }
    batches.set(batch.id, batch)
    try { return await lifetime.run(() => work((method, input) => execute(method, input, batch))) }
    finally {
      batch.sealed = true; lifetime.close()
      if (!batch.executions) batches.delete(batch.id)
    }
  }
  function receive(raw: unknown) {
    const msg = objectOf(raw)
    if (!msg) return false
    if (msg.type === 'memory_owner_context_used') {
      const notice = memoryOwnerContextUsed.safeParse(raw)
      if (!closed && notice.success && current?.epoch === notice.data.epoch && notice.data.revision >= current.revision) onContextUsed?.(notice.data)
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
      if (current && current.epoch !== state.data.epoch) invalidate('Memory owner generation changed')
      else if (state.data.state === 'unavailable') invalidate('Memory owner is unavailable', false)
      current = state.data
      emitDiagnostic({ event: 'state.changed', operation: 'memory.owner', stage: current.state, identities: { ownerEpoch: current.epoch }, metrics: { pendingCount: pending.size } })
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
    // Authenticated terminal replies settle execution even after the UI waiter has expired.
    if (typeof msg.ok !== 'boolean') return true
    settleExecution(msg.requestId, msg.epoch)
    const item = pending.get(msg.requestId)
    if (!item || item.epoch !== msg.epoch || current?.epoch !== msg.epoch) {
      emitDiagnostic({ event: 'operation.progress', operation: 'memory.owner', reason: 'late', identities: { requestId: msg.requestId, ownerEpoch: msg.epoch } })
      return true
    }
    pending.delete(msg.requestId); clearTimeout(item.timer)
    emitDiagnostic({ ...item.fields, event: 'wait.end', operation: 'memory.owner', metrics: { durationMs: performance.now() - item.started, pendingCount: pending.size, ok: msg.ok === true } }, item.context)
    if (msg.ok === true) item.resolve(msg.result)
    else {
      const failure = objectOf(msg.error) ?? {}
      item.reject(channelError(failure))
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
  return { call, readBatch, receive, waitReady, ready: () => current?.state === 'ready' && !closed, state: () => current,
    readState: () => ({ batches: batches.size, executions: [...batches.values()].reduce((sum, batch) => sum + batch.executions, 0) }),
    processExited: () => invalidate('Memory owner disconnected'),
    callIntake,
    close: () => { closed = true; invalidate('Memory owner connection closed') },
  }
}
export type RemoteMemoryChannel = ReturnType<typeof createRemoteMemoryChannel>
