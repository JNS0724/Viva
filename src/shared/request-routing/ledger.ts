/**
 * The request ledger of one main session: every request the main agent is given, where it stands, and what may
 * follow. Pure and immutable: each change returns a new ledger, so the plugin's hooks only choose transitions.
 *
 *   pending ──commit──▶ answering | asking | acting | handed
 *      │                (answering also when a handover failed and the agent must say so)
 *      ├──fast lane──▶ fast ──▶ handed | pending (deferred or failed)
 *      └──repairs used up, or the turn ended in an error──▶ failed
 *   at the next turn: answering, acting ──▶ done;  asking ──▶ awaiting (the user's answer comes as a new request)
 */
export type RequestStatus = 'pending' | 'fast' | 'answering' | 'asking' | 'acting' | 'handed' | 'awaiting' | 'done' | 'failed'

export interface RequestEntry {
  readonly id: string
  readonly status: RequestStatus
  /** The step its decision was accepted at; text of later steps may show. -1 while undecided. */
  readonly decidedAt: number
  readonly repairs: number
  readonly interjection: boolean
}

export interface Ledger {
  readonly turn: number
  readonly step: number
  readonly requests: Readonly<Record<string, RequestEntry>>
}

export const EMPTY_LEDGER: Ledger = Object.freeze({ turn: 0, step: 0, requests: Object.freeze({}) })

/** Statuses whose request still has something to show in this turn. */
const SPEAKING: ReadonlySet<RequestStatus> = new Set(['answering', 'asking', 'acting'])
const entries = (ledger: Ledger): RequestEntry[] => Object.values(ledger.requests)
const put = (ledger: Ledger, entry: RequestEntry): Ledger => ({ ...ledger, requests: Object.freeze({ ...ledger.requests, [entry.id]: Object.freeze(entry) }) })

/**
 * Where the agent is. A new turn closes what the last one said: an answer or app operation is done, a question
 * awaits its answer; so leave to speak never carries into a later turn.
 */
export function atStep(ledger: Ledger, turn: number, step: number): Ledger {
  if (turn === ledger.turn) return { ...ledger, step }
  const closed = entries(ledger).filter(e => SPEAKING.has(e.status)).map(e => ({ ...e, status: e.status === 'asking' ? 'awaiting' as const : 'done' as const }))
  return { ...closed.reduce(put, ledger), turn, step }
}

/** A request seen in the conversation; one already known (the fast lane took it first) stays as it is. */
export function register(ledger: Ledger, id: string, interjection: boolean): Ledger {
  if (ledger.requests[id]) return ledger
  return put(ledger, { id, status: 'pending', decidedAt: -1, repairs: 0, interjection })
}

/** The fast lane claims a request before the main agent has seen it; null when it is already known. */
export function claimFast(ledger: Ledger, id: string): Ledger | null {
  if (ledger.requests[id]) return null
  return put(ledger, { id, status: 'fast', decidedAt: -1, repairs: 0, interjection: true })
}

/** The fast lane's outcome: handed over, or left to the main agent (deferred, or it failed). */
export function settleFast(ledger: Ledger, id: string, handed: boolean): Ledger {
  const entry = ledger.requests[id]
  if (entry?.status !== 'fast') return ledger
  return put(ledger, handed ? { ...entry, status: 'handed', decidedAt: ledger.step } : { ...entry, status: 'pending' })
}

/** Why the main agent may not decide this request now, or null. */
export function decisionProblem(ledger: Ledger, id: string): string | null {
  const entry = ledger.requests[id]
  if (!entry) return `没有待处理的请求 ${id}；只能处理系统给出的【请求 ID】`
  if (entry.status === 'fast') return `请求 ${id} 正由调度处理，不要重复提交`
  if (entry.status !== 'pending') return `请求 ${id} 已经提交过决策，不能再改；用户的纠正会作为新请求送来`
  return null
}

/**
 * What a committed plan makes of its request. A failed handover keeps it answering, so the agent says what was not
 * done; an app operation is acting until its tool call; a question asks; anything else is handed over.
 */
export function statusOfPlan(kinds: readonly string[], failed: boolean): RequestStatus {
  if (failed || kinds.includes('reply')) return 'answering'
  if (kinds.includes('app_action')) return 'acting'
  if (kinds.includes('clarify')) return 'asking'
  return 'handed'
}

export function decide(ledger: Ledger, id: string, status: RequestStatus): Ledger {
  const entry = ledger.requests[id]
  return entry ? put(ledger, { ...entry, status, decidedAt: ledger.step }) : ledger
}

/** Whether the turn has more to do: a request undecided, being decided by the fast lane, or still to speak. */
export const hasOpenWork = (ledger: Ledger): boolean => entries(ledger).some(e => e.status === 'pending' || e.status === 'fast' || SPEAKING.has(e.status))

/** Text of a step may show once some request was given leave to speak before it, and none waits for a decision. */
export function mayShow(ledger: Ledger, step: number): boolean {
  const all = entries(ledger)
  return all.some(e => SPEAKING.has(e.status) && e.decidedAt < step) && !all.some(e => e.status === 'pending')
}

/** At the end of a turn: requests to remind the agent of, and those that used up their reminders and fail. */
export function repairs(ledger: Ledger, max: number): { ledger: Ledger, retry: string[], failed: string[] } {
  const pending = entries(ledger).filter(e => e.status === 'pending')
  const failed = pending.filter(e => e.repairs >= max)
  const retry = pending.filter(e => e.repairs < max)
  const next = [...failed.map(e => ({ ...e, status: 'failed' as const })), ...retry.map(e => ({ ...e, repairs: e.repairs + 1 }))].reduce(put, ledger)
  return { ledger: next, retry: retry.map(e => e.id), failed: failed.map(e => e.id) }
}

/** A turn that ended in an error routes nothing more: its undecided requests fail, so none is left silently. */
export function failUndecided(ledger: Ledger): { ledger: Ledger, failed: string[] } {
  const undecided = entries(ledger).filter(e => e.status === 'pending' || e.status === 'fast')
  return { ledger: undecided.map(e => ({ ...e, status: 'failed' as const })).reduce(put, ledger), failed: undecided.map(e => e.id) }
}
