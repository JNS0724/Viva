import { randomUUID } from 'node:crypto'
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
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(t('main.routing-channel.not.bound'))) }, timeoutMs)
      const settle = () => { clearTimeout(timer); waiting.delete(id) }
      waiting.set(id, { resolve: () => { settle(); resolve() }, reject: (error) => { settle(); reject(error) } })
      send({ type: 'routing_bind', version: 1, id, sessionId })
    })
  }

  async function answer(id: string, decision: { requestId: string, sessionId: string, plan: unknown }) {
    let decided: Decided
    try {
      decided = await handlers.decide(decision)
    } catch (error) {
      console.error('[routing] a decision could not be taken:', error instanceof Error ? error.message : String(error))
      decided = { accepted: false, reason: t('main.routing-channel.not.taken') }
    }
    send({ type: 'routing_decided', version: 1, id, ...decided })
  }

  function receive(message: unknown) {
    const bound = asBound(message)
    if (bound) { waiting.get(bound.id)?.resolve(); return }
    const decide = asDecide(message)
    if (decide) { void answer(decide.id, { requestId: decide.requestId, sessionId: decide.sessionId, plan: decide.plan }); return }
    const fast = asFast(message)
    if (!fast) return
    try {
      handlers.noteFast({ requestId: fast.requestId, sessionId: fast.sessionId, outcome: fast.outcome, reason: fast.reason, ms: fast.ms })
    } catch (error) {
      console.error('[routing] a fast-lane outcome could not be kept:', error instanceof Error ? error.message : String(error))
    }
  }

  /** dsh is going away: nothing will answer a bind. */
  function close() {
    for (const entry of [...waiting.values()]) entry.reject(new Error(t('main.routing-channel.not.bound')))
  }

  return { bind, receive, close }
}

export type RoutingDesk = ReturnType<typeof createRoutingDesk>
