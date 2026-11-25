import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import type { AutomaticRecallResult } from '../../../src/memory/contracts/memory-contract.ts'
import { isDailyMemoryStage } from '../../../src/memory/contracts/memory-contract.ts'
import { DAILY_MEMORY_DEFAULTS } from '../../../src/memory/contracts/memory-daily-defaults.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'
import {
  memoryOwnerChange,
  memoryOwnerContextUsed,
  memoryOwnerProfile,
  memoryOwnerState,
  type MemoryProfileSnapshot,
} from '../../../src/memory/contracts/host.ts'
import { dateLine, formatAutomaticRecallMessage, formatMemoryRulesSection, formatProfileContext } from '../../../src/memory/core/memory-context.ts'
import { looksSecret } from '../../../src/memory/core/memory-sensitive.ts'
import { resolveMemoryProject } from '../../../src/memory/node/project-scope.ts'
import { createRequestBudget, APP_WRITE_TIMEOUT_MS, MEMORY_READ_BUDGET_MS } from '../../../src/shared/request-budget.ts'
import { requestsIn, withoutHeaders } from '../../../src/shared/request-routing/header.ts'
import { leadingTaskRequestId, withoutTaskHeaders } from '../../../src/shared/request-routing/task-header.ts'
import { createManagedDiagnostics } from '../../../src/diagnostics/node/managed.ts'
import { createDiagnosticHub } from '../../../src/diagnostics/node/hub.ts'
import { emitDiagnostic, emitDiagnosticFailure, installDiagnosticPort } from '../../../src/diagnostics/node/context.ts'
import type { MemoryPluginConfig } from './config.ts'
import { attachHostMemoryRelay } from './host-relay.ts'
import { openPluginOwner } from './standalone-owner.ts'
import { createRemoteMemoryOwner } from './remote-owner.ts'
import { createSessionIngestion, humanMessages } from './ingestion.ts'
import { completeMemoryModel, memoryProviderFailure } from './model.ts'
import { registerMemoryTools } from './tools.ts'
import { registerMemoryFileCommands } from './file-commands.ts'
import { observeDshDiagnostics } from './diagnostics.ts'
import type {} from './source.ts'

const MAX_SOFT_YIELD_MS = 30_000
const SOFT_YIELD_DEFER_MS = 3_000

function extractCorrelationRequestId(text: string): string | undefined {
  const leadingTask = leadingTaskRequestId(text)
  if (leadingTask) return leadingTask
  const routed = requestsIn(text)
  if (routed.length > 0) return routed[routed.length - 1]!.id
  return undefined
}

