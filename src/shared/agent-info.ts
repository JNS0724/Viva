/** Plain session metadata consumed by the page and returned by conversation IPC. */
export interface AgentInfo {
  mode: string, model: string, cwd: string
  sessionId?: string | null
  conversationId?: string
  /** Stable across the continuation segments of one topic. */
  topicId?: string
  reason?: string, problem?: string, remembersHistory?: boolean
  modelValue?: string, effort?: string
  models?: readonly { value: string, name: string, group?: string }[]
  efforts?: readonly { value: string, name: string }[]
  mcp?: { active: readonly string[], dropped: readonly { name: string, reason: string }[] }
}
export interface SteerResult { ok: boolean, reason?: string }
