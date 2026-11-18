export type ModelCallStatus = 'running' | 'completed' | 'failed'

export interface ModelCallSummary {
  sessionId: string
  turn: number
  step: number
  at: number
  status: ModelCallStatus
  provider: string
  model: string
  attempts: number
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
}

export interface ModelRequest {
  provider: string
  model: string
  config: Readonly<Record<string, unknown>>
  messages: readonly unknown[]
  tools: readonly unknown[]
}

export interface ModelCallDetail {
  call: ModelCallSummary
  request: ModelRequest | null
}

export const modelCallId = (call: Pick<ModelCallSummary, 'sessionId' | 'turn' | 'step'>) => `${call.sessionId}:${call.turn}:${call.step}`
