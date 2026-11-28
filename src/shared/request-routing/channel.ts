/**
 * The routing channel (version 1) between the app (src/backend/routing-channel.ts) and the viva-routing plugin, over
 * the IPC channel the app opened when it started dsh. One definition for both sides; whatever arrives is checked.
 *
 *   app → plugin   routing_bind      the session is the main conversation; narrow it before its first step
 *   plugin → app   routing_bound     done
 *   plugin → app   routing_decide    the agent committed a decision for a request; the app accepts or rejects it
 *   app → plugin   routing_decided   the app's answer: accepted, with what became of each action, or why not
 *   plugin → app   routing_fast      what the fast lane made of words said mid-turn, for the app's record
 */
import type { Receipt } from './protocol.ts'

export const ROUTING_CHANNEL_VERSION = 1

export type RoutingBind = { type: 'routing_bind', version: 1, id: string, sessionId: string }
export type RoutingBound = { type: 'routing_bound', version: 1, id: string }
export type RoutingDecide = { type: 'routing_decide', version: 1, id: string, sessionId: string, requestId: string, plan: unknown }
/** The app's answer to a decision: accepted, with what became of each action, or refused and why. */
export type Decided = { accepted: true, receipts: Receipt[] } | { accepted: false, reason: string }
export type RoutingDecided = { type: 'routing_decided', version: 1, id: string } & Decided
/**
 * The fast lane's outcome for an interjection: handed over; deferred to the main agent (`reason` a code: the model's
 * own choice, or what of its answer could not be used, or the app refusing it); too late (the main agent had read it
 * first); or failed (the call went wrong).
 */
export const FAST_OUTCOMES = ['handed', 'deferred', 'late', 'failed'] as const
export type FastOutcome = (typeof FAST_OUTCOMES)[number]
export type RoutingFast = { type: 'routing_fast', version: 1, sessionId: string, requestId: string, outcome: FastOutcome, reason: string | null, ms: number }

const MAX_ID_CHARS = 200
const MAX_REASON_CHARS = 2000
type Raw = Record<string, unknown>
const record = (value: unknown): Raw | null => (value && typeof value === 'object' ? value as Raw : null)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
const of = (value: unknown, type: string): Raw | null => {
  const message = record(value)
  return message?.type === type && message.version === ROUTING_CHANNEL_VERSION ? message : null
}

const ACTION_KINDS: ReadonlySet<unknown> = new Set(['reply', 'start', 'message', 'stop', 'clarify', 'app_action'])
function isReceipt(value: unknown): value is Receipt {
  const r = record(value)
  if (!r || !ACTION_KINDS.has(r.kind)) return false
  return r.ok === true ? r.taskId === undefined || id(r.taskId) : r.ok === false && typeof r.error === 'string'
}

export function asBind(value: unknown): RoutingBind | null {
  const m = of(value, 'routing_bind')
  return m && id(m.id) && id(m.sessionId) ? { type: 'routing_bind', version: 1, id: m.id, sessionId: m.sessionId } : null
}
export function asBound(value: unknown): RoutingBound | null {
  const m = of(value, 'routing_bound')
  return m && id(m.id) ? { type: 'routing_bound', version: 1, id: m.id } : null
}
export function asDecide(value: unknown): RoutingDecide | null {
  const m = of(value, 'routing_decide')
  return m && id(m.id) && id(m.sessionId) && id(m.requestId) ? { type: 'routing_decide', version: 1, id: m.id, sessionId: m.sessionId, requestId: m.requestId, plan: m.plan } : null
}
export function asDecided(value: unknown): RoutingDecided | null {
  const m = of(value, 'routing_decided')
  if (!m || !id(m.id)) return null
  if (m.accepted === true) return Array.isArray(m.receipts) && m.receipts.every(isReceipt) ? { type: 'routing_decided', version: 1, id: m.id, accepted: true, receipts: m.receipts } : null
  return m.accepted === false && typeof m.reason === 'string' ? { type: 'routing_decided', version: 1, id: m.id, accepted: false, reason: m.reason.slice(0, MAX_REASON_CHARS) } : null
}
const MAX_CODE_CHARS = 40
export function asFast(value: unknown): RoutingFast | null {
  const m = of(value, 'routing_fast')
  const outcome = FAST_OUTCOMES.find(known => known === m?.outcome)
  const reason = typeof m?.reason === 'string' ? m.reason.slice(0, MAX_CODE_CHARS) : null
  return m && id(m.sessionId) && id(m.requestId) && outcome && typeof m.ms === 'number' && Number.isFinite(m.ms) && m.ms >= 0
    ? { type: 'routing_fast', version: 1, sessionId: m.sessionId, requestId: m.requestId, outcome, reason, ms: Math.round(m.ms) } : null
}
