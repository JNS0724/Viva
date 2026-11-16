import { memoryHostFailure } from '../../../src/memory/contracts/domain-error.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-log-deepseek'
import type {} from '@deepseek-ai/dsh-session-title-llm'
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
import { createControlReceipts } from './control-receipts.ts'

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
  const caller = new AsyncLocalStorage<{ agent: Agent } | { jobId: string }>()
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
  const controlReceipts = createControlReceipts()
  const owner = openMemoryOwner({ root, hostNamespace: config.host ? 'viva' : undefined, embedding, dailyNotes: config.dailyNotes ?? true,
    canPresentControlReceipt: controlReceipts.available,
    route: () => lastRoute ?? ctx.agents.list().map(agent => agent.model.current()).find(route => route !== undefined) ?? null,
    compute: (job, signal) => {
      const deadline = AbortSignal.timeout(isDailyMemoryStage(job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : 115_000)
      const combined = AbortSignal.any([lifetime.signal, deadline, ...(signal ? [signal] : [])])
      return caller.run({ jobId: job.id }, () => completeMemoryModel(ctx, job, combined)).catch(error => {
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
  const ingestion = createSessionIngestion(owner, session => ctx.sessions.flush(session))
  const recovery = owner.recover()
  ctx.inject(['commands'], scoped => {
    const dispose = controlReceipts.bind(scoped.commands)
    scoped.effect(() => dispose, 'memory local receipts')
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
  ctx.on('session/disposed', session => { disposed.add(session) })
  const observe = (session: Session) => {
    if (owner.ready()) void ingestion.synchronize(session).catch(error => report(error, session))
    // Prepared host source changes resume through the host outbox; the next admitted step replays.
  }
  ctx.on('session/event', (session, event) => {
    if (!closing && (event.type !== 'agent/inbox/spliced' || event.data.inserted.length > 0)
      && ['agent/inbox/spliced', 'user/message', 'assistant/message', 'turn/end'].includes(event.type)) {
      observe(session)
    }
  })
  ctx.on('session/created', session => { if (!closing) observe(session) })
  // The native lifecycle fires before foreground result resolution; background notices also carry sender identity.
  // Serialize it with parent intake: a failed provenance transfer blocks that parent's next request.
  ctx.on('subagent/end', info => {
    const parent = ctx.sessions.get(info.parentSessionId)
    if (!closing && parent) void ingestion.derived(parent, { messageId: `subagent-end:${info.runId}`, sourceIds: [],
      senderSessionId: String(info.id) }).catch(error => report(error, parent))
  })

  const request = async (input: MemoryRequest, agent: Agent, signal?: AbortSignal) => {
    await ingestion.synchronize(agent.session)
    signal?.throwIfAborted()
    if (!owner.ready()) throw new Error('Memory owner is not ready')
    const context = owner.sessionContext(String(agent.session.id))
    return owner.runtime.handleModelRequest(input, context, () => owner.ready() && !signal?.aborted, signal)
  }
  // Automatic tool review may omit sessionId. Bind the actual execution, not its text.
  let unbindTools: (() => unknown) | undefined
  const bindTools = () => {
    unbindTools?.()
    unbindTools = ctx.on('tools/pre-execute', (exec, next) => exec.agent ? caller.run({ agent: exec.agent }, async () => {
      await ingestion.synchronize(exec.agent!.session)
      return next()
    }) : next(), { prepend: true })
    return undefined
  }
  bindTools()
  ctx.on('agent/created', bindTools)
  ctx.on('llm/stream', async function* (options, next) {
    const current = caller.getStore()
    const agent = options.sessionId ? ctx.agents.get(options.sessionId) : current && 'agent' in current ? current.agent : undefined
    const session = options.sessionId ? ctx.sessions.get(options.sessionId) : agent?.session
    const jobId = current && 'jobId' in current ? current.jobId : undefined
    if (!session && !jobId) throw new Error('Model request has no verified memory origin')
    if (!owner.ready()) throw new Error('Memory owner is not ready')
    if (session) {
      await ingestion.synchronize(session)
      if (options.purpose === 'session-title') {
        const recorded = session.snapshotEvents().findLast(event => event.type === 'session/title-llm-request')
        if (recorded?.type !== 'session/title-llm-request') throw new Error('Session title has no recorded source dependencies')
        await ingestion.titleDependencies(session, recorded.data.messageSeqs)
      }
    }
    // Only audited fetch-based adapters provide an observable physical send/retry boundary.
    assertMemoryProviderSupported(ctx.llm, options.provider)
    const origin: MemoryTransportOrigin = session ? { session: String(session.id) } : { jobId: jobId! }
    const currentOrigin = () => owner.ready() && ('jobId' in origin
      ? Boolean(owner.runtime.computeAdmission(origin.jobId)?.current())
      : owner.coordination.allowsSession(origin.session, owner.sessionContext(origin.session).project))
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
  ctx.on('agent/pre-step', ({ agent, messages, turn, step, signal }, next) => caller.run({ agent }, async () => {
    if (!owner.ready()) throw new Error('Memory owner is not ready')
    const selected = agent.model.current()
    if (selected) lastRoute = { provider: selected.provider, model: selected.model }
    // Receipt precedes downstream hooks; admission is recorded only for the accepted message list.
    await ingestion.receive(agent.session, messages, turn, step, false)
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const receipts = await ingestion.receive(agent.session, decision.messages, turn, step, true)
    const controls = receipts.flatMap(receipt => receipt.controlReceipt ? [receipt.controlReceipt] : [])
    if (controls.length) {
      await controlReceipts.publish(agent, controls)
      await ctx.sessions.flush(agent.session)
      return { kind: 'reject' as const }
    }
    const question = retrievalQuestion(receipts)
    if (!question) return decision
    clearPreviousContext(agent)
    const text = await request({ op: 'context', session: String(agent.session.id), turn, question }, agent, signal)
    if (!text || signal.aborted) return decision
    const message = createUserMessage({ content: [{ type: 'text', text }], source: memorySource })
    await owner.registerDerived({ sessionId: String(agent.session.id), messageId: message.id, sourceIds: owner.dispatch.snapshot(String(agent.session.id)).sources })
    return { ...decision, messages: [...decision.messages, message] }
  }), { prepend: true })
  registerMemoryTools(ctx, request)

  const receive = (raw: unknown) => {
    const message = objectOf(raw)
    if (!config.host || message?.type !== 'memory_host_request' || typeof message.requestId !== 'string') return
    const requestId = message.requestId
    void (async () => {
      if (message.protocol !== MEMORY_HOST_PROTOCOL || message.epoch !== owner.epoch) throw new Error('Memory host protocol or epoch mismatch')
      const command = parseHostMemoryCommand(message.method, message.input)
      const result = await owner.handleHost(command.method, command.input)
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
    await ingestion.drain()
    await owner.close()
    transport.dispose()
  }, 'memory owner')
  state()
  await recovery
  if (owner.ready()) for (const session of ctx.sessions.list()) await ingestion.synchronize(session)
  state()
  return owner
}
