import { randomUUID } from 'node:crypto'
import { emitDiagnostic, withOperation } from '../diagnostics/node/context.ts'
import { safeDiagnosticReason } from '../diagnostics/contracts.ts'
import { t } from '../shared/i18n/translate.ts'
import { asBound, asDecide, asFast, type Decided } from '../shared/request-routing/channel.ts'
import type { RequestRuntime } from './request-runtime.ts'

/**
 * The app's side of the routing channel (src/shared/request-routing/channel.ts). Before each prompt of the main
 * conversation the session is bound as main and the plugin confirms, so the first step is assembled with the main
 * agent's tools and persona (dsh assembles a step before agent/pre-step). Decisions the plugin passes on go to the
 * request runtime (request-runtime.ts), which is the authority on them.
 */
const BIND_WAIT_MS = 3_000

/** The request runtime as the bridge uses it: each request taken as it is sent, each decision and fast-lane outcome passed on. */
export type RoutingHandlers = Pick<RequestRuntime, 'receive' | 'decide' | 'fail' | 'noteFast' | 'endTurn'>

export function createRoutingDesk({ send, handlers, timeoutMs = BIND_WAIT_MS }: {
  send: (message: object) => void
  handlers: RoutingHandlers
  timeoutMs?: number
}) {
  const waiting = new Map<string, { resolve: () => void, reject: (error: Error) => void }>()

  /** Resolves once the plugin bound the session; rejects when it did not answer in time (the routing plugin is not loaded). */
  function bind(sessionId: string): Promise<void> {
    const id = randomUUID()
    return withOperation('task.route', () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        emitDiagnostic({ event: 'operation.progress', operation: 'task.route', stage: 'unavailable', reason: 'timeout', identities: { requestId: id, sessionId } })
        reject(new Error(t('main.routing-channel.not.bound')))
      }, timeoutMs)
      const settle = () => { clearTimeout(timer); waiting.delete(id) }
      waiting.set(id, { resolve: () => { settle(); resolve() }, reject: (error) => { settle(); reject(error) } })
      send({ type: 'routing_bind', version: 1, id, sessionId })
    }), { stage: 'connecting', identities: { requestId: id, sessionId } })
  }

  /** Binds an unattended data source session to verified read-only tools owned by `pluginName`. */
  function bindSource(sessionId: string, binding: { pluginName: string, ownerEntryIds: readonly string[], allowedTools: readonly string[] }): Promise<void> {
    const id = randomUUID()
    return withOperation('task.route', () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        emitDiagnostic({ event: 'operation.progress', operation: 'task.route', stage: 'unavailable', reason: 'timeout', identities: { requestId: id, sessionId } })
        reject(new Error(t('main.routing-channel.not.bound')))
      }, timeoutMs)
      const settle = () => { clearTimeout(timer); waiting.delete(id) }
      waiting.set(id, { resolve: () => { settle(); resolve() }, reject: (error) => { settle(); reject(error) } })
      send({
        type: 'routing_bind_source',
        version: 1,
        id,
        sessionId,
        pluginName: binding.pluginName,
        ownerEntryIds: [...binding.ownerEntryIds],
        allowedTools: [...binding.allowedTools],
      })
    }), { stage: 'connecting', identities: { requestId: id, sessionId } })
  }

  async function answer(id: string, decision: { requestId: string, sessionId: string, plan: unknown }) {
    let decided: Decided
    try {
      decided = await withOperation('task.route', () => handlers.decide(decision),
        { identities: { requestId: decision.requestId, sessionId: decision.sessionId } })
    } catch (error) {
      emitDiagnostic({ event: 'operation.progress', operation: 'task.route', stage: 'failed', reason: safeDiagnosticReason(error),
        identities: { requestId: decision.requestId, sessionId: decision.sessionId } })
      decided = { accepted: false, reason: t('main.routing-channel.not.taken') }
    }
    send({ type: 'routing_decided', version: 1, id, ...decided })
  }

  function receive(message: unknown) {
    const bound = asBound(message)
    if (bound) {
      const entry = waiting.get(bound.id)
      if (!entry) return
      if (bound.ok === false) entry.reject(new Error(bound.reason || t('main.routing-channel.not.bound')))
      else entry.resolve()
      return
    }
    const decide = asDecide(message)
    if (decide) { void answer(decide.id, { requestId: decide.requestId, sessionId: decide.sessionId, plan: decide.plan }); return }
    const fast = asFast(message)
    if (!fast) return
    try {
      withOperation('task.route', () => handlers.noteFast({ requestId: fast.requestId, sessionId: fast.sessionId, outcome: fast.outcome, reason: fast.reason, ms: fast.ms }),
        { stage: 'settled', identities: { requestId: fast.requestId, sessionId: fast.sessionId } })
    } catch (error) {
      emitDiagnostic({ event: 'operation.progress', operation: 'task.route', stage: 'failed', reason: safeDiagnosticReason(error),
        identities: { requestId: fast.requestId, sessionId: fast.sessionId } })
    }
  }

  /** dsh is going away: nothing will answer a bind. */
  function close() {
    for (const entry of [...waiting.values()]) entry.reject(new Error(t('main.routing-channel.not.bound')))
  }

  return { bind, bindSource, receive, close }
}

export type RoutingDesk = ReturnType<typeof createRoutingDesk>
