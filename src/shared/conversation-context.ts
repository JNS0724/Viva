/** Identity of a selected history segment and the runtime session that serves it. */
export interface ConversationContext { conversationId: string | null, sessionId: string | null }
export interface ConversationTurnTarget extends ConversationContext { sessionId: string, turnId: string }

/** The context gate interprets only routing metadata; the event decoder owns payload validation. */
export interface ContextEvent {
  type?: unknown
  taskId?: unknown
  sessionId?: unknown
  context?: unknown
}

const FOREGROUND = new Set([
  'config', 'update', 'turn_started', 'turn_stopping', 'turn_end', 'permission', 'question', 'question_answered', 'question_closed',
  'waits', 'secret_request', 'secret_closed', 'memory_context', 'schedule_propose', 'report_delivered', 'prompt_persisted',
])
export function contextOf(event: ContextEvent): ConversationContext | null {
  const value = event.context
  if (!value || typeof value !== 'object') return null
  const context = value as Record<string, unknown>
  if (context.conversationId !== null && typeof context.conversationId !== 'string') return null
  if (context.sessionId !== null && typeof context.sessionId !== 'string') return null
  return { conversationId: context.conversationId, sessionId: context.sessionId }
}
export const isConversationEvent = (event: ContextEvent): boolean => typeof event.taskId !== 'string'
  && (FOREGROUND.has(String(event.type)) || (event.type === 'error' && contextOf(event) !== null))

/** Only config is session-wide; content/waits never use a missing segment id as a wildcard. */
export function belongsTo(event: ContextEvent, target: ConversationContext): boolean {
  const origin = contextOf(event)
  if (!origin || !origin.sessionId || origin.sessionId !== target.sessionId) return false
  return origin.conversationId !== null ? origin.conversationId === target.conversationId : event.type === 'config'
}

export const sameContext = (a: ConversationContext, b: ConversationContext): boolean => a.sessionId === b.sessionId && a.conversationId === b.conversationId