export function applyMemoryAdapter(ctx: Context, config: MemoryPluginConfig = {}, port = process) {
  const lifetime = new AbortController()
  const root = path.resolve(config.dataRoot ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'memory'))
  const diagnostics = createManagedDiagnostics({
    directory: typeof config.diagnosticsRoot === 'string' && path.isAbsolute(config.diagnosticsRoot)
      ? config.diagnosticsRoot : path.join(root, 'diagnostics'),
    component: 'dsh', componentVersion: '0.2.0',
    version: typeof config.diagnosticsVersion === 'string' ? config.diagnosticsVersion : 'unknown',
  })
  const restoreDiagnostics = installDiagnosticPort(diagnostics)
  const diagnosticHub = createDiagnosticHub({ component: 'dsh', writers: [{ component: 'dsh', writer: diagnostics }],
    ...(config.host ? { send: (message: object, settled: (error?: Error | null) => void) => {
      if (port.connected && port.send) port.send(message, settled)
      else settled(new Error('Diagnostic parent disconnected'))
    } } : {}) })
  const receiveDiagnostic = (raw: unknown) => { diagnosticHub.receive(raw) }
  if (config.host) port.on('message', receiveDiagnostic)
  observeDshDiagnostics(ctx)
  emitDiagnostic({ event: 'process.start', operation: 'startup' })

  const report = (error: unknown) => emitDiagnosticFailure('memory.intake', error)
  const embedding = config.modelRoot ? { modelRoot: config.modelRoot, runtimeRoot: config.runtimeRoot } : undefined

  // Foreground streaming awareness for soft background yielding (never aborts in-flight background work).
  let activeForegroundStreams = 0
  let firstDeferredAt: number | undefined
  let yieldExempt = false
  ctx.on('llm/stream', (options, next) => {
    if (!isAgentLoopRequest(options)) return next()
    const stream = next()
    return (async function* () {
      activeForegroundStreams++
      try {
        for await (const chunk of stream) yield chunk
      } finally {
        activeForegroundStreams = Math.max(0, activeForegroundStreams - 1)
        if (activeForegroundStreams === 0) {
          firstDeferredAt = undefined
          yieldExempt = false
        }
      }
    })()
  })

  const connection = openPluginOwner({ root, hostNamespace: config.host ? 'viva' : undefined, embedding, dailyNotes: config.dailyNotes ?? true,
    callbacks: {
      async compute({ job, tools }, signal) {
        if (activeForegroundStreams > 0 && job.manual !== true && !yieldExempt) {
          const nowMs = Date.now()
          if (firstDeferredAt === undefined) firstDeferredAt = nowMs
          if (nowMs - firstDeferredAt < MAX_SOFT_YIELD_MS) {
            throw new MemoryComputeError('deferred', { retryAfterMs: SOFT_YIELD_DEFER_MS })
          }
          yieldExempt = true
        }
        const deadline = AbortSignal.timeout(isDailyMemoryStage(job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : 115_000)
        const combined = AbortSignal.any([lifetime.signal, deadline, signal])
        try {
          return await completeMemoryModel(ctx, job, combined, tools
            ? { tools, executeTool: input => owner.call('computeTool', [job.id, input], { signal: combined }) }
            : undefined)
        } catch (error) {
          if (error instanceof MemoryComputeError) throw error
          if (combined.aborted) throw new MemoryComputeError(combined.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted')
          throw memoryProviderFailure(error) ?? new MemoryComputeError('call-failed')
        }
      },
    },
  }, port)
  const owner = createRemoteMemoryOwner(connection)
  const available = () => !lifetime.signal.aborted && owner.ready()
  const intake = createSessionIngestion(owner, session => ctx.sessions.flush(session), { host: Boolean(config.host) })
  let cachedProfile: MemoryProfileSnapshot | undefined
  let currentRevision: number | undefined
  let observedEpoch: string | undefined
  const pendingContextConfirmations = new Map<string, { session: string, turn: number, pushed: Array<{ text: string, names: string[] }> }>()
  let route: { provider: string, model: string } | null = null
  let published: { epoch: string | undefined, provider: string, model: string } | undefined

  const hostRelay = attachHostMemoryRelay({
    connection,
    port,
    signal: lifetime.signal,
    getEpoch: () => owner.epoch,
    enabled: Boolean(config.host),
    onHostSuccess(method, input) {
      if (method !== 'sourceAlias' || !input || typeof input !== 'object' || !('session' in input)) return
      const targetId = (input as { session?: unknown }).session
      if (typeof targetId !== 'string') return
      const session = ctx.sessions.list().find(item => String(item.id) === targetId)
      if (session) observe(session)
    },
  })
  const sendParent = hostRelay.sendParent

  function acceptProfile(next: MemoryProfileSnapshot) {
    const activeEpoch = owner.epoch ?? observedEpoch
    if (activeEpoch && next.epoch !== activeEpoch) return
    if (cachedProfile && cachedProfile.epoch === next.epoch && next.revision < cachedProfile.revision) return
    cachedProfile = { epoch: next.epoch, revision: next.revision, text: next.text }
  }
  function currentProfileText(): string {
    if (!owner.ready() || !cachedProfile) return ''
    if (cachedProfile.epoch !== owner.epoch) return ''
    return cachedProfile.text
  }
  function clearPendingForSession(sessionId: string) {
    for (const [messageId, entry] of pendingContextConfirmations) {
      if (entry.session === sessionId) pendingContextConfirmations.delete(messageId)
    }
  }

  function publishRoute() {
    if (!available()) return
    const selected = route ?? ctx.agents.list().map(agent => agent.model.current()).find(value => value !== undefined)
    if (!selected) return
    const next = { epoch: owner.epoch, provider: selected.provider, model: selected.model }
    if (published && published.epoch === next.epoch && published.provider === next.provider && published.model === next.model) return
    published = next
    void owner.call('setRoute', [{ provider: next.provider, model: next.model }]).catch(error => {
      if (published === next) published = undefined
      report(error)
    })
  }
  function observe(session: Session) {
    if (available()) void intake.synchronize(session).catch(report)
  }
  let readyEpoch: string | undefined
  const unsubscribe = connection.subscribe(raw => {
    if (lifetime.signal.aborted) return
    const profileMsg = memoryOwnerProfile.safeParse(raw)
    if (profileMsg.success) {
      acceptProfile({ epoch: profileMsg.data.epoch, revision: profileMsg.data.revision, text: profileMsg.data.text })
      return
    }
    const contextUsedMsg = memoryOwnerContextUsed.safeParse(raw)
    if (contextUsedMsg.success) {
      sendParent(contextUsedMsg.data)
      return
    }
    const changeMsg = memoryOwnerChange.safeParse(raw)
    if (changeMsg.success) {
      if (owner.epoch && changeMsg.data.epoch === owner.epoch
        && (currentRevision === undefined || changeMsg.data.revision > currentRevision)) {
        currentRevision = changeMsg.data.revision
      }
      sendParent(changeMsg.data)
      return
    }
    const message = memoryOwnerState.safeParse(raw)
    if (!message.success) return
    const { epoch, state, revision } = message.data
    if (observedEpoch !== epoch) {
      observedEpoch = epoch
      cachedProfile = undefined
      firstDeferredAt = undefined
      yieldExempt = false
    }
    if (state === 'unavailable') {
      cachedProfile = undefined
    }
    sendParent(message.data)
    if (state !== 'ready') {
      readyEpoch = undefined
      currentRevision = undefined
      return
    }
    currentRevision = revision
    if (epoch === readyEpoch) return
    readyEpoch = epoch
    publishRoute()
    for (const session of ctx.sessions.list()) observe(session)
  })

  ctx.on('session/created', observe)
  ctx.on('session/disposed', session => {
    const id = String(session.id)
    clearPendingForSession(id)
    intake.release(session)
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection') {
      route = { provider: event.data.provider, model: event.data.model }
      publishRoute()
    }
    if (event.type === 'user/message' && event.data.source.kind === 'viva-memory') {
      const pending = pendingContextConfirmations.get(String(event.data.id))
      if (pending) {
        pendingContextConfirmations.delete(String(event.data.id))
        if (available()) void owner.call('reportContextUsed', [pending]).catch(report)
      }
    }
    if (event.type === 'turn/end') {
      clearPendingForSession(String(session.id))
      observe(session)
    }
  })

  // L1 static rules (0ms, KV-cache stable) and L2 cached resident profile (0ms, independent of L3).
  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.section({ name: 'viva-memory-rules', order: 20, interpolate: false, text: formatMemoryRulesSection() })
    scoped.systemPrompt.context({ name: 'viva-profile', order: 80, interpolate: false, text: () =>
      formatProfileContext({ text: currentProfileText(), today: dateLine() }),
    })
  })

  type RecallAttempt = {
    msg: { id: string, text: string }
    requestId: string | undefined
    result: AutomaticRecallResult
    epoch?: string
    revision?: number
    stale?: boolean
  }

  async function querySingleHop(
    sessionId: string,
    cwd: string | null | undefined,
    turn: number,
    msg: { id: string, text: string },
    requestId: string | undefined,
    stepDeadlineAt: number,
    signal: AbortSignal,
  ): Promise<RecallAttempt> {
    if (!available()) return { msg, requestId, result: { status: 'unavailable' } }
    const cleanQuery = withoutTaskHeaders(withoutHeaders(msg.text))
    if (!config.host && (!cleanQuery.trim() || looksSecret(cleanQuery))) {
      return { msg, requestId, result: { status: 'skipped' } }
    }
    const left = Math.max(0, stepDeadlineAt - Date.now())
    if (left <= 0) return { msg, requestId, result: { status: 'timeout' } }
    const budget = createRequestBudget(left, signal)
    try {
      const reply = await budget.run(() => owner.call('automaticRecall', [
        { session: sessionId, turn, question: config.host ? '' : cleanQuery },
        cwd,
        config.host ? [msg] : undefined,
      ], { signal: budget.signal, budgetMs: budget.remainingMs() }))
      return { msg, requestId, result: reply.result, epoch: reply.epoch, revision: reply.revision, stale: reply.stale }
    } catch (error) {
      if (signal.aborted) return { msg, requestId, result: { status: 'timeout' } }
      if (!available()) return { msg, requestId, result: { status: 'unavailable' } }
      if (!budget.signal.aborted) report(error)
      return { msg, requestId, result: { status: 'timeout' } }
    } finally { budget.close() }
  }

  async function resolveRecallForMessages(
    sessionId: string,
    cwd: string | null | undefined,
    turn: number,
    messages: ReadonlyArray<{ id: string, text: string }>,
    stepDeadlineAt: number,
    signal: AbortSignal,
  ): Promise<Array<{ msg: { id: string, text: string }, requestId: string | undefined, result: AutomaticRecallResult }>> {
    const items = messages.map(msg => ({ msg, requestId: extractCorrelationRequestId(msg.text) }))
    const initial = await Promise.all(items.map(({ msg, requestId }) =>
      querySingleHop(sessionId, cwd, turn, msg, requestId, stepDeadlineAt, signal),
    ))

    // Single-layer at-most-once refresh within stepDeadlineAt if worker flagged stale or revision advanced.
    const refreshed = await Promise.all(initial.map(async (item): Promise<RecallAttempt> => {
      if (item.result.status !== 'hit') return item
      if (!available()) return { ...item, result: { status: 'unavailable' } }
      const liveRev = currentRevision ?? 0
      const needsRefresh = item.stale === true
        || (owner.epoch !== undefined && item.epoch !== owner.epoch)
        || (item.revision !== undefined && item.revision < liveRev)
      if (!needsRefresh) return item
      if (signal.aborted || stepDeadlineAt - Date.now() <= 0) {
        return { ...item, result: { status: 'timeout' } }
      }
      return querySingleHop(sessionId, cwd, turn, item.msg, item.requestId, stepDeadlineAt, signal)
    }))

    // Final synchronous adoption guard preserving original message order.
    const liveEpoch = owner.epoch
    const liveRev = currentRevision ?? 0
    return refreshed.map(({ msg, requestId, result, epoch, revision, stale }) => {
      if (signal.aborted) return { msg, requestId, result: { status: 'timeout' as const } }
      if (result.status === 'hit') {
        if (!available()) return { msg, requestId, result: { status: 'unavailable' as const } }
        if (stale === true || (liveEpoch !== undefined && epoch !== liveEpoch)
          || (revision !== undefined && revision < liveRev)) {
          return { msg, requestId, result: { status: 'timeout' as const } }
        }
      }
      return { msg, requestId, result }
    })
  }

  ctx.on('agent/pre-step', async ({ agent, turn, signal, modelSelection }, next) => {
    const sessionId = String(agent.session.id)
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    route = { provider: modelSelection.provider, model: modelSelection.model }
    publishRoute()
    const messages = humanMessages(decision.messages)
    // Ordinary tool continuation steps keep the adopted snapshot frozen (no re-query, no deletion).
    if (!messages.length) return decision
    if (available()) void intake.receive(agent.session, decision.messages, turn).catch(report)
    if (process.env.VIVA_MEMORY_BENCHMARK_BYPASS_AUTO === '1') return decision

    const stepDeadlineAt = Date.now() + DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs
    const resolved = await resolveRecallForMessages(sessionId, agent.session.header.cwd, turn, messages, stepDeadlineAt, signal)
    if (signal.aborted) return decision

    // Append L3 recall messages in original message order [A, B, ...] without modifying prior turns' nodes.
    const appended = [...decision.messages]
    for (const { msg, requestId, result } of resolved) {
      const recallText = formatAutomaticRecallMessage({ turn, ref: requestId ?? msg.id, result })
      if (!recallText) continue
      const recallMessage = createUserMessage({
        content: [{ type: 'text', text: recallText }],
        source: { kind: 'viva-memory', form: 'recall' },
      })
      appended.push(recallMessage)
      if (result.status === 'hit' && result.hits.length > 0) {
        pendingContextConfirmations.set(String(recallMessage.id), { session: sessionId, turn, pushed: result.hits })
      }
    }
    return appended.length === decision.messages.length ? decision : { ...decision, messages: appended }
  })

  registerMemoryTools(ctx, async (request, agent, signal) => {
    if (!available()) return null
    const budget = createRequestBudget(request.op === 'remember' ? APP_WRITE_TIMEOUT_MS : MEMORY_READ_BUDGET_MS, signal)
    try {
      return await budget.run(async () => {
        if (request.op === 'remember') await intake.synchronize(agent.session)
        budget.signal.throwIfAborted()
        return owner.call('sidecarRequest', [request, agent.session.header.cwd], { signal: budget.signal, budgetMs: budget.remainingMs() })
      })
    } catch (error) {
      if (!budget.signal.aborted && available()) report(error)
      return null
    } finally { budget.close() }
  }, { projectScope: !config.host })
  ctx.inject(['commands'], scoped => {
    if (!config.host) scoped.effect(() => registerMemoryFileCommands(scoped.commands, owner, async (agent, signal) => {
      const session = agent.session
      const active = () => available() && !signal.aborted && ctx.sessions.get(session.id) === session && agent.status !== 'running'
      if (!active() || resolveMemoryProject(session.header.cwd).status === 'unknown') return false
      await owner.call('bindIntakeSession', [String(session.id), session.header.cwd], { signal })
      return active()
    }), 'standalone memory file commands')
  })
  ctx.inject(['sessionLogDeepSeek'], scoped => {
    const release = scoped.sessionLogDeepSeek.registerExclusion(() => true)
    scoped.effect(() => release, 'memory history upload exclusion')
  })
  ctx.effect(() => async () => {
    if (config.host) {
      port.off('message', receiveDiagnostic)
    }
    lifetime.abort()
    hostRelay.close()
    unsubscribe()
    try {
      await owner.close()
      await intake.drain()
    } finally {
      diagnosticHub.close()
      restoreDiagnostics()
      await diagnostics.close().catch(() => false)
    }
  }, 'memory owner')

  void connection.start().catch(report)
  return owner
}
