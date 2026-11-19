import { memoryHostFailure } from '../../../src/memory/contracts/domain-error.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import type {} from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-subagent'
import { DAILY_MEMORY_DEFAULTS } from '../../../src/memory/contracts/memory-daily-defaults.ts'
import { MemoryComputeError } from '../../../src/memory/contracts/compute.ts'
import { isDailyMemoryStage } from '../../../src/memory/contracts/memory-contract.ts'
import type { MemoryRequest } from '../../../src/memory/contracts/memory-contract.ts'
import { objectOf } from '../../../src/memory/contracts/unknown-value.ts'
import { MEMORY_HOST_PROTOCOL, memoryOwnerState, parseHostMemoryCommand } from '../../../src/memory/contracts/host.ts'
import type { MemoryOwnerState } from '../../../src/memory/contracts/host.ts'
import type { MemoryPluginConfig } from './config.ts'
import { openPluginOwner } from './standalone-owner.ts'
import { createRemoteMemoryOwner } from './remote-owner.ts'
import { createMemoryTransport } from './transport.ts'
import type { MemoryTransportOrigin } from './transport.ts'
import { createSessionIngestion, retrievalQuestion } from './ingestion.ts'
import { completeMemoryModel, memoryProviderFailure } from './model.ts'
import { assertMemoryProviderSupported } from './providers.ts'
import { registerMemoryTools } from './tools.ts'
import { registerMemoryFileCommands } from './file-commands.ts'
import { memoryOriginalContentDigest, memoryRecoveryMessageHash } from './context-recovery.ts'
import { createMemoryDeliveryBindings } from './delivery-provenance.ts'
import { trackNativeOutputAttempts } from './native/output-attempts.ts'
import { trackNativeToolReads, type NativeToolLease } from './native/tool-reads.ts'
import { trackNativeSpills } from './native/track-spills.ts'
import { trackNativeSpillReads } from './native/read-spills.ts'
import { recordCompactionInputs, recordCompactionRequest } from './native/compaction-inputs.ts'
import type { MemoryDeliveryProof, MemoryToolOrigin } from './delivery-provenance.ts'

import { memorySource } from './source.ts'
import { createManagedDiagnostics } from '../../../src/diagnostics/node/managed.ts'
import { createDiagnosticHub } from '../../../src/diagnostics/node/hub.ts'
import { emitDiagnostic, emitDiagnosticFailure, installDiagnosticPort, withOperation, withRemoteOperation } from '../../../src/diagnostics/node/context.ts'
import { parseDiagnosticContext } from '../../../src/diagnostics/contracts.ts'
import { observeDshDiagnostics } from './diagnostics.ts'

import { RequestTimeout } from '../../../src/shared/request-budget.ts'
import { currentToolBudget, executeToolCall, isMemoryTool, prepareToolCall } from '../../../src/shared/node/tool-call-budget.ts'

function clearPreviousContext(agent: Agent) {
  const session = agent.session
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || event.data.source.kind !== 'viva-memory' || !event.data.content.length) continue
    session.append('user/message', createUserMessage({ content: [], source: memorySource }), {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    })
  }
}

