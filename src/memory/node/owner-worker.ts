import path from 'node:path'
import { z } from 'zod'
import { parseDiagnosticContext, safeDiagnosticEvent, type DiagnosticPort } from '../../diagnostics/contracts.ts'
import { diagnosticContext, diagnosticPort, installDiagnosticPort, newDiagnosticContext, withRemoteOperation } from '../../diagnostics/node/context.ts'
import { MemoryComputeError, type MemoryComputeTools } from '../contracts/compute.ts'
import { MEMORY_HOST_PROTOCOL } from '../contracts/host.ts'
import { isDailyMemoryStage, memoryComputeFailure, memorySidecarRequest } from '../contracts/memory-contract.ts'
import { DAILY_MEMORY_DEFAULTS } from '../contracts/memory-daily-defaults.ts'
import { OWNER_RPC_MAX_BUDGET_MS } from '../contracts/owner-rpc.ts'
import { objectOf } from '../contracts/unknown-value.ts'
import type { OwnerAdapterApi } from './owner-adapter.ts'
import { createOwnerRpcPeer } from './owner-rpc-peer.ts'
import { openMemoryOwner } from './owner.ts'

type Owner = ReturnType<typeof openMemoryOwner>
const routeSchema = z.strictObject({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256) })
const bootSchema = z.strictObject({
  root: z.string().refine(path.isAbsolute),
  hostNamespace: z.string().min(1).max(256).optional(),
  embedding: z.strictObject({ modelRoot: z.string().refine(path.isAbsolute), runtimeRoot: z.string().refine(path.isAbsolute).optional() }).optional(),
  dailyNotes: z.boolean().optional(),
  preserveActiveTurns: z.boolean(),
})
const idSchema = z.string().min(1).max(256)

if (!process.send || !process.connected || process.argv[2] !== '--memory-owner-ipc') throw new Error('Memory owner requires its dedicated parent IPC')

let owner: Owner | undefined
let booted = false
let closing = false
let route: z.output<typeof routeSchema> | null = null
let lastState = ''
let lastProfileKey = ''
const computeTools = new Map<string, MemoryComputeTools>()
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
const publishProfile = (force = false) => {
  if (!owner || !booted || closing) return
  if (!force && owner.status() !== 'ready') return
  const snapshot = owner.profileSnapshot()
  const profileDeletionGen = owner.runtime.profileDeletionGeneration()
  const key = JSON.stringify([snapshot.epoch, snapshot.text, profileDeletionGen])
  if (!force && key === lastProfileKey) return
  lastProfileKey = key
  notify({ type: 'memory_owner_profile', protocol: MEMORY_HOST_PROTOCOL, ...snapshot, profileDeletionGen })
}
const publishState = (overrideState?: 'ready' | 'recovering' | 'unavailable') => {
  if (!owner || !booted || closing) return
  const state = { type: 'memory_owner_state', protocol: MEMORY_HOST_PROTOCOL, epoch: owner.epoch, state: overrideState ?? owner.status(),
    revision: owner.runtime.revision(), coreEpoch: owner.runtime.epoch(),
    profileDeletionGen: owner.runtime.profileDeletionGeneration(), pid: process.pid }
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
        const obj = objectOf(error)
        const reason = obj?.reason
        const retryAfterMs = typeof obj?.retryAfterMs === 'number' && Number.isInteger(obj.retryAfterMs) && obj.retryAfterMs > 0
          ? obj.retryAfterMs : undefined
        const known = memoryComputeFailure.safeParse(reason)
        if (known.success) throw new MemoryComputeError(known.data, retryAfterMs !== undefined ? { retryAfterMs } : undefined)
        if (reason === 'oversize-reply' || reason === 'missing-reply' || reason === 'context-window-exceeded') throw new MemoryComputeError(reason)
        if (signal?.aborted) throw new MemoryComputeError('aborted')
        throw new MemoryComputeError('call-failed')
      } finally { computeTools.delete(job.id) }
    },
    onContextUsed: notice => notify({ type: 'memory_owner_context_used', protocol: MEMORY_HOST_PROTOCOL, epoch: owner!.epoch, ...notice }),
    onChange: change => {
      publishState()
      notify({ type: 'memory_owner_change', protocol: MEMORY_HOST_PROTOCOL, epoch: owner!.epoch, ...change })
      publishProfile()
    },
  })
  await owner.recover(preserveActiveTurns)
  signal.throwIfAborted()
  booted = true
  // Three-step boot sequence: establish epoch (recovering) -> stage initial L2 profile -> publish ready.
  if (owner.status() === 'ready') {
    publishState('recovering')
    publishProfile(true)
    publishState('ready')
  } else {
    publishState()
  }
}

