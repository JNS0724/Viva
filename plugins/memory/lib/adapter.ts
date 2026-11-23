import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import type { MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'
import { isDailyMemoryStage } from '../../../src/memory/contracts/memory-contract.ts'
import { DAILY_MEMORY_DEFAULTS } from '../../../src/memory/contracts/memory-daily-defaults.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'
import { memoryOwnerState } from '../../../src/memory/contracts/host.ts'
import { resolveMemoryProject } from '../../../src/memory/node/project-scope.ts'
import { createRequestBudget, APP_WRITE_TIMEOUT_MS, MEMORY_READ_BUDGET_MS } from '../../../src/shared/request-budget.ts'
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
  const intake = createSessionIngestion(owner, session => ctx.sessions.flush(session), Boolean(config.host))
  const context = new WeakMap<object, { epoch: string | undefined, turn: number, text: string }>()
  let route: { provider: string, model: string } | null = null
  let published: { epoch: string | undefined, provider: string, model: string } | undefined
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
    const message = memoryOwnerState.safeParse(raw)
    if (!message.success || lifetime.signal.aborted) return
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
  ctx.on('session/disposed', session => intake.release(session))
  ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection') {
      route = { provider: event.data.provider, model: event.data.model }
      publishRoute()
    }
    if (event.type === 'turn/end') observe(session)
  })

  ctx.inject(['systemPrompt'], scoped => {
    scoped.systemPrompt.context({ name: 'viva-memory', order: 80, interpolate: false, text: ({ scope }) => {
      const entry = scope && context.get(scope)
      return available() && entry && entry.epoch === owner.epoch ? entry.text : ''
    } })
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal, modelSelection }, next) => {
    const decision = await next()
    if (context.get(agent)?.turn !== turn || !available()) context.delete(agent)
    if (decision.kind === 'reject' || signal.aborted || !available()) return decision
    route = { provider: modelSelection.provider, model: modelSelection.model }
    publishRoute()
    const messages = humanMessages(decision.messages)
    if (!messages.length) return decision
    void intake.receive(agent.session, decision.messages, turn, step).catch(report)
    const budget = createRequestBudget(DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs, signal)
    try {
      const epoch = owner.epoch
      const request: MemoryRequest = { op: 'context', session: String(agent.session.id), turn, question: '' }
      const text = await budget.run(() => owner.call('sidecarRequest', [request, agent.session.header.cwd, { messages, requiresAlias: Boolean(config.host) }],
        { signal: budget.signal, budgetMs: budget.remainingMs() }))
      if (text && !signal.aborted && available() && owner.epoch === epoch) context.set(agent, { epoch, turn, text })
    } catch (error) {
      if (!budget.signal.aborted && available()) report(error)
    } finally { budget.close() }
    return decision
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
  })
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
