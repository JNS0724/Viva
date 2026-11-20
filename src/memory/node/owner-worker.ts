import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { z } from 'zod'
import { parseDiagnosticContext, safeDiagnosticEvent, type DiagnosticPort } from '../../diagnostics/contracts.ts'
import { diagnosticContext, diagnosticPort, installDiagnosticPort, newDiagnosticContext, withRemoteOperation } from '../../diagnostics/node/context.ts'
import { MemoryComputeError, type MemoryComputeTools } from '../contracts/compute.ts'
import { MEMORY_HOST_PROTOCOL } from '../contracts/host.ts'
import { isDailyMemoryStage, memoryComputeFailure, memoryRequest } from '../contracts/memory-contract.ts'
import { DAILY_MEMORY_DEFAULTS } from '../contracts/memory-daily-defaults.ts'
import { OWNER_RPC_MAX_ACTIVE, OWNER_RPC_MAX_BUDGET_MS } from '../contracts/owner-rpc.ts'
import { objectOf } from '../contracts/unknown-value.ts'
import type { OwnerAdapterApi, OwnerSendOrigin, RemoteToolReadScope } from './owner-adapter.ts'
import type { NativeToolReadScope } from './native-tool-reads.ts'
import { createOwnerRpcPeer } from './owner-rpc-peer.ts'
import { openMemoryOwner } from './owner.ts'

type Owner = ReturnType<typeof openMemoryOwner>
const routeSchema = z.strictObject({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256) })
const turnSchema = z.strictObject({ sessionId: z.string().min(1).max(256), turn: z.int().nonnegative() })
const bootSchema = z.strictObject({
  root: z.string().refine(path.isAbsolute),
  hostNamespace: z.string().min(1).max(256).optional(),
  embedding: z.strictObject({ modelRoot: z.string().refine(path.isAbsolute), runtimeRoot: z.string().refine(path.isAbsolute).optional() }).optional(),
  dailyNotes: z.boolean().optional(),
  preserveActiveTurns: z.boolean(),
})
const idSchema = z.string().min(1).max(256)
const attemptId = z.uuid()

if (!process.send || !process.connected || process.argv[2] !== '--memory-owner-ipc') throw new Error('Memory owner requires its dedicated parent IPC')

let owner: Owner | undefined
let booted = false
let closing = false
let route: z.output<typeof routeSchema> | null = null
let effectsRevision = 0
let lastState = ''
const sessions = new AsyncLocalStorage<string | undefined>()
const computeTools = new Map<string, MemoryComputeTools>()
type Grant = { origin: OwnerSendOrigin, lifetime: AbortController, permit?: ReturnType<Owner['acquireSend']> }
const permits = new Map<string, Grant>()
const adapterExecutions = new Set<Promise<unknown>>()
let pendingDiagnostics = 0
const diagnosticRelay: DiagnosticPort = {
  emit(raw, context) {
    // Keep optional telemetry bounded and prevent a stalled parent sink delaying RPC replies.
    if (!owner || pendingDiagnostics >= 32 || !process.connected || !process.send) return
    const event = safeDiagnosticEvent(raw)
    if (!event) return
    pendingDiagnostics++
    try {
      process.send({ type: 'memory_owner_diagnostic', epoch: owner.epoch, event, context }, () => { pendingDiagnostics-- })
    } catch { pendingDiagnostics-- }
  },
  bind(operation, fields, context = newDiagnosticContext(diagnosticContext())) {
    return { emit(event) {
      diagnosticRelay.emit({ ...fields, ...event, operation,
        identities: { ...fields.identities, ...event.identities }, metrics: { ...fields.metrics, ...event.metrics },
      }, context)
    } }
  },
}
installDiagnosticPort(diagnosticRelay)
const notify = (event: object) => {
  if (process.connected) peer.notify(event)
}
const publishState = () => {
  if (!owner || !booted || closing) return
  const state = { type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, state: owner.status(),
    revision: owner.runtime.revision(), coreEpoch: owner.runtime.epoch(), effectsRevision }
  const encoded = JSON.stringify(state)
  if (encoded !== lastState) { lastState = encoded; notify(state) }
}

