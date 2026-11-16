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
import { MEMORY_HOST_PROTOCOL, parseHostMemoryCommand } from '../../../src/memory/contracts/host.ts'
import { openMemoryOwner } from '../../../src/memory/node/owner.ts'
import type { MemoryPluginConfig } from './config.ts'
import { createMemoryTransport } from './transport.ts'
import type { MemoryTransportOrigin } from './transport.ts'
import { createSessionIngestion, retrievalQuestion } from './ingestion.ts'
import { completeMemoryModel } from './model.ts'
import { assertMemoryProviderSupported } from './providers.ts'
import { registerMemoryTools } from './tools.ts'
import { registerMemoryFileCommands } from './file-commands.ts'
import { memoryOriginalContentDigest } from './context-recovery.ts'
import { createMemoryDeliveryBindings } from './delivery-provenance.ts'
import { trackNativeOutputAttempts } from './native/output-attempts.ts'
import { trackNativeToolReads, type NativeToolLease } from './native/tool-reads.ts'
import { recordCompactionInputs, recordCompactionRequest } from './native/compaction-inputs.ts'
import type { MemoryDeliveryProof, MemoryToolOrigin } from './delivery-provenance.ts'

import { memorySource } from './source.ts'

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

/** Mount once per DSH process. All correctness paths work with no parent process/channel. */
export async function applyMemoryAdapter(ctx: Context, config: MemoryPluginConfig = {}, port = process) {
  const caller = new AsyncLocalStorage<{ agent: Agent, contextGeneration: number, toolOrigin?: MemoryToolOrigin, toolRead?: NativeToolLease } | { jobId: string }>()
  const deliveries = new Map<string, Promise<MemoryDeliveryProof>>()
  const deliveryBindings = createMemoryDeliveryBindings()
  const lifetime = new AbortController()
  let closing = false
  let lastRoute: { provider: string, model: string } | null = null
  const send = (message: object) => { if (config.host && port.connected) port.send?.(message, () => {}) }
  const root = path.resolve(config.dataRoot ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'memory'))
  const embedding = config.modelRoot ? { modelRoot: config.modelRoot, runtimeRoot: config.runtimeRoot } : undefined
  let lastState = ''
  let effectsRevision = 0
  const state = (force = false) => {
    const value = { type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch,
      state: owner.status(), revision: owner.runtime.revision(), coreEpoch: owner.runtime.epoch(), effectsRevision }
    const encoded = JSON.stringify(value)
    if (force || encoded !== lastState) { lastState = encoded; send(value) }
  }
  const owner = openMemoryOwner({ root, hostNamespace: config.host ? 'viva' : undefined, embedding, dailyNotes: config.dailyNotes ?? true, fileMode: config.fileMode ?? true,
    route: () => lastRoute ?? ctx.agents.list().map(agent => agent.model.current()).find(route => route !== undefined) ?? null,
    compute: (job, signal, tools) => {
      const deadline = AbortSignal.timeout(isDailyMemoryStage(job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : 115_000)
      const combined = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : [])])
      return caller.run({ jobId: job.id }, () => completeMemoryModel(ctx, job, combined, tools)).catch(error => {
        if (error instanceof MemoryComputeError) throw error
        if (combined.aborted) throw new MemoryComputeError(combined.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted')
        throw new MemoryComputeError('call-failed')
      })
    },
    quiesce: async () => {
      // A user may forget from inside pre-step: waiting for that same turn here deadlocks.
      const current = caller.getStore()
      for (const agent of ctx.agents.list()) if (agent.status === 'running' && (!current || !('agent' in current) || current.agent !== agent)) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      }
    },
    onContextUsed: notice => send({ type: 'memory_owner_context_used', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, ...notice }),
    onProjectionChanged: () => send({ type: 'memory_owner_projection', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, revision: owner.runtime.revision() }),
    onChange: change => { state(); send({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, ...change }) }, onHostEffects: () => { effectsRevision++; state() },
  })
  const transport = createMemoryTransport(owner)
  const outputAttempts = (config.fileMode ?? true) ? trackNativeOutputAttempts(owner.contextGeneration, owner.finishNativeOutput) : null
  const toolReads = (config.fileMode ?? true) ? trackNativeToolReads(owner.finishNativeToolRead) : null
  const ingestion = createSessionIngestion(owner, session => ctx.sessions.flush(session), async (_session, message) => {
    const proof = deliveries.get(message.id)
    if (!proof) return undefined
    try { return await proof } finally { deliveries.delete(message.id) }
  })
  const recovery = owner.recover()
  ctx.inject(['commands'], scoped => {
    if (!config.host && (config.fileMode ?? true)) scoped.effect(() => registerMemoryFileCommands(scoped.commands, owner, async (agent, signal) => {
      const session = agent.session
      const active = () => !closing && !signal.aborted && ctx.sessions.get(session.id) === session
        && ctx.agents.get(session.id) === agent && agent.status !== 'running'
      await recovery
      if (!active() || !owner.ready()) return false
      await ingestion.synchronize(session)
      return active() && owner.ready()
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
    console.error('[memory] session intake failed', error instanceof Error ? error.message : 'unknown error')
  }
  ctx.on('session/disposed', session => { disposed.add(session); deliveryBindings.release(String(session.id)) })
  const observe = (session: Session) => {
    if (owner.ready() && !owner.nativeContextRewritten(String(session.id))) {
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
    if ((config.fileMode ?? true) && !closing) recordCompactionInputs(session, sourceEventSeqs)
    return next()
  })
  ctx.on('session/event', (session, event) => {
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
          deliveries.set(message.id, Promise.resolve(deliveryBindings.relay(source.senderSessionId, String(session.id), digest, execution.toolOrigin)))
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
    deliveryBindings.start(info.runId, String(info.parentSessionId), String(info.id), owner.contextGeneration(String(info.parentSessionId)), owner.contextGeneration(String(info.id)))
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
    await ingestion.synchronize(agent.session)
    signal?.throwIfAborted()
    if (!owner.ready()) throw new Error('Memory owner is not ready')
    const context = owner.sessionContext(String(agent.session.id))
    const read = () => owner.runtime.handleModelRequest(input, context, () => owner.ready() && !signal?.aborted, signal)
    if (!toolReads || !['recall', 'file_read', 'node_search', 'clarify'].includes(input.op)) return read()
    const execution = caller.getStore()
    // File tools only return bytes through an authenticated native execution.
    if (!execution || !('agent' in execution) || execution.agent !== agent || !execution.toolRead) return '{"status":"unavailable"}'
    return owner.withNativeToolRead(execution.toolRead, read)
  }
  // Automatic tool review may omit sessionId. Bind the actual execution, not its text.
  let unbindTools: (() => unknown) | undefined
  const bindTools = () => {
    unbindTools?.()
    unbindTools = ctx.on('tools/pre-execute', (exec, next) => {
      if (!exec.agent) return next()
      const agent = exec.agent, origin = deliveryBindings.tool(String(agent.session.id), String(exec.rootCallId))
      const generation = origin?.generation ?? 0
      if (generation !== owner.contextGeneration(String(agent.session.id))) throw new Error('Tool review belongs to a retired context generation')
      toolReads?.bind(agent.session, exec)
      return caller.run({ agent, contextGeneration: generation, toolOrigin: origin }, async () => {
        await ingestion.synchronize(agent.session)
        return next()
      })
    }, { prepend: true })
    return undefined
  }
  bindTools()
  ctx.on('agent/created', bindTools)
  ctx.on('tools/execute', (exec, next) => {
    if (!exec.agent) return next()
    const agent = exec.agent, origin = deliveryBindings.tool(String(agent.session.id), String(exec.rootCallId))
    // Unknown old calls may only retain the initial generation; they never inherit a recovery's
    // fresh authority just because execution or an asynchronous relay was delayed.
    const generation = origin?.generation ?? 0
    if (generation !== owner.contextGeneration(String(agent.session.id))) throw new Error('Tool call belongs to a retired context generation')
    const toolRead = toolReads?.acquire(agent.session, exec, generation)
    return caller.run({ agent, contextGeneration: generation, toolOrigin: origin, toolRead }, next)
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const current = caller.getStore()
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : current && 'agent' in current ? current.agent : undefined
    const session = options.sessionId ? ctx.sessions.get(options.sessionId) : agent?.session
    const contextGeneration = session ? current && 'agent' in current && current.agent.session === session
      ? current.contextGeneration : owner.contextGeneration(String(session.id)) : undefined
    const jobId = current && 'jobId' in current ? current.jobId : undefined
    if (!session && !jobId) throw new Error('Model request has no verified memory origin')
    if (!owner.ready()) throw new Error('Memory owner is not ready')
    if ((config.fileMode ?? true) && session && options.purpose === 'compaction') recordCompactionRequest(session, options.messages)
    // Only the pinned loop's own request object may inherit the active attempt.
    const loopRequest = outputAttempts && isAgentLoopRequest(options)
    const output = loopRequest && session ? outputAttempts.prepare(session) : undefined
    if (loopRequest && !output) throw new Error('Model request has no active native output attempt')
    if (session) {
      await ingestion.synchronize(session)
      if (output && outputAttempts?.current(session) !== output) throw new Error('Model output attempt changed while its marker was being persisted')
      if (contextGeneration !== owner.contextGeneration(String(session.id))) throw new Error('Model request belongs to a retired context generation')
      if (options.purpose === 'session-title') {
        const recorded = session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')
        if (recorded?.type !== 'session/title-llm-request') throw new Error('Session title has no recorded source dependencies')
        await ingestion.titleDependencies(session, recorded.data.messageSeqs)
      }
    }
    // Only audited fetch-based adapters provide an observable physical send/retry boundary.
    assertMemoryProviderSupported(ctx.llm, options.provider)
    const origin: MemoryTransportOrigin = session ? { session: String(session.id), contextGeneration, ...(output ? { output } : {}) } : { jobId: jobId! }
    const currentOrigin = () => owner.ready() && ('jobId' in origin
      ? Boolean(owner.runtime.computeAdmission(origin.jobId)?.current())
      : origin.contextGeneration === owner.contextGeneration(origin.session)
        && owner.coordination.allowsSession(origin.session, owner.sessionContext(origin.session).project))
    const stream = transport.run(origin, next)
    const iterator = stream[Symbol.asyncIterator]()
    try {
      for (;;) {
        const chunk = await transport.run(origin, () => iterator.next())
        if (!currentOrigin()) throw new Error('Memory context changed before model output was accepted')
        if (chunk.done) return
        yield chunk.value
      }
    } finally { await transport.run(origin, () => iterator.return?.()) }
  }, { prepend: true })
  ctx.on('system-prompt/assemble', (_presentation, { agent, toolSet, signal }, next) => {
    if (agent && toolSet && signal) toolReads?.assembly(agent.session, signal, toolSet)
    return next()
  })
  ctx.on('agent/pre-step', ({ agent, messages, turn, step, signal }, next) => caller.run({ agent, contextGeneration: owner.contextGeneration(String(agent.session.id)) }, async () => {
    if (!owner.ready()) throw new Error('Memory owner is not ready')
    toolReads?.step(agent.session, turn, step, signal)
    // This hook precedes request construction. Never recover inside llm/stream: its options
    // may already contain the retired transcript, including on SDK transport retries.
    await ingestion.recoverContext(agent.session, () => !signal.aborted)
    const execution = caller.getStore()
    if (execution && 'agent' in execution) execution.contextGeneration = owner.contextGeneration(String(agent.session.id))
    deliveryBindings.step(String(agent.session.id), turn, step, owner.contextGeneration(String(agent.session.id)),
      new Map(ctx.sessions.list().map(session => [String(session.id), owner.contextGeneration(String(session.id))])))
    const selected = agent.model.current()
    if (selected) lastRoute = { provider: selected.provider, model: selected.model }
    // Receipt precedes downstream hooks; admission is recorded only for the accepted message list.
    await ingestion.receive(agent.session, messages, turn, step, false)
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const receipts = await ingestion.receive(agent.session, decision.messages, turn, step, true)
    const question = retrievalQuestion(receipts)
    if (!question) return decision
    clearPreviousContext(agent)
    const text = await request({ op: 'context', session: String(agent.session.id), turn, question }, agent, signal)
    if (!text || signal.aborted) return decision
    const message = createUserMessage({ content: [{ type: 'text', text }], source: memorySource })
    await owner.registerDerived({ sessionId: String(agent.session.id), messageId: message.id, nativeUserSource: memorySource.kind, sourceIds: owner.dispatch.snapshot(String(agent.session.id)).sources,
      contextGeneration: owner.contextGeneration(String(agent.session.id)), contentDigest: memoryOriginalContentDigest(message) })
    return { ...decision, messages: [...decision.messages, message] }
  }), { prepend: true })
  registerMemoryTools(ctx, request, async (questionId, text, agent, signal) => {
    const execution = caller.getStore()
    if (!execution || !('agent' in execution) || execution.agent !== agent || signal?.aborted) return false
    return Boolean(await owner.acceptFileClarification({ session: String(agent.session.id), contextGeneration: execution.contextGeneration,
      questionId, text, requireShown: false }, () => !closing && !disposed.has(agent.session) && !signal?.aborted))
  }, (questionId, agent) => {
    owner.runtime.cancelFileClarification(String(agent.session.id), questionId)
  })

  const receive = (raw: unknown) => {
    const message = objectOf(raw)
    if (!config.host || message?.type !== 'memory_host_request' || typeof message.requestId !== 'string') return
    const requestId = message.requestId
    void (async () => {
      if (message.protocol !== MEMORY_HOST_PROTOCOL || message.epoch !== owner.epoch) throw new Error('Memory host protocol or epoch mismatch')
      const command = parseHostMemoryCommand(message.method, message.input)
      let result: unknown
      if (command.method === 'recoverContext') {
        const id = SessionId(command.input.args[0]), session = ctx.sessions.get(id)
        const idle = () => !closing && Boolean(session) && ctx.sessions.get(id) === session && ctx.agents.get(id)?.status !== 'running'
        if (!session || !idle()) result = false
        else {
          await ingestion.recoverContext(session, idle)
          await ingestion.synchronize(session)
          result = idle() && !owner.needsContextRecovery(String(id))
            && owner.coordination.allowsSession(String(id), owner.sessionContext(String(id)).project)
        }
      } else result = await owner.handleHost(command.method, command.input)
      // The host must see recovery/admission metadata before an acknowledged mutation resumes work.
      state()
      send({ type: 'memory_host_result', requestId, epoch: owner.epoch, ok: true, result })
    })().catch(error => send({ type: 'memory_host_result', requestId, epoch: owner.epoch, ok: false,
      error: memoryHostFailure(error) }))
  }
  if (config.host) port.on('message', receive)
  ctx.effect(() => async () => {
    if (config.host) port.off('message', receive)
    closing = true
    lifetime.abort()
    deliveryBindings.close()
    deliveries.clear()
    await ingestion.drain()
    await owner.close()
    transport.dispose()
  }, 'memory owner')
  state()
  await recovery
  if (owner.ready()) for (const session of ctx.sessions.list()) {
    try {
      const idle = () => ctx.sessions.get(session.id) === session && ctx.agents.get(session.id)?.status !== 'running'
      if (idle()) await ingestion.recoverContext(session, idle)
      await ingestion.synchronize(session)
    } catch (error) { report(error, session) }
  }
  state()
  return owner
}
