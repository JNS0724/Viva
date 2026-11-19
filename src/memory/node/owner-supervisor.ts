import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDiagnosticContext, safeDiagnosticEvent, safeDiagnosticReason } from '../../diagnostics/contracts.ts'
import { diagnosticContext, emitDiagnostic } from '../../diagnostics/node/context.ts'
import { createRequestBudget } from '../core/request-budget.ts'
import { memoryHostFailure } from '../contracts/domain-error.ts'
import { MEMORY_HOST_PROTOCOL, memoryHostRead, memoryOwnerState, type HostMemoryApi, type HostMemoryMethod,
  type MemoryOwnerChange, type MemoryOwnerContextUsed, type MemoryOwnerProjection, type MemoryOwnerState } from '../contracts/host.ts'
import { type MemoryOwnerHostResult, type MemoryOwnerSendRevoked, OWNER_RPC_MAX_BUDGET_MS } from '../contracts/owner-rpc.ts'
import { objectOf } from '../contracts/unknown-value.ts'
import type { MemoryComputeTools } from '../contracts/compute.ts'
import type { MemoryCompute } from '../contracts/memory-contract.ts'
import type { OwnerAdapterApi, OwnerAdapterCaller, OwnerCallOptions } from './owner-adapter.ts'
import { createOwnerRpcPeer } from './owner-rpc-peer.ts'

export type MemoryOwnerEvent = MemoryOwnerState | MemoryOwnerChange | MemoryOwnerContextUsed | MemoryOwnerProjection | MemoryOwnerSendRevoked | MemoryOwnerHostResult
export type MemoryOwnerCallbacks = {
  compute?(input: { job: MemoryCompute, tools?: MemoryComputeTools['tools'] }, signal: AbortSignal): Promise<string>
  quiesce?(input: { session?: string }, signal: AbortSignal): Promise<void>
  checkRecovery?(input: { checkId: string }, signal: AbortSignal): Promise<boolean>
  drainSends?(input: { epoch: string }): Promise<void>
}
type Options = {
  root: string
  hostNamespace?: string
  dailyNotes?: boolean
  embedding?: { modelRoot: string, runtimeRoot?: string }
  callbacks?: MemoryOwnerCallbacks
  onStatus?(state: MemoryOwnerState): void
  onEvent?(event: MemoryOwnerEvent): void
  timeoutMs?: number
  heartbeatMs?: number
}
type Instance = {
  child: ChildProcess
  peer: ReturnType<typeof createOwnerRpcPeer>
  exit: Promise<void>
  retire(): Promise<void>
  retiring(): boolean
  ready: Promise<void>
  epoch?: string
}
const HOST_EXECUTION_BUDGET_MS = 120_000
const STARTUP_BUDGET_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 6_000
const STOP_GRACE_MS = 1_000
const DRAIN_BUDGET_MS = 10_000

function workerEntry() {
  const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  return fileURLToPath(new URL('./owner-worker' + suffix, import.meta.url))
}

function resolveSettings({ root, hostNamespace, dailyNotes, embedding }: Options) {
  return { root: path.resolve(root), hostNamespace, dailyNotes, ...(embedding ? {
    embedding: { modelRoot: path.resolve(embedding.modelRoot), ...(embedding.runtimeRoot ? { runtimeRoot: path.resolve(embedding.runtimeRoot) } : {}) },
  } : {}) }
}