async function boot(raw: unknown, signal: AbortSignal) {
  if (owner) throw new Error('Memory owner already started')
  const { preserveActiveTurns, ...settings } = bootSchema.parse(raw)
  owner = openMemoryOwner({
    ...settings,
    diagnostics: diagnosticPort,
    route: () => route,
    compute: async (job, signal, tools) => {
      if (tools) computeTools.set(job.id, tools)
      try {
        return await peer.call<string>('compute', { job, ...(tools ? { tools: tools.tools } : {}) }, {
          signal, budgetMs: Math.min(OWNER_RPC_MAX_BUDGET_MS, isDailyMemoryStage(job.stage) ? DAILY_MEMORY_DEFAULTS.backgroundTimeoutMs : 115_000),
        })
      } catch (error) {
        const reason = objectOf(error)?.reason
        const known = memoryComputeFailure.safeParse(reason)
        if (known.success) throw new MemoryComputeError(known.data)
        if (reason === 'oversize-reply' || reason === 'missing-reply' || reason === 'context-window-exceeded') throw new MemoryComputeError(reason)
        if (signal?.aborted) throw new MemoryComputeError('aborted')
        throw new MemoryComputeError('call-failed')
      } finally { computeTools.delete(job.id) }
    },
    quiesce: () => peer.call<void>('quiesce', { session: sessions.getStore() }),
    onContextUsed: notice => notify({ type: 'memory_owner_context_used', protocol: MEMORY_HOST_PROTOCOL, epoch: owner!.epoch, ...notice }),
    onChange: change => {
      publishState()
      notify({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: owner!.epoch, ...change })
    },
    onProjectionChanged: () => notify({ type: 'memory_owner_projection', protocol: MEMORY_HOST_PROTOCOL,
      epoch: owner!.epoch, revision: owner!.runtime.revision() }),
    onHostEffects: () => { effectsRevision++; publishState() },
  })
  await owner.recover(preserveActiveTurns)
  signal.throwIfAborted()
  booted = true
  publishState()
}

function nativeScope(scope: RemoteToolReadScope, signal: AbortSignal): NativeToolReadScope {
  const { readCut, ...identity } = scope
  return { ...identity, current: () => !signal.aborted, ...(readCut ? { readCut: () => readCut } : {}) }
}

function settleSend(id: string) {
  const grant = permits.get(id)
  if (!grant) return
  permits.delete(id)
  grant.lifetime.abort()
  grant.permit?.settled()
}

