import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import type { AutomaticRecallResult, MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'
import { isDailyMemoryStage } from '../../../src/memory/contracts/memory-contract.ts'
import { DAILY_MEMORY_DEFAULTS } from '../../../src/memory/contracts/memory-daily-defaults.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'
import { memoryOwnerProfile, memoryOwnerState, type MemoryProfileSnapshot } from '../../../src/memory/contracts/host.ts'
import { dateLine, formatAutomaticRecallMessage, formatMemoryRulesSection, formatProfileContext } from '../../../src/memory/core/memory-context.ts'
import { looksSecret } from '../../../src/memory/core/memory-sensitive.ts'
import { resolveMemoryProject } from '../../../src/memory/node/project-scope.ts'
import { createRequestBudget, APP_WRITE_TIMEOUT_MS, MEMORY_READ_BUDGET_MS } from '../../../src/shared/request-budget.ts'
import { requestsIn, withoutHeaders } from '../../../src/shared/request-routing/header.ts'
import { taskRequestsIn, withoutTaskHeaders } from '../../../src/shared/request-routing/task-header.ts'
import { createManagedDiagnostics } from '../../../src/diagnostics/node/managed.ts'
import { createDiagnosticHub } from '../../../src/diagnostics/node/hub.ts'
import { emitDiagnostic, emitDiagnosticFailure, installDiagnosticPort } from '../../../src/diagnostics/node/context.ts'
import type { MemoryPluginConfig } from './config.ts'
import { openPluginOwner } from './standalone-owner.ts'
import { createRemoteMemoryOwner } from './remote-owner.ts'
import { createSessionIngestion, humanMessages } from './ingestion.ts'
import { completeMemoryModel, memoryProviderFailure } from './model.ts'
import { registerMemoryTools } from './tools.ts'
import { registerMemoryFileCommands } from './file-commands.ts'
import { observeDshDiagnostics } from './diagnostics.ts'
import { objectOf } from '../../../src/memory/contracts/unknown-value.ts'
import type {} from './source.ts'

function extractCorrelationRequestId(text: string): string | undefined {
  const routed = requestsIn(text)
  if (routed.length > 0) return routed[routed.length - 1]!.id
  const task = taskRequestsIn(text)
  if (task.length > 0) return task[task.length - 1]!.id
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
  const connection = openPluginOwner({ root, hostNamespace: config.host ? 'viva' : undefined, embedding, dailyNotes: config.dailyNotes ?? true,
    callbacks: {
      async compute({ job, tools }, signal) {
        const deadline = AbortSignal.timeout(isDailyMemoryStage(job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : 115_000)
        const combined = AbortSignal.any([lifetime.signal, deadline, signal])
        try {
          return await completeMemoryModel(ctx, job, combined, tools
            ? { tools, executeTool: input => owner.call('computeTool', [job.id, input], { signal: combined }) }
            : undefined)
        } catch (error) {
          if (error instanceof MemoryComputeError) throw error
          if (combined.aborted) throw new MemoryComputeError(combined.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted')
          throw memoryProviderFailure(objectOf(error)?.code) ?? new MemoryComputeError('call-failed')
        }
      },
    },
  }, port)
  const owner = createRemoteMemoryOwner(connection)
  const available = () => !lifetime.signal.aborted && owner.ready()
  const intake = createSessionIngestion(owner, session => ctx.sessions.flush(session))
  let cachedProfile: MemoryProfileSnapshot | undefined
  const pendingContextConfirmations = new Map<string, { session: string, turn: number, pushed: Array<{ text: string, names: string[] }> }>()
  let route: { provider: string, model: string } | null = null
  let published: { epoch: string | undefined, provider: string, model: string } | undefined

  function acceptProfile(next: MemoryProfileSnapshot) {
    if (cachedProfile && cachedProfile.epoch === next.epoch && next.revision < cachedProfile.revision) return
    cachedProfile = { epoch: next.epoch, revision: next.revision, text: next.text }
  }
  function currentProfileText(): string {
    if (!cachedProfile) return ''
    if (owner.epoch && cachedProfile.epoch !== owner.epoch) return ''
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
    const message = memoryOwnerState.safeParse(raw)
    if (!message.success) return
    const { epoch, state } = message.data
    if (state !== 'ready') {
      readyEpoch = undefined
      connection.reconciled?.(epoch, false)
      return
    }
    if (epoch === readyEpoch) return
    readyEpoch = epoch
    connection.reconciled?.(epoch, true)
    publishRoute()
    for (const session of ctx.sessions.list()) observe(session)
  })

  ctx.on('session/created', observe)
  ctx.on('session/disposed', session => {
    clearPendingForSession(String(session.id))
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

  async function resolveRecallForMessage(
    sessionId: string,
    cwd: string | null | undefined,
    turn: number,
    msg: { id: string, text: string },
    stepDeadlineAt: number,
    signal: AbortSignal,
  ): Promise<{ msg: { id: string, text: string }, requestId: string | undefined, result: AutomaticRecallResult }> {
    const requestId = extractCorrelationRequestId(msg.text)
    const remaining = () => Math.max(0, stepDeadlineAt - Date.now())

    // Step 1: Claim host prefetch by exact (requestId, sessionId) when running under Viva host.
    if (connection.claimPrefetch && requestId) {
      try {
        const claimBudget = Math.max(1, remaining() + 50)
        const claimed = await connection.claimPrefetch({ requestId, sessionId }, { signal, budgetMs: claimBudget })
        if (claimed.found) return { msg, requestId, result: claimed.result }
      } catch (error) {
        if (signal.aborted) return { msg, requestId, result: { status: 'timeout' } }
        if (!available()) return { msg, requestId, result: { status: 'unavailable' } }
        report(error)
      }
    }

    // Step 2: Fallback live short-budget recall (standalone DSH or genuinely un-prefetched delivery).
    if (!available()) return { msg, requestId, result: { status: 'unavailable' } }
    const cleanQuery = withoutTaskHeaders(withoutHeaders(msg.text))
    if (!config.host && (!cleanQuery.trim() || looksSecret(cleanQuery))) {
      return { msg, requestId, result: { status: 'skipped' } }
    }
    const left = remaining()
    if (left <= 0) return { msg, requestId, result: { status: 'timeout' } }
    const budget = createRequestBudget(left, signal)
    try {
      const result = await budget.run(() => owner.call('automaticRecall', [
        { session: sessionId, turn, question: config.host ? '' : cleanQuery },
        cwd,
        config.host ? [msg] : undefined,
      ], { signal: budget.signal, budgetMs: budget.remainingMs() }))
      return { msg, requestId, result }
    } catch (error) {
      if (signal.aborted) return { msg, requestId, result: { status: 'timeout' } }
      if (!available()) return { msg, requestId, result: { status: 'unavailable' } }
      if (!budget.signal.aborted) report(error)
      return { msg, requestId, result: { status: 'timeout' } }
    } finally { budget.close() }
  }

  ctx.on('agent/pre-step', async ({ agent, turn, signal, modelSelection }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    route = { provider: modelSelection.provider, model: modelSelection.model }
    publishRoute()
    const messages = humanMessages(decision.messages)
    // Ordinary tool continuation steps keep the adopted snapshot frozen (no re-query, no deletion).
    if (!messages.length) return decision
    if (available()) void intake.receive(agent.session, decision.messages, turn).catch(report)

    const sessionId = String(agent.session.id)
    const stepDeadlineAt = Date.now() + DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs
    const resolved = await Promise.all(
      messages.map(msg => resolveRecallForMessage(sessionId, agent.session.header.cwd, turn, msg, stepDeadlineAt, signal)),
    )
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
    if (config.host) port.off('message', receiveDiagnostic)
    lifetime.abort()
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