const inputFrame = z.strictObject({ method: z.string(), args: z.array(z.unknown()).max(8) })
function runAdapter(current: Owner, raw: unknown, signal: AbortSignal) {
  const { method, args } = inputFrame.parse(raw)
  // Only these operations can run on behalf of the native DSH adapter.
  const handlers: OwnerAdapterApi = {
    receiveSource: current.receiveSource,
    completeTurn: input => current.completeTurn(input, signal),
    bindIntakeSession: (session, cwd, task) => current.bindIntakeSession(idSchema.parse(session), z.string().nullish().parse(cwd), task === true),
    intakeWatermark: session => current.intakeWatermark(idSchema.parse(session)),
    advanceIntake: (session, nextSeq) => current.advanceIntake(idSchema.parse(session), z.int().nonnegative().parse(nextSeq)),
    rememberStandaloneFile: current.rememberStandaloneFile,
    forgetStandaloneFile: (session, id, operation) => current.forgetStandaloneFile(session, id, operation, signal),
    sidecarRequest: (raw, cwd) => {
      const request = memorySidecarRequest.parse(raw)
      const session = request.session
      return (async () => {
        if (!current.ready() || signal.aborted) return null
        const resolved = current.resolveIntakeScope(cwd)
        const origin = current.sessionContext(session)
        const project = resolved.status === 'project' ? resolved.project : undefined
        const scopeCurrent = current.scopeMatches(session, resolved)
        if (request.op === 'remember') {
          if (!scopeCurrent) return '{"status":"unavailable"}'
          const result = await current.rememberSidecarFile(session, request.text.trim(), signal)
          return JSON.stringify(result ? { status: 'accepted', id: result.identity.id, revision: result.contentRevision }
            : { status: 'rejected', reason: 'no-explicit-user-source' })
        }
        const readScope = scopeCurrent ? { ...origin, project } : { ...origin, project: undefined, context: { kind: 'user' as const } }
        return current.runtime.handleModelRequest(request, readScope, current.ready, signal)
      })()
    },
    automaticRecall: (raw, cwd, originals) => {
      const request = z.strictObject({ session: idSchema, turn: z.number().int().positive(), question: z.string().max(20_000) }).parse(raw)
      const session = request.session
      return (async () => {
        const epoch = current.epoch
        if (!current.ready() || signal.aborted) {
          return { epoch, revision: current.runtime.revision(), stale: false, result: { status: 'unavailable' as const } }
        }
        const resolved = current.resolveIntakeScope(cwd)
        const origin = current.sessionContext(session)
        const project = resolved.status === 'project' ? resolved.project : undefined
        const scopeCurrent = current.scopeMatches(session, resolved)
        const readScope = scopeCurrent ? { ...origin, project } : { ...origin, project: undefined, context: { kind: 'user' as const } }
        const question = originals ? current.intakeQuery(session, readScope.project, originals) : request.question
        if (!question.trim()) {
          return { epoch, revision: current.runtime.revision(), stale: false, result: { status: 'skipped' as const } }
        }
        const startRevision = current.runtime.revision()
        const result = await current.runtime.automaticRecall({ session, turn: request.turn, question }, readScope, current.ready, signal)
        const endRevision = current.runtime.revision()
        return {
          epoch,
          revision: endRevision,
          stale: result.status === 'hit' && startRevision !== endRevision,
          result,
        }
      })()
    },
    reportContextUsed: raw => {
      const input = z.strictObject({
        session: idSchema,
        turn: z.number().int().positive(),
        pushed: z.array(z.strictObject({ text: z.string(), names: z.array(z.string()) })),
      }).parse(raw)
      current.reportContextUsed(input)
    },
    setRoute: next => {
      const previous = route
      route = next === null ? null : routeSchema.parse(next)
      if (route && (route.provider !== previous?.provider || route.model !== previous.model)) void current.runtime.wake()
    },
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
    if (method === 'boot') {
      try { return await boot(raw, signal) }
      catch (error) {
        // SQLite encodes extended result codes above the low byte. IPC carries the safe classification.
        if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number') {
          const primary = error.errcode & 255
          if (primary === 11 || primary === 26) throw Object.assign(error, { code: 'invalid_record' }) // CORRUPT, NOTADB
          if (primary === 3 || primary === 8) throw Object.assign(error, { code: 'denied' }) // PERM, READONLY
        }
        throw error
      }
    }
    if (method === 'shutdown') {
      closing = true
      await Promise.allSettled(adapterExecutions)
      await owner?.close()
      return
    }
    if (!owner || !booted || closing) throw new Error('Memory owner is unavailable')
    try {
      if (method === 'adapterExited') {
        route = null
        // Intake can durably record its active turn after a caller has stopped waiting.
        await Promise.allSettled(adapterExecutions)
        return owner.reconcileActiveTurns([])
      }
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
      const deadlineAt = typeof envelope?.deadlineAt === 'number' ? envelope.deadlineAt : undefined
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new Error('Memory intake deadline elapsed')
      const host = owner
      const diagnostic = parseDiagnosticContext(envelope?.diagnostics)
      return await withRemoteOperation(diagnostic, 'memory.owner', () => host.handleHost(envelope?.method, envelope?.input, signal, deadlineAt),
        { identities: { ownerEpoch: host.epoch, methodId: typeof envelope?.method === 'string' ? envelope.method : undefined } })
    } finally { publishState() }
  },
})
process.on('message', raw => { peer.receive(raw) })
// An orphan must release SQLite and stop all writes.
process.once('disconnect', () => process.exit(0))
