import type { AgentInfo } from './agent-info.ts'
import type { ConversationContext } from './conversation-context.ts'

export interface StreamMark { streamGeneration: string, eventCursor: number }
export interface HistorySaveMark extends StreamMark { context: ConversationContext }
export interface ConversationSnapshot {
  id: string, updatedAt: number, createdAt: number, parentId: string | null
  messages: readonly { role: string, text: string, receipt?: { ms: number, tools: number, thoughts: number, stopReason: string } | null,
    images?: readonly { id: string }[], key?: string, sourceId?: string, delivery?: 'pending' | 'not-sent' }[]
  records?: readonly unknown[]
  folds: readonly unknown[]
}
export interface RendererSnapshot {
  streamGeneration: string
  cutoverCursor: number
  context: ConversationContext
  info: AgentInfo
  history: ConversationSnapshot | null
  replay: readonly unknown[]
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
    && (event.originalCuts !== undefined || event.traceSessions !== undefined || event.erasedOutputs !== undefined || event.erasedFeedIds !== undefined)
}