/** Mount once per DSH process and bind to its supervised memory owner. */
export async function applyMemoryAdapter(ctx: Context, config: MemoryPluginConfig = {}, port = process) {
  const caller = new AsyncLocalStorage<{ agent: Agent, ownerEpoch: string, contextGeneration?: number, toolOrigin?: MemoryToolOrigin, toolRead?: NativeToolLease } | { jobId: string, ownerEpoch: string }>()
  const deliveries = new Map<string, Promise<MemoryDeliveryProof>>()
  const deliveryBindings = createMemoryDeliveryBindings()
  const lifetime = new AbortController()
  let closing = false
  type Route = { provider: string, model: string }
  let lastRoute: Route | null = null
  let publishedRoute: { epoch: string, route: Route | null } | undefined
  let readyEpoch: string | undefined
  const send = (message: object) => { if (config.host && port.connected) port.send?.(message, () => {}) }
  const root = path.resolve(config.dataRoot ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'memory'))
  const diagnostics = createManagedDiagnostics({ directory: typeof config.diagnosticsRoot === 'string' && path.isAbsolute(config.diagnosticsRoot)
    ? config.diagnosticsRoot : path.join(root, 'diagnostics'), component: 'dsh', componentVersion: '0.2.0',
    version: typeof config.diagnosticsVersion === 'string' ? config.diagnosticsVersion : 'unknown' })
  const restoreDiagnostics = installDiagnosticPort(diagnostics)
  const diagnosticsHub = createDiagnosticHub({ component: 'dsh', writers: [{ component: 'dsh', writer: diagnostics }],
    ...(config.host ? { send: (message: object, settled: (error?: Error | null) => void) => {
      if (port.connected && port.send) port.send(message, settled); else settled(new Error('Diagnostic parent disconnected'))
    } } : {}) })
  let diagnosticsTransferred = false
  const stopDiagnostics = async () => { diagnosticsHub.close(); restoreDiagnostics(); await diagnostics.close().catch(() => false) }
  // Cordis disposes effects concurrently. Before owner cleanup is registered, this guard owns the sink.
  ctx.effect(() => async () => {
    if (diagnosticsTransferred) return
    emitDiagnostic({ event: 'process.exit', operation: 'shutdown', outcome: 'failed', reason: 'unavailable' })
    await stopDiagnostics()
  }, 'memory diagnostics startup guard')
  observeDshDiagnostics(ctx)
  emitDiagnostic({ event: 'process.start', operation: 'startup' })
  const embedding = config.modelRoot ? { modelRoot: config.modelRoot, runtimeRoot: config.runtimeRoot } : undefined
  let owner: ReturnType<typeof createRemoteMemoryOwner>
  const connection = openPluginOwner({ root, hostNamespace: config.host ? 'viva' : undefined, embedding, dailyNotes: config.dailyNotes ?? true,
    callbacks: {
      compute: async ({ job, tools }, signal) => {
        const ownerEpoch = owner.epoch
        if (!ownerEpoch || readyEpoch !== ownerEpoch) throw new MemoryComputeError('call-failed')
        const deadline = AbortSignal.timeout(isDailyMemoryStage(job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : 115_000)
        const combined = AbortSignal.any([lifetime.signal, deadline, signal])
        return owner.inEpoch(ownerEpoch, () => caller.run({ jobId: job.id, ownerEpoch },
          () => completeMemoryModel(ctx, job, combined, tools ? { tools, executeTool: input => owner.call('computeTool', [job.id, input], { signal: combined }) } : undefined))).catch(error => {
          if (error instanceof MemoryComputeError) throw error
          if (combined.aborted) throw new MemoryComputeError(combined.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted')
          throw memoryProviderFailure(objectOf(error)?.code) ?? new MemoryComputeError('call-failed')
        })
      },
      quiesce: async ({ session }) => {
        // The mutation may originate in pre-step of this same session.
        for (const agent of ctx.agents.list()) if (agent.status === 'running' && String(agent.session.id) !== session) {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
      },
      checkRecovery: ({ checkId }) => owner.checkRecovery(checkId),
      drainSends: ({ epoch }) => owner.drainSends(epoch),
    },
  }, port)
  owner = createRemoteMemoryOwner(connection, error => emitDiagnosticFailure('memory.intake', error))
  const ready = () => owner.ready() && owner.epoch === readyEpoch && !closing
  async function publishRoute() {
    const epoch = owner.epoch
    if (!epoch || !ready()) return
    const selected = lastRoute ?? ctx.agents.list().map(agent => agent.model.current()).find(route => route !== undefined)
    const route = selected ? { provider: selected.provider, model: selected.model } : null
    if (publishedRoute?.epoch === epoch && route?.provider === publishedRoute.route?.provider && route?.model === publishedRoute.route?.model) return
    const update = { epoch, route }
    publishedRoute = update
    try { await owner.inEpoch(epoch, () => owner.call('setRoute', [route])) }
    catch (error) { if (publishedRoute === update) publishedRoute = undefined; throw error }
  }
  const activeTurns = new Map<string, number>()
  const transport = createMemoryTransport(owner)
  const outputAttempts = trackNativeOutputAttempts(owner.cachedGeneration, owner.finishNativeOutput)
  const toolReads = trackNativeToolReads(owner.finishNativeToolRead, {
    evidence: owner.nativeToolEvidence, archive: owner.inheritNativeToolRead,
  })
  const spillWriter = trackNativeSpills(ctx, { ready, contextGeneration: owner.cachedGeneration,
    nativeSpillGoverned: owner.nativeSpillGoverned, beginNativeSpill: owner.beginNativeSpill, finishNativeSpill: owner.finishNativeSpill }, toolReads)
  const spillReader = trackNativeSpillReads(ctx, owner, () => {
    const execution = caller.getStore()
    return execution && 'agent' in execution ? execution.toolRead : undefined
  })
  const ingestion = createSessionIngestion(owner, session => ctx.sessions.flush(session), async (_session, message) => {
    const proof = deliveries.get(message.id)
    if (!proof) return undefined
    try { return await proof } finally { deliveries.delete(message.id) }
  })
  ctx.inject(['commands'], scoped => {
    if (!config.host) scoped.effect(() => registerMemoryFileCommands(scoped.commands, owner, async (agent, signal) => {
      const session = agent.session
      const active = () => !closing && !signal.aborted && ctx.sessions.get(session.id) === session
        && ctx.agents.get(session.id) === agent && agent.status !== 'running'
      if (!active() || !ready()) return false
      await ingestion.synchronize(session)
      return active() && ready()
    }), 'standalone memory file commands')
  })
  // Suppress raw history upload before its serializer; the final transport also rejects unknown
  // extension fields. Optional because an independent DSH profile may never install this service.
  ctx.inject(['sessionLogDeepSeek'], scoped => {
    const restoreUpload = scoped.sessionLogDeepSeek.registerExclusion(() => true)
    scoped.effect(() => restoreUpload, 'memory history upload exclusion')
  })
  const disposed = new WeakSet<Session>()
  const report = (error: unknown, session?: Session) => {
    if (session && disposed.has(session)) return // The persisted log is replayed when a new handle opens.
    emitDiagnosticFailure('memory.intake', error)
  }
  ctx.on('session/disposed', session => { disposed.add(session); deliveryBindings.release(String(session.id)); owner.release(String(session.id)); activeTurns.delete(String(session.id)) })
  const observe = (session: Session) => {
    if (ready() && !owner.cachedContextRewritten(String(session.id))) {
      const pending = ingestion.synchronize(session)
      void pending.catch(error => report(error, session))
      return pending
    }
    // Prepared host source changes resume through the host outbox; the next admitted step replays.
  }
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!closing) outputAttempts?.frame(agent.session, frame)
  })
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs }, next) => {
    if (!closing) recordCompactionInputs(session, sourceEventSeqs)
    return next()
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection' && ctx.agents.get(session.id)?.session === session) {
      lastRoute = { provider: event.data.provider, model: event.data.model }
      void publishRoute().catch(error => report(error, session))
    }
    if (event.type === 'turn/start') activeTurns.set(String(session.id), event.data.turn)
    if (event.type === 'turn/end') activeTurns.delete(String(session.id))
    if (!closing) {
      outputAttempts?.observe(session, event)
      toolReads?.observe(session, event)
    }
    const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []
    for (const message of messages) {
      const source = message.source
      if (deliveries.has(message.id) || !('senderSessionId' in source) || typeof source.senderSessionId !== 'string') continue
      const digest = memoryOriginalContentDigest(message)
      if (source.kind === 'subagent-settled') {
        const pending = deliveryBindings.settlement(source.senderSessionId, String(session.id), digest)
        if (pending) deliveries.set(message.id, pending)
      } else if (source.kind === 'agent-message') {
        const execution = caller.getStore()
        if (execution && 'agent' in execution && execution.toolOrigin && execution.agent.session.id === source.senderSessionId) {
          const pending = Promise.resolve().then(() => {
            if (execution.ownerEpoch !== owner.epoch) throw new Error('Derived delivery belongs to a retired owner')
            return deliveryBindings.relay(source.senderSessionId, String(session.id), digest, execution.toolOrigin!)
          })
          void pending.catch(() => {})
          deliveries.set(message.id, pending)
        }
      }
    }
    if (!closing && (event.type !== 'agent/inbox/spliced' || event.data.inserted.length > 0)
      && ['agent/inbox/spliced', 'user/message', 'assistant/message', 'turn/end'].includes(event.type)) {
      const pending = observe(session)
      if (pending && event.type === 'assistant/message') deliveryBindings.output(String(session.id), event.data.turn, event.data.step, event.data.message.content, pending)
    }
  })
  ctx.on('session/created', session => { if (!closing) observe(session) })
  // The native lifecycle fires before foreground result resolution; background notices also carry sender identity.
  // Serialize it with parent intake: a failed provenance transfer blocks that parent's next request.
  ctx.on('subagent/start', info => {
    const parent = String(info.parentSessionId), child = String(info.id)
    const parentGeneration = owner.cachedGeneration(parent)
    if (parentGeneration === undefined || !ready()) return
    deliveryBindings.start(info.runId, parent, child, parentGeneration, owner.inEpoch(owner.epoch, () => owner.contextGeneration(child)))
  })
  ctx.on('subagent/end', info => {
    const parent = ctx.sessions.get(info.parentSessionId)
    void deliveryBindings.end(info.runId, info.lastAssistantMessage).then(generation => {
      if (!closing && parent) return ingestion.derived(parent, { messageId: `subagent-end:${info.runId}`, sourceIds: [],
        senderSessionId: String(info.id), contextGeneration: generation?.contextGeneration ?? 0,
        senderContextGeneration: generation?.senderContextGeneration ?? 0, ...(generation ? { verifiedDelivery: true as const } : {}) })
    }).catch(error => report(error, parent))
  })

  const request = async (input: MemoryRequest, agent: Agent, signal?: AbortSignal) => {
    const execution = caller.getStore()
    if (!execution || !('agent' in execution) || execution.agent !== agent || execution.contextGeneration === undefined
      || input.op !== 'context' && !execution.toolRead || !ready()) return input.op === 'context' ? '' : '{"status":"unavailable"}'
    const generation = execution.contextGeneration
    return owner.inEpoch(execution.ownerEpoch, async () => {
      await ingestion.synchronize(agent.session)
      signal?.throwIfAborted()
      if (input.op !== 'context') return owner.modelRequest(input, String(agent.session.id), generation, execution.toolRead,
        { signal, budgetMs: currentToolBudget()?.remainingMs() })
      // Leave room for the owner to publish its normal search-budget fallback over IPC.
      const deadline = AbortSignal.timeout(DAILY_MEMORY_DEFAULTS.automaticContextBudgetMs + 100)
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
      try { return await owner.modelRequest(input, String(agent.session.id), generation, undefined, { signal: combined }) }
      catch (error) { if (!deadline.aborted || signal?.aborted) throw error; return '' }
    })
  }
  // Automatic tool review may omit sessionId. Bind the actual execution, not its text.
  let unbindTools: (() => unknown) | undefined
  const bindTools = () => {
    unbindTools?.()
    unbindTools = ctx.on('tools/pre-execute', async (exec, next) => {
      if (!exec.agent) return next()
      const agent = exec.agent, session = String(agent.session.id)
      const origin = deliveryBindings.tool(session, String(exec.rootCallId))
      const ownerEpoch = owner.epoch
      if (!origin || !ownerEpoch || !ready()) throw new Error('Tool review has no verified memory origin')
      const generation = origin.generation
      toolReads?.bind(agent.session, exec)
      return owner.inEpoch(ownerEpoch, () => caller.run({ agent, ownerEpoch, contextGeneration: generation, toolOrigin: origin }, async () => {
        try {
          await prepareToolCall(exec, ctx.tools.get(exec.name, agent, exec.toolSet)?.timeoutMs, async () => {
            await owner.drainSession(session)
            await ingestion.synchronize(agent.session)
            if (generation !== owner.cachedGeneration(session)) throw new Error('Tool review belongs to a retired context generation')
          })
        } catch (error) {
          if (exec.signal.aborted) return { kind: 'cancel' as const }
          if (error instanceof RequestTimeout) return { kind: 'deny' as const,
            reason: isMemoryTool(exec.name) ? '{"status":"unavailable","reason":"timeout"}' : 'Tool preparation timed out.',
            info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' } }
          throw error
        }
        return next()
      }))
    }, { prepend: true })
    return undefined
  }
  bindTools()
  ctx.on('agent/created', () => {
    bindTools()
    void publishRoute().catch(error => report(error))
    return undefined
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent) return next()
    const agent = exec.agent, session = String(agent.session.id)
    const origin = deliveryBindings.tool(session, String(exec.rootCallId)), ownerEpoch = owner.epoch
    if (!origin || !ownerEpoch || !ready()) throw new Error('Tool call has no verified memory origin')
    const generation = origin.generation
    const dispatch = () => owner.inEpoch(ownerEpoch, async () => {
      await owner.drainSession(session)
      const view = await owner.readContext(session, { signal: exec.signal, budgetMs: currentToolBudget()?.remainingMs() })
      if (generation !== view.contextGeneration || view.needsContextRecovery) throw new Error('Tool call belongs to a retired context generation')
      const toolRead = await toolReads?.acquireAsync(agent.session, exec, generation)
      return caller.run({ agent, ownerEpoch, contextGeneration: generation, toolOrigin: origin, toolRead }, next)
    })
    return isMemoryTool(exec.name) ? executeToolCall(exec, dispatch, { mutates: exec.name === 'memory_remember' }) : dispatch()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const current = caller.getStore()
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : current && 'agent' in current ? current.agent : undefined
    const session = options.sessionId ? ctx.sessions.get(options.sessionId) : agent?.session
    const contextGeneration = session ? current && 'agent' in current && current.agent.session === session
      ? current.contextGeneration : owner.cachedGeneration(String(session.id)) : undefined
    const jobId = current && 'jobId' in current ? current.jobId : undefined
    const ownerEpoch = current?.ownerEpoch ?? owner.epoch
    if (!session && !jobId) throw new Error('Model request has no verified memory origin')
    if (!ownerEpoch || !ready() || ownerEpoch !== owner.epoch || session && contextGeneration === undefined) throw new Error('Memory owner or session generation is not ready')
    if (session && options.purpose === 'compaction') recordCompactionRequest(session, options.messages)
    // Only the pinned loop's own request object may inherit the active attempt.
    const loopRequest = outputAttempts && isAgentLoopRequest(options)
    const output = loopRequest && session ? outputAttempts.prepare(session) : undefined
    if (loopRequest && !output) throw new Error('Model request has no active native output attempt')
    if (session) {
      await owner.inEpoch(ownerEpoch, () => ingestion.synchronize(session))
      if (output && outputAttempts?.current(session) !== output) throw new Error('Model output attempt changed while its marker was being persisted')
      if (contextGeneration !== owner.cachedGeneration(String(session.id))) throw new Error('Model request belongs to a retired context generation')
      if (options.purpose === 'session-title') {
        const recorded = session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')
        if (recorded?.type !== 'session/title-llm-request') throw new Error('Session title has no recorded source dependencies')
        await owner.inEpoch(ownerEpoch, () => ingestion.titleDependencies(session, recorded.data.messageSeqs))
      }
    }
    // Only audited fetch-based adapters provide an observable physical send/retry boundary.
    assertMemoryProviderSupported(ctx.llm, options.provider)
    const origin: MemoryTransportOrigin = session ? { session: String(session.id), contextGeneration, ...(output ? { output } : {}) } : { jobId: jobId! }
    const stream = transport.run(origin, next)
    const iterator = stream[Symbol.asyncIterator]()
    try {
      for (;;) {
        const chunk = await owner.inEpoch(ownerEpoch, () => transport.run(origin, () => iterator.next()))
        if (!ready() || !await owner.inEpoch(ownerEpoch, () => owner.call('outputCurrent', [origin], { signal: options.signal }))) {
          throw new Error('Memory context changed before model output was accepted')
        }
        if (chunk.done) return
        yield chunk.value
      }
    } finally { await transport.run(origin, () => iterator.return?.()) }
  }, { prepend: true })
  ctx.on('system-prompt/assemble', (_presentation, { agent, toolSet, signal }, next) => {
    if (agent && toolSet && signal) toolReads?.assembly(agent.session, signal, toolSet)
    return next()
  })
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    const ownerEpoch = owner.epoch
    if (!ownerEpoch || !ready()) throw new Error('Memory owner is not ready')
    return owner.inEpoch(ownerEpoch, () => caller.run({ agent, ownerEpoch }, async () => {
      toolReads?.step(agent.session, turn, step, signal)
      // This hook precedes request construction. Never recover inside llm/stream: its options
      // may already contain the retired transcript, including on SDK transport retries.
      await ingestion.recoverContext(agent.session, () => !signal.aborted)
      const session = String(agent.session.id)
      const generation = owner.cachedGeneration(session) ?? await owner.contextGeneration(session)
      const execution = caller.getStore()
      if (execution && 'agent' in execution) execution.contextGeneration = generation
      const recipients = new Map<string, number>()
      for (const candidate of ctx.sessions.list()) {
        const id = String(candidate.id)
        const known = owner.cachedGeneration(id)
        if (known !== undefined) recipients.set(id, known)
      }
      deliveryBindings.step(session, turn, step, generation, recipients)
      const selected = agent.model.current()
      if (selected) { lastRoute = { provider: selected.provider, model: selected.model }; await publishRoute() }
      // Receipt precedes downstream hooks; admission is recorded only for the accepted message list.
      await ingestion.receive(agent.session, messages, turn, step, false, generation)
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const receipts = await ingestion.receive(agent.session, decision.messages, turn, step, true, generation)
      const question = retrievalQuestion(receipts)
      if (!question) return decision
      clearPreviousContext(agent)
      const text = await request({ op: 'context', session, turn, question }, agent, signal)
      if (!text || signal.aborted) return decision
      const message = createUserMessage({ content: [{ type: 'text', text }], source: memorySource })
      await owner.registerDerived({ sessionId: session, messageId: message.id, nativeUserSource: memorySource.kind, nativeMessageDigest: memoryRecoveryMessageHash(message),
        sourceIds: (await owner.dispatch.snapshot(session)).sources, contextGeneration: generation, contentDigest: memoryOriginalContentDigest(message) })
      return { ...decision, messages: [...decision.messages, message] }
    }))
  }, { prepend: true })
  registerMemoryTools(ctx, request)

  const receive = (raw: unknown) => {
    if (diagnosticsHub.receive(raw)) return
    const message = objectOf(raw)
    if (!config.host || message?.type !== 'memory_host_request' || typeof message.requestId !== 'string') return
    const requestId = message.requestId
    const expected = owner.epoch
    const diagnostic = parseDiagnosticContext(message.diagnostics)
    if (message.diagnostics !== undefined && !diagnostic) emitDiagnostic({ event: 'context.dropped', operation: 'memory.owner', reason: 'invalid_context' })
    void withRemoteOperation(diagnostic, 'memory.owner', async () => {
      if (message.protocol !== MEMORY_HOST_PROTOCOL || !expected || message.epoch !== expected || !ready()) throw new Error('Memory host protocol or epoch mismatch')
      const command = parseHostMemoryCommand(message.method, message.input)
      if (command.method !== 'recoverContext') throw new Error('Unsupported memory adapter request')
      const result = await owner.inEpoch(expected, async () => {
        const id = SessionId(command.input.args[0]), session = ctx.sessions.get(id)
        const idle = () => !closing && Boolean(session) && ctx.sessions.get(id) === session && ctx.agents.get(id)?.status !== 'running'
        if (!session || !idle()) return false
        await ingestion.recoverContext(session, idle)
        await ingestion.synchronize(session)
        const view = await owner.readContext(String(id))
        return idle() && !view.needsContextRecovery && view.allowsSession
      })
      send({ type: 'memory_host_result', requestId, epoch: expected, ok: true, result })
    }, { identities: { requestId, ownerEpoch: expected ?? null } }).catch(error => send({ type: 'memory_host_result', requestId, epoch: expected, ok: false,
      error: memoryHostFailure(error) }))
  }
  if (config.host) port.on('message', receive)
  let snapshot: MemoryOwnerState | undefined
  let watchedEpoch: string | undefined
  let warming: { epoch: string, done: Promise<void> } | undefined
  function publishState() {
    if (!snapshot) return
    send({ ...snapshot, state: snapshot.state === 'ready' && !ready() ? 'recovering' : snapshot.state })
  }
  function warmOwner(epoch: string) {
    if (readyEpoch === epoch || closing) return Promise.resolve()
    if (warming?.epoch === epoch) return warming.done
    const done = withOperation('memory.recover', async () => {
      await connection.start()
      await owner.inEpoch(epoch, async () => {
        const live = [...activeTurns].flatMap(([sessionId, turn]) => ctx.agents.get(SessionId(sessionId))?.status === 'running' ? [{ sessionId, turn }] : [])
        await owner.call('reconcileActiveTurns', [live])
        for (const session of ctx.sessions.list()) {
          try {
            const idle = () => ctx.sessions.get(session.id) === session && ctx.agents.get(session.id)?.status !== 'running'
            if (idle()) await ingestion.recoverContext(session, idle)
            await ingestion.synchronize(session)
          } catch (error) { report(error, session) }
        }
        if (closing || owner.epoch !== epoch || !owner.ready()) return
        readyEpoch = epoch
        await publishRoute()
        publishState()
      })
    }, { identities: { ownerEpoch: epoch } })
    const attempt = { epoch, done }
    warming = attempt
    void done.then(() => { if (warming === attempt) warming = undefined }, error => {
      if (warming === attempt) { warming = undefined; readyEpoch = undefined }
      report(error)
    })
    return done
  }
  const unsubscribe = connection.subscribe(event => {
    const update = memoryOwnerState.safeParse(event)
    if (!update.success || closing) return
    snapshot = update.data
    if (watchedEpoch !== snapshot.epoch) {
      readyEpoch = undefined
      watchedEpoch = snapshot.epoch
      outputAttempts.reset()
      toolReads.reset()
      deliveryBindings.close()
      deliveries.clear()
    }
    publishState()
    if (snapshot.state === 'ready') void warmOwner(snapshot.epoch).catch(() => {})
  })
  ctx.effect(() => async () => {
    let stopped = false
    try {
      if (config.host) port.off('message', receive)
      closing = true
      unsubscribe()
      await spillReader?.dispose()
      await spillWriter?.dispose()
      lifetime.abort()
      deliveryBindings.close()
      deliveries.clear()
      await warming?.done.catch(() => {})
      await ingestion.drain()
      await owner.close()
      stopped = true
    } finally {
      transport.dispose()
      emitDiagnostic({ event: 'process.exit', operation: 'shutdown', outcome: stopped ? 'completed' : 'failed', reason: stopped ? 'normal' : 'unknown_error' })
      await stopDiagnostics()
    }
  }, 'memory owner')
  diagnosticsTransferred = true
  await connection.start()
  const epoch = owner.epoch
  if (epoch && owner.ready()) {
    watchedEpoch = epoch
    await warmOwner(epoch)
  }
  return owner
}
