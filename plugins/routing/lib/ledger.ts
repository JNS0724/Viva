/**
 * The requests of the main agent's current turn and where each stands (docs/agent-routing-design.md §8). Pure and
 * immutable: each change returns a new ledger, so the plugin's hooks only choose transitions. It lives as long as the
 * turn: the host (src/backend/request-runtime.ts) is the authority on requests, and fails what a turn leaves undecided.
 *
 *   pending ──commit──▶ answering | asking | acting | handed
 *      │                (answering also when a handover failed and the agent must say so)
 *      ├──fast lane──▶ fast ──▶ handed | answering (accepted, an action not done) | pending (deferred, or it failed)
 *      └──reminders used up──▶ left
 */
export type RequestStatus = 'pending' | 'fast' | 'answering' | 'asking' | 'acting' | 'handed' | 'left'

export interface RequestEntry {
  readonly id: string
  readonly status: RequestStatus
  /** The step its decision was accepted at; text of later steps may show. -1 while undecided. */
  readonly decidedAt: number
  readonly repairs: number
}

export interface Ledger {
  readonly step: number
  readonly requests: Readonly<Record<string, RequestEntry>>
}

export const EMPTY_LEDGER: Ledger = Object.freeze({ step: 0, requests: Object.freeze({}) })

/** Statuses whose request still has something to show in this turn. */
const SPEAKING: ReadonlySet<RequestStatus> = new Set(['answering', 'asking', 'acting'])
const entries = (ledger: Ledger): RequestEntry[] => Object.values(ledger.requests)
const put = (ledger: Ledger, entry: RequestEntry): Ledger => Object.freeze({ ...ledger, requests: Object.freeze({ ...ledger.requests, [entry.id]: Object.freeze(entry) }) })

export const atStep = (ledger: Ledger, step: number): Ledger => Object.freeze({ ...ledger, step })

/** A request seen in the conversation; one already known (the fast lane took it first) stays as it is. */
export function register(ledger: Ledger, id: string): Ledger {
  return ledger.requests[id] ? ledger : put(ledger, { id, status: 'pending', decidedAt: -1, repairs: 0 })
}

/** The fast lane claims a request before the main agent has seen it; null when it is already known. */
export function claimFast(ledger: Ledger, id: string): Ledger | null {
  return ledger.requests[id] ? null : put(ledger, { id, status: 'fast', decidedAt: -1, repairs: 0 })
}

/**
 * The fast lane's outcome: the status its accepted plan gave the request (statusOfPlan, as for the agent's own commit),
 * or null when it was left to the main agent (deferred, refused, or the lane failed) and is pending again.
 */
export function settleFast(ledger: Ledger, id: string, decided: RequestStatus | null): Ledger {
  const entry = ledger.requests[id]
  if (entry?.status !== 'fast') return ledger
  return put(ledger, decided ? { ...entry, status: decided, decidedAt: ledger.step } : { ...entry, status: 'pending' })
}

/** Why the main agent may not commit for this request now, or null (the host checks the rest). */
export const decisionProblem = (ledger: Ledger, id: string): string | null =>
  ledger.requests[id]?.status === 'fast' ? `请求 ${id} 正由调度处理，不要重复提交` : null

/**
 * What an accepted plan makes of its request. A failed handover keeps it answering, so the agent says what was not
 * done; an app operation is acting until its tool call; a question asks; anything else is handed over.
 */
export function statusOfPlan(kinds: readonly string[], failed: boolean): RequestStatus {
  if (failed || kinds.includes('reply')) return 'answering'
  if (kinds.includes('app_action')) return 'acting'
  if (kinds.includes('clarify')) return 'asking'
  return 'handed'
}

/** A decision the host accepted; a request this turn has not seen (said before it was read) is taken as seen now. */
export function decide(ledger: Ledger, id: string, status: RequestStatus): Ledger {
  const entry = ledger.requests[id] ?? { id, status: 'pending', decidedAt: -1, repairs: 0 }
  return put(ledger, { ...entry, status, decidedAt: ledger.step })
}

/** Whether the turn has more to do: a request undecided, being decided by the fast lane, or still to speak. */
export const hasOpenWork = (ledger: Ledger): boolean => entries(ledger).some(e => e.status === 'pending' || e.status === 'fast' || SPEAKING.has(e.status))

/**
 * Whether text of a step may show. A turn with no request (a task's result coming back) speaks freely; otherwise some
 * request must have been given leave to speak before this step, and none may wait for its decision.
 */
export function mayShow(ledger: Ledger, step: number): boolean {
  const all = entries(ledger)
  if (!all.length) return true
  return all.some(e => SPEAKING.has(e.status) && e.decidedAt < step) && !all.some(e => e.status === 'pending')
}

/** At the end of a turn: requests to remind the agent of, and those that used up their reminders and are left. */
export function repairs(ledger: Ledger, max: number): { ledger: Ledger, retry: string[], left: string[] } {
  const pending = entries(ledger).filter(e => e.status === 'pending')
  const left = pending.filter(e => e.repairs >= max)
  const retry = pending.filter(e => e.repairs < max)
  const next = [...left.map(e => ({ ...e, status: 'left' as const })), ...retry.map(e => ({ ...e, repairs: e.repairs + 1 }))].reduce(put, ledger)
  return { ledger: next, retry: retry.map(e => e.id), left: left.map(e => e.id) }
}
