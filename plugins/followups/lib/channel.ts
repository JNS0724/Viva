/**
 * The followups contract (version 1) between this plugin, inside dsh, and the app that started dsh, over Node's
 * IPC channel (`process.send` / `process.on('message')`); the app keeps the same shapes in
 * src/main/followup-channel.ts.
 *
 *   plugin → app  { type: 'followup_propose', id, sessionId, proposal }   the model suggests a follow-up; the
 *                                                                          user decides on a card in the window
 *   app → plugin  { type: 'prepare', id, provider, model, system, input, maxTokens }
 *                                                                          one model call with no tools at all
 *   app → plugin  { type: 'prepare_cancel', id }                           the user came back: stop it
 *   plugin → app  { type: 'prepare_result', id, ok, text }                 the text, or why there is none
 */
export const MAX_INPUT_CHARS = 120_000
export const MAX_SYSTEM_CHARS = 8_000
export const MAX_TOKENS = 4_000
const MAX_ID_CHARS = 100
const MAX_ROUTE_CHARS = 200

/** A follow-up as the model proposes it: the app checks every field again before showing the card. */
export interface Proposal { title: string, ask: string, remindAt?: string, prepareBy?: string, files?: string[], watchFile?: string }

export interface PrepareRequest { id: string, provider: string, model: string, system: string, input: string, maxTokens: number, requireComplete?: boolean }

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/** A prepare request from the app, checked; null when it is not one. */
export function prepareRequest(message: any): PrepareRequest | null {
  if (message?.type !== 'prepare') return null
  const { id, provider, model, system, input, maxTokens, requireComplete } = message
  if (!text(id, MAX_ID_CHARS) || !text(provider, MAX_ROUTE_CHARS) || !text(model, MAX_ROUTE_CHARS)) return null
  if (!text(system, MAX_SYSTEM_CHARS) || !text(input, MAX_INPUT_CHARS)) return null
  if (requireComplete !== undefined && typeof requireComplete !== 'boolean') return null
  const tokens = Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, MAX_TOKENS) : MAX_TOKENS
  return { id, provider, model, system, input, maxTokens: tokens, ...(requireComplete ? { requireComplete: true } : {}) }
}
