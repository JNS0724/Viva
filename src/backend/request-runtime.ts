import { randomUUID } from 'node:crypto'
import { isTaskAction, parsePlan, type Receipt, type TaskAction } from '../shared/request-routing/protocol.ts'
import type { Decided, FastOutcome } from '../shared/request-routing/channel.ts'
import type { Apply } from './journal.ts'
import type { RequestKind, RequestStore, StoredRequest } from './request-store.ts'

/**
 * The host's side of request routing (docs/agent-routing-design.md §3, §11): the authority on every request of the
 * main conversation. It gives each one its id as it arrives, accepts a decision for it only through the protocol
 * (src/shared/request-routing/protocol.ts), and carries out the decision's task actions after the decision commits,
 * keeping a receipt for each. Every change goes through the event core with its event, which records ids and kinds,
 * never what the user or the model wrote.
 */

/**
 * Why a request got no decision: its turn ended without one (the agent left it, reminders used up), ended in an error,
 * or was cancelled; words said mid-turn reached no turn (the window asks them anew, as a request of their own); or
 * the app stopped.
 */
export type RequestFailure = 'unrouted' | 'turn_error' | 'cancelled' | 'undelivered' | 'interrupted'

/** Where a request was said: its conversation and working folder, as kept when it arrived. */
export interface RequestPlace { conversationId: string | null, cwd: string | null }

/**
 * The task runtime as the decisions use it (compose.ts): a task starts from the request's conversation, and only tasks
 * of the request's working folder are touched.
 */
