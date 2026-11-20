export type ToolBudgetNotice = {
  type: 'viva_tool_budget'
  sessionId: string
  callId: string
  phase: 'prepare' | 'execute'
  remainingMs: number | null
}
