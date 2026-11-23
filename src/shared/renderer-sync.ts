import type { AgentInfo } from './agent-info.ts'
import type { ConversationContext } from './conversation-context.ts'

/**
 * Maximum trailing messages included in a conversation snapshot, tail history load, or rendered `#thread`.
 * Matches `view/thread.ts` `THREAD_MAX` and `test/smoke/smoke-perf.ts` (`BUDGET.drawn`): `#thread` only renders and
 * offers rewind for the trailing 200 messages; earlier messages in the segment are read in 回顾 (`history:read`) via
 * `.thread-rest` rather than paginated back into `#thread` (see `timeline-search.ts`).
 */
export const CONVERSATION_WINDOW_MESSAGES = 200
export type MemoryAvailability = 'starting' | 'recovering' | 'ready' | 'unavailable'
export const MEMORY_AVAILABILITIES = Object.freeze(['starting', 'recovering', 'ready', 'unavailable'] as const)
export const isMemoryAvailability = (value: unknown): value is MemoryAvailability =>
  typeof value === 'string' && (MEMORY_AVAILABILITIES as readonly string[]).includes(value)

export interface StreamMark { streamGeneration: string, eventCursor: number }
export interface ConversationSnapshot {
  id: string, updatedAt: number, createdAt: number, parentId: string | null
  messages: readonly { role: string, text: string, receipt?: { ms: number, tools: number, thoughts: number, stopReason: string } | null,
    images?: readonly { id: string }[], key?: string, sourceId?: string, delivery?: 'pending' | 'not-sent' }[]
  /** Number of persisted messages in this segment before `messages[0]`. */
  offset?: number
  /** Total persisted messages in this segment (`offset + messages.length`). */
  total?: number
  records?: readonly unknown[]
  folds: readonly unknown[]
}
export type ActiveTurnSnapshot = { id: string, by: string, startedAt: number, stopping: boolean }
export interface RendererSnapshot {
  streamGeneration: string
  cutoverCursor: number
  context: ConversationContext
  info: AgentInfo
  activeTurn?: ActiveTurnSnapshot | null
  stoppedReplayLost?: boolean
  stopUnconfirmed?: boolean
  history: ConversationSnapshot | null
  replay: readonly unknown[]
  memoryAvailability?: MemoryAvailability
}
export function streamMark(value: unknown): StreamMark | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  return typeof item.streamGeneration === 'string' && item.streamGeneration.length > 0 && item.streamGeneration.length <= 128
    && typeof item.eventCursor === 'number' && Number.isSafeInteger(item.eventCursor) && item.eventCursor >= 0
    ? { streamGeneration: item.streamGeneration, eventCursor: item.eventCursor } : null
}

/** These committed invalidations can make an earlier conversation snapshot unsafe to install or replay. */
export function invalidatesConversationSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return event.type === 'reports_removed' || event.type === 'memory_changed'
    && (event.traceSessions !== undefined || event.erasedOutputs !== undefined || event.erasedFeedIds !== undefined)
}