export interface RequestTasks {
  start: (brief: string, place: RequestPlace) => Promise<{ taskId: string }>
  message: (taskId: string, text: string, cwd: string | null) => Promise<unknown>
  stop: (taskId: string, cwd: string | null) => Promise<unknown>
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const NOT_SENT = '本轮已结束，这一步没有执行'

export function createRequestRuntime({ store, apply, tasks, now = Date.now, newId = () => `r-${randomUUID()}` }: {
  store: RequestStore
  apply: Apply
  tasks: RequestTasks
  now?: () => number
  newId?: () => string
}) {
  /**
   * Decisions being carried out, each with its session; and those whose turn ended meanwhile (stopped, say), which
   * send nothing more: the action under way finishes, the rest fail as not sent.
   */
  const carrying = new Map<string, string>()
  const halted = new Set<string>()

  /** A request of the main conversation, as it arrives; its id goes into the header the agent reads it under. */
  function receive({ sessionId, conversationId, cwd, kind }: { sessionId: string, conversationId: string | null, cwd: string | null, kind: RequestKind }): string {
    const id = newId()
    apply('request.received', { requestId: id, kind }, () => store.add({ id, sessionId, conversationId, cwd, kind, at: now() }))
    return id
  }

  /** Why this session may not decide that request now, or null. */
  function refusal(request: StoredRequest | null, requestId: string, sessionId: string): string | null {
    if (!request || request.sessionId !== sessionId) return `没有待处理的请求 ${requestId}；只能处理系统给出的【请求 ID】`
    if (request.status === 'decided') return `请求 ${requestId} 已经提交过决策，不能再改；用户的纠正会作为新请求送来`
    if (request.status === 'failed') return `请求 ${requestId} 已经结束，不能再提交`
    return null
  }

  async function perform(request: StoredRequest, action: TaskAction): Promise<Receipt> {
    try {
      if (action.kind === 'start') return { kind: 'start', ok: true, taskId: (await tasks.start(action.brief, { conversationId: request.conversationId, cwd: request.cwd })).taskId }
      if (action.kind === 'message') await tasks.message(action.taskId, action.text, request.cwd)
      else await tasks.stop(action.taskId, request.cwd)
      return { kind: action.kind, ok: true, taskId: action.taskId }
    } catch (error) {
      return { kind: action.kind, ok: false, error: errorText(error) }
    }
  }

  /**
   * The agent's decision for a request: accepted in one transaction with a row for each action, then its task actions
   * carried out in order, each receipt kept. A receipt that cannot be kept leaves its action pending, so the next launch
   * marks it uncertain instead of doing it again.
   */
  async function decide({ requestId, sessionId, plan: raw }: { requestId: string, sessionId: string, plan: unknown }): Promise<Decided> {
    const request = store.get(requestId)
    const refused = refusal(request, requestId, sessionId)
    if (refused || !request) return { accepted: false, reason: refused ?? '' }
    const parsed = parsePlan(raw)
    if ('problem' in parsed) return { accepted: false, reason: parsed.problem }
    const { plan } = parsed
    const accepted = apply('request.decided', { requestId, actions: plan.actions.map(action => action.kind) }, () => store.decide(requestId, plan, now())).value
    if (!accepted) return { accepted: false, reason: refusal(store.get(requestId), requestId, sessionId) ?? `请求 ${requestId} 不能再提交` }
    carrying.set(requestId, sessionId)
    try {
      const receipts: Receipt[] = []
      for (const [idx, action] of plan.actions.entries()) {
        if (!isTaskAction(action)) { receipts.push({ kind: action.kind, ok: true }); continue }
        const receipt: Receipt = halted.has(requestId) ? { kind: action.kind, ok: false, error: NOT_SENT } : await perform(request, action)
        receipts.push(receipt)
        try {
          apply('request.acted', { requestId, idx, kind: action.kind, ok: receipt.ok }, () => store.settle(requestId, idx, receipt, now()))
        } catch (error) {
          console.error('[requests] could not keep what became of an action; it stays unsettled:', errorText(error))
        }
      }
      return { accepted: true, receipts }
    } finally {
      carrying.delete(requestId)
      halted.delete(requestId)
    }
  }

  /** A request that got no decision; false when it was decided or ended already, or is not this session's. */
  function fail({ requestId, sessionId, reason }: { requestId: string, sessionId: string, reason: RequestFailure }): boolean {
    if (store.get(requestId)?.sessionId !== sessionId) return false
    return apply('request.failed', { requestId, reason }, () => store.fail(requestId, reason, now())).value
  }

  /**
   * A turn of the main conversation ended: what it left undecided fails, for the reason the turn ended, and is said
   * back; nothing is decided after its turn, and a decision still being carried out sends nothing more.
   */
  function endTurn({ sessionId, reason }: { sessionId: string, reason: Exclude<RequestFailure, 'undelivered' | 'interrupted'> }): string[] {
    for (const [requestId, owner] of carrying) if (owner === sessionId) halted.add(requestId)
    return store.undecided(sessionId).filter(requestId => apply('request.failed', { requestId, reason }, () => store.fail(requestId, reason, now())).value)
  }

  /**
   * What the fast lane made of an interjection (plugins/routing/lib/fast-lane.ts), kept as an event for the record:
   * the outcome, a reason code and how long it took, never the words. Not this session's request: nothing kept.
   */
  function noteFast({ requestId, sessionId, outcome, reason, ms }: { requestId: string, sessionId: string, outcome: FastOutcome, reason: string | null, ms: number }): boolean {
    if (store.get(requestId)?.sessionId !== sessionId) return false
    apply('request.fast', { requestId, outcome, reason, ms }, () => undefined)
    return true
  }

  /**
   * At launch: requests the last run left undecided fail (their turn is gone), and task actions it left without a
   * receipt become uncertain; neither is done again.
   */
  function recover(): { failed: number, uncertain: number } {
    const undecided = store.undecided()
    for (const requestId of undecided) apply('request.failed', { requestId, reason: 'interrupted' }, () => store.fail(requestId, 'interrupted', now()))
    const unsettled = store.unsettled()
    if (unsettled) apply('request.uncertain', { actions: unsettled }, () => store.markUncertain(now()))
    return { failed: undecided.length, uncertain: unsettled }
  }

  return { receive, decide, fail, endTurn, noteFast, recover }
}

export type RequestRuntime = ReturnType<typeof createRequestRuntime>