/** The parent only provides transport and model callbacks. Exactly one confirmed child owns the root. */
export function createMemoryOwnerSupervisor(options: Options) {
  const callbacks = options.callbacks
  const settings = resolveSettings(options)
  const listeners = new Set<(event: MemoryOwnerEvent) => void>()
  let current: Instance | undefined
  let snapshot: MemoryOwnerState | undefined
  let closing = false
  let started = false
  let restartTimer: ReturnType<typeof setTimeout> | undefined
  let closePromise: Promise<void> | undefined
  let startFailures = 0
  let previousEpoch: string | undefined
  let bootEverCompleted = false

  function publish(event: MemoryOwnerEvent) {
    if (event.type === 'memory_owner_state') {
      snapshot = event
      try { options.onStatus?.(event) } catch { /* Observers must not interrupt supervision. */ }
    }
    try { options.onEvent?.(event) } catch { /* Observers must not interrupt supervision. */ }
    for (const listener of listeners) {
      try { listener(event) } catch { /* Observers must not interrupt supervision. */ }
    }
  }

  function scheduleRestart() {
    if (closing || !started || restartTimer) return
    const delay = Math.min(5_000, 250 * 2 ** Math.min(startFailures, 5))
    emitDiagnostic({ event: 'retry.scheduled', operation: 'memory.owner', stage: 'recovering', reason: 'process_exited',
      identities: { ownerEpoch: previousEpoch }, metrics: { retryDelayMs: delay } })
    restartTimer = setTimeout(() => {
      restartTimer = undefined
      void start().catch(() => {})
    }, delay)
    restartTimer.unref()
  }

  async function drainOldSends(milliseconds = DRAIN_BUDGET_MS) {
    const epoch = previousEpoch
    if (!epoch) return
    const budget = createRequestBudget(milliseconds)
    try {
      await budget.run(() => callbacks?.drainSends?.({ epoch }))
      if (previousEpoch === epoch) previousEpoch = undefined
    } finally { budget.close() }
  }

  function unavailable(instance: Instance) {
    if (!instance.epoch) return
    previousEpoch = instance.epoch
    if (snapshot?.epoch === instance.epoch && snapshot.state !== 'unavailable') publish({ ...snapshot, state: 'unavailable' })
  }

  let launching: Promise<void> | undefined
  function start(): Promise<void> {
    if (closing) return Promise.reject(new Error('Memory owner supervisor is closed'))
    started = true
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined }
    if (launching) return launching
    if (current?.retiring()) return current.exit.then(start)
    if (current) return current.ready
    const operation = (async () => {
      try {
        await drainOldSends()
        if (closing) throw new Error('Memory owner supervisor is closed')
        const instance = spawn()
        await instance.ready
      } catch (error) {
        startFailures++
        scheduleRestart()
        throw error
      }
    })()
    launching = operation.finally(() => { launching = undefined })
    return launching
  }

  function spawn(): Instance {
    const child = fork(workerEntry(), ['--memory-owner-ipc'], {
      execPath: process.execPath, execArgv: [], windowsHide: true, serialization: 'advanced',
      env: { ELECTRON_RUN_AS_NODE: '1', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    emitDiagnostic({ event: 'process.start', operation: 'memory.owner', stage: previousEpoch ? 'recovering' : 'connecting' })
    let reaped: () => void = () => {}
    const exit = new Promise<void>(resolve => { reaped = resolve })
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    let retiring = false
    const peer = createOwnerRpcPeer({
      send(frame) {
        if (!child.connected || retiring) throw new Error('Memory owner disconnected')
        child.send(frame, error => { if (error) void instance.retire() })
      },
      handle(method, raw, signal) {
        if (retiring || current !== instance) throw new Error('Memory owner generation retired')
        const input = objectOf(raw)
        switch (method) {
          case 'quiesce':
            return callbacks?.quiesce?.(typeof input?.session === 'string' ? { session: input.session } : {}, signal)
          case 'compute':
            if (!callbacks?.compute || !input || !objectOf(input.job)) throw new Error('Memory computation is unavailable')
            return callbacks.compute(input as Parameters<NonNullable<MemoryOwnerCallbacks['compute']>>[0], signal)
          case 'checkRecovery':
            if (typeof input?.checkId !== 'string' || !callbacks?.checkRecovery) return false
            return callbacks.checkRecovery({ checkId: input.checkId }, signal)
          default: throw new Error('Unsupported memory owner callback')
        }
      },
      onEvent(raw) {
        if (current !== instance || retiring || !raw || typeof raw !== 'object' || !('type' in raw)) return
        if (raw.type === 'memory_owner_state') {
          const state = memoryOwnerState.safeParse(raw)
          if (!state.success || instance.epoch && instance.epoch !== state.data.epoch) return
          instance.epoch = state.data.epoch
          publish(state.data)
        } else if ((raw.type === 'memory_owner_context_used' || raw.type === 'memory_owner_projection'
          || raw.type === 'memory_owner_change' || raw.type === 'memory_owner_send_revoked')
          && 'epoch' in raw && instance.epoch && instance.epoch === raw.epoch) publish(raw as MemoryOwnerEvent)
      },
    })
    function pulse() {
      if (closing || retiring || current !== instance) return
      const interval = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS
      heartbeat = setTimeout(async () => {
        try {
          await peer.call('ping', null, { budgetMs: interval })
          startFailures = 0
          pulse()
        } catch (error) {
          emitDiagnostic({ event: 'health', operation: 'memory.owner', stage: 'unavailable', reason: safeDiagnosticReason(error),
            identities: { ownerEpoch: instance.epoch } })
          void instance.retire()
        }
      }, interval)
      heartbeat.unref()
    }
    async function retire() {
      if (!retiring) {
        retiring = true
        clearTimeout(heartbeat)
        unavailable(instance)
        if (child.pid !== undefined) {
          try { child.kill('SIGKILL') } catch { /* The OS still owns the exit notification. */ }
        }
      }
      await exit
    }
    const instance: Instance = {
      child, peer, exit, retire, retiring: () => retiring,
      ready: Promise.resolve().then(async () => {
        try {
          await peer.call('boot', { ...settings, preserveActiveTurns: bootEverCompleted }, { budgetMs: options.timeoutMs ?? STARTUP_BUDGET_MS })
          bootEverCompleted = true
          pulse()
        } catch (error) { await retire(); throw error }
      }),
    }
    current = instance
    child.on('message', frame => {
      if (retiring || peer.receive(frame)) return
      const message = objectOf(frame)
      if (message?.type !== 'memory_owner_diagnostic' || typeof message.epoch !== 'string' || instance.epoch && message.epoch !== instance.epoch) return
      const event = safeDiagnosticEvent(message.event)
      if (event) emitDiagnostic(event, parseDiagnosticContext(message.context))
    })
    child.once('disconnect', () => { void retire() })
    child.on('error', () => { void retire() })
    child.once('close', () => {
      clearTimeout(heartbeat)
      if (current === instance) {
        unavailable(instance)
        current = undefined
      }
      // The terminal event follows confirmed OS exit. Host read slots can now be released safely.
      peer.close()
      if (instance.epoch && !closing) startFailures++
      emitDiagnostic({ event: 'process.exit', operation: 'memory.owner',
        reason: closing ? 'normal' : 'process_exited', identities: { ownerEpoch: instance.epoch } })
      reaped()
      scheduleRestart()
    })
    return instance
  }

  function openPeer() {
    if (closing || !current || !snapshot || snapshot.state === 'unavailable' || snapshot.epoch !== current.epoch) throw new Error('Memory owner is unavailable')
    return current
  }

  async function callCurrent<T>(method: string, input: unknown, optionsForCall?: OwnerCallOptions) {
    const instance = openPeer()
    const value = await instance.peer.call<T>(method, input, optionsForCall)
    if (openPeer() !== instance) throw new Error('Memory owner generation retired')
    return value
  }

  const callAdapter: OwnerAdapterCaller['callAdapter'] = <M extends keyof OwnerAdapterApi>(
    method: M, args: Parameters<OwnerAdapterApi[M]>, optionsForCall?: OwnerCallOptions,
  ) => callCurrent<Awaited<ReturnType<OwnerAdapterApi[M]>>>('adapter', { method, args }, optionsForCall)

  function callHost<M extends HostMemoryMethod>(method: M, input: HostMemoryApi[M]['input'], optionsForCall?: OwnerCallOptions) {
    return callCurrent<HostMemoryApi[M]['output']>('host', { method, input, diagnostics: diagnosticContext() }, optionsForCall)
  }

  function sendHost(raw: object) {
    const message = objectOf(raw)
    if (message?.type !== 'memory_host_request' || message.protocol !== MEMORY_HOST_PROTOCOL || message.epoch !== snapshot?.epoch
      || typeof message.requestId !== 'string' || typeof message.epoch !== 'string') throw new Error('Memory host protocol or epoch mismatch')
    const { epoch, requestId, method, input, read } = message
    const budgetMs = read === undefined ? HOST_EXECUTION_BUDGET_MS : memoryHostRead.parse(read).budgetMs
    const { peer } = openPeer()
    const base = { type: 'memory_host_result', requestId, epoch } as const
    void peer.call('host', { method, input, read, requestId, diagnostics: parseDiagnosticContext(message.diagnostics) }, { budgetMs, waitForCompletion: true }).then(
      result => publish({ ...base, ok: true, result }), error => publish({ ...base, ok: false, error: memoryHostFailure(error) }),
    )
  }

  async function shutdown() {
    closing = true
    clearTimeout(restartTimer)
    const instance = current
    if (!instance) return
    unavailable(instance)
    try {
      await drainOldSends(STOP_GRACE_MS)
      await instance.peer.call('shutdown', null, { budgetMs: STOP_GRACE_MS })
    } catch { /* SQLite releases its lock on process exit even if graceful shutdown is blocked. */ }
    await instance.retire()
  }

  return {
    start, close: () => closePromise ??= shutdown(), sendHost, callHost, callAdapter,
    async adapterExited() {
      const instance = current
      if (!instance) return
      await instance.ready
      if (current === instance && !closing && snapshot?.state !== 'unavailable') await instance.peer.call('adapterExited', {})
    },
    nativeMaintenancePending: () => callCurrent<boolean>('nativeMaintenancePending', {}, { budgetMs: Math.min(options.timeoutMs ?? STARTUP_BUDGET_MS, OWNER_RPC_MAX_BUDGET_MS) }),
    subscribe(listener: (event: MemoryOwnerEvent) => void) {
      listeners.add(listener)
      if (snapshot) listener(snapshot)
      return () => { listeners.delete(listener) }
    },
    status: () => snapshot?.state ?? 'recovering',
    epoch: () => snapshot?.epoch,
    pid: () => current?.child.pid,
    state: () => snapshot,
  }
}

export type MemoryOwnerSupervisor = ReturnType<typeof createMemoryOwnerSupervisor>