const inputFrame = z.strictObject({ method: z.string(), args: z.array(z.unknown()).max(8) })
function runAdapter(current: Owner, raw: unknown, signal: AbortSignal) {
  const { method, args } = inputFrame.parse(raw)
  // Only these operations can run on behalf of the native DSH adapter.
  const handlers: OwnerAdapterApi = {
    initializeSession: async input => current.initializeSession(input, await current.loadSessionFileProof(input.sessionId, signal, input.parentSessionId)),
    noteInheritedNativeCut: current.noteInheritedNativeCut,
    receiveSource: input => sessions.run(input.sessionId, () => current.receiveSource(input)),
    registerDerived: input => current.registerDerived(input, signal),
    completeTurn: input => sessions.run(input.sessionId, () => current.completeTurn(input, signal)),
    prepareContextRecovery: current.prepareContextRecovery,
    bindContextRecovery: current.bindContextRecovery,
    snapshot: current.dispatch.snapshot,
    rememberStandaloneFile: (session, input) => sessions.run(session, () => current.rememberStandaloneFile(session, input)),
    forgetStandaloneFile: (session, id, operation) => sessions.run(session, () => current.forgetStandaloneFile(session, id, operation, signal)),
    finishNativeOutput: current.finishNativeOutput,
    finishNativeToolRead: current.finishNativeToolRead,
    nativeToolEvidence: current.nativeToolEvidence,
    nativeSpillGoverned: current.nativeSpillGoverned,
    beginNativeSpill: current.beginNativeSpill,
    finishNativeSpill: current.finishNativeSpill,
    nativeSpillCandidates: current.nativeSpillCandidates,
    sessionView: async session => {
      idSchema.parse(session)
      const acceptsFiles = await current.loadSessionFileProof(session, signal)
      const sessionContext = current.sessionContext(session)
      return {
        contextGeneration: current.contextGeneration(session), contextRecovery: current.contextRecovery(session),
        needsContextRecovery: current.needsContextRecovery(session, undefined, acceptsFiles), nativeContextRewritten: current.nativeContextRewritten(session),
        allowsSession: current.coordination.allowsSession(session, sessionContext.project, acceptsFiles), sessionContext,
      }
    },
    commitContextRecovery: (input, checkId) => current.commitContextRecovery(input,
      () => peer.call<boolean>('checkRecovery', { checkId: attemptId.parse(checkId) }, { signal })),
    inheritNativeToolRead: (scope, evidence) => current.inheritNativeToolRead(nativeScope(scope, signal), evidence),
    admitNativeSpillRead: async (id, scope) => {
      const proof = await current.loadSpillFileProof(id, signal)
      return current.admitNativeSpillRead(id, nativeScope(scope, signal), signal, proof).current()
    },
    modelRequest: (request, session, generation, scope) => sessions.run(session, async () => {
      // The native DSH tools and runtime own argument semantics. Validate the operation
      // here without narrowing native file-tool input to the legacy memory RPC limits.
      if (!objectOf(request) || !memoryRequest.options.some(option => option.shape.op.value === request.op)) {
        throw new Error('Unsupported memory model request')
      }
      const sameOrigin = () => current.ready() && !signal.aborted && current.contextGeneration(session) === generation
      if (request.session !== session || !sameOrigin() || scope && (scope.call.session !== session || scope.call.generation !== generation)) {
        throw new Error('Memory request origin is unavailable')
      }
      const acceptsFiles = await current.loadSessionFileProof(session, signal)
      const allowed = () => sameOrigin() && !current.needsContextRecovery(session, undefined, acceptsFiles)
      if (!allowed()) throw new Error('Memory request origin is unavailable')
      if (request.op === 'remember') {
        if (!scope) return '{"status":"unavailable"}'
        const result = await current.withNativeToolRead(nativeScope(scope, signal), () => current.rememberNativeFile(request.text.trim()))
        return JSON.stringify(result ? { status: 'accepted', id: result.identity.id, revision: result.contentRevision }
          : { status: 'rejected', reason: 'no-explicit-user-source' })
      }
      const read = () => current.runtime.handleModelRequest(request, current.sessionContext(session), allowed, signal)
      if (request.op === 'context') return read()
      return scope ? current.withNativeToolRead(nativeScope(scope, signal), read) : '{"status":"unavailable"}'
    }),
    acquireSend: async (id, origin, digest) => {
      attemptId.parse(id)
      const payload = z.string().regex(/^[a-f0-9]{64}$/u).parse(digest)
      if (permits.size >= OWNER_RPC_MAX_ACTIVE || permits.has(id)) throw new Error('Memory send limit reached or duplicate grant')
      // Reserve the ID before awaiting disk. An adapter exit or settlement during
      // verification must retire this attempt before it can acquire a physical lease.
      const grant: Grant = { origin, lifetime: new AbortController() }
      const active = AbortSignal.any([signal, grant.lifetime.signal])
      permits.set(id, grant)
      try {
        const proof = await current.loadOutputProof(origin, active)
        active.throwIfAborted()
        grant.permit = current.acquireSend(id, origin, payload, proof)
        grant.permit.signal.addEventListener('abort', () => notify({ type: 'memory_owner_send_revoked', epoch: current.epoch, id }), { once: true })
      } catch (error) {
        if (permits.get(id) === grant) settleSend(id)
        throw error
      }
    },
    outputCurrent: async origin => current.outputCurrent(origin, await current.loadOutputProof(origin, signal)),
    recordSendBody: async id => {
      const grant = permits.get(id)
      const permit = grant?.permit
      if (!grant || !permit?.current()) throw new Error('Memory send permission expired')
      // External edits can happen while the transport prepares the body. Reload
      // at the actual send boundary, then check the same permit before recording it.
      const active = AbortSignal.any([signal, grant.lifetime.signal, permit.signal])
      const origin = grant.origin
      const proof = await current.loadOutputProof(origin, active)
      active.throwIfAborted()
      if (!permit.current() || !current.outputCurrent(origin, proof)) throw new Error('Memory send permission expired')
      permit.recordBody?.()
    },
    settleSend,
    setRoute: next => {
      const previous = route
      route = next === null ? null : routeSchema.parse(next)
      if (route && (route.provider !== previous?.provider || route.model !== previous.model)) void current.runtime.wake()
    },
    reconcileActiveTurns: turns => current.reconcileActiveTurns(z.array(turnSchema).max(10_000).parse(turns)),
    computeTool: (jobId, input) => {
      const tools = computeTools.get(jobId)
      if (!tools) throw new Error('Memory computation tools are unavailable')
      return tools.executeTool(input, signal)
    },
  }
  if (!Object.hasOwn(handlers, method)) throw new Error('Unknown memory adapter method')
  return Reflect.apply(handlers[method as keyof OwnerAdapterApi], undefined, args)
}

const peer = createOwnerRpcPeer({
  send(frame) {
    if (!process.connected || !process.send) throw new Error('Memory parent disconnected')
    process.send(frame, () => {})
  },
  async handle(method, raw, signal) {
    if (method === 'ping') return
    if (method === 'boot') return boot(raw, signal)
    if (method === 'shutdown') {
      closing = true
      // A graceful shutdown follows parent-confirmed transport drainage.
      for (const id of permits.keys()) settleSend(id)
      await Promise.allSettled(adapterExecutions)
      await owner?.close()
      return
    }
    if (!owner || !booted || closing) throw new Error('Memory owner is unavailable')
    try {
      if (method === 'adapterExited') {
        // Only the supervisor reports that the trusted sender has exited or drained.
        route = null
        for (const id of permits.keys()) settleSend(id)
        // Intake can durably record its active turn after a caller has stopped waiting.
        await Promise.allSettled(adapterExecutions)
        return owner.reconcileActiveTurns([])
      }
      if (method === 'nativeMaintenancePending') return owner.nativeMaintenancePending()
      if (method === 'adapter') {
        const current = owner
        const execution = Promise.resolve().then(() => {
          signal.throwIfAborted()
          return runAdapter(current, raw, signal)
        })
        adapterExecutions.add(execution)
        try { return await execution } finally { adapterExecutions.delete(execution) }
      }
      if (method !== 'host') throw new Error('Unsupported memory owner operation')
      const envelope = objectOf(raw)
      signal.throwIfAborted()
      const host = owner
      const diagnostic = parseDiagnosticContext(envelope?.diagnostics)
      return await withRemoteOperation(diagnostic, 'memory.owner', () => host.handleHost(envelope?.method, envelope?.input, signal),
        { identities: { ownerEpoch: host.epoch, methodId: typeof envelope?.method === 'string' ? envelope.method : undefined } })
    } finally { publishState() }
  },
})
process.on('message', raw => { peer.receive(raw) })
// An orphan must release SQLite and stop all writes even if a former send never settles.
process.once('disconnect', () => process.exit(0))
