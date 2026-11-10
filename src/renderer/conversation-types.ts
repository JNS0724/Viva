import type { SessionUpdate, ContentBlock } from '@agentclientprotocol/sdk'
import type { QuestionAnswer } from '../shared/question-answer.ts'

export interface StreamBlock { index: number, text: string }
export interface StreamText { id: string, text: string, open?: boolean, at?: number, streamKey?: string, streamBlocks?: readonly StreamBlock[] }
export interface TurnReceipt { ms: number, stopReason?: string, tools?: number, thoughts?: number }
export interface ConversationMessage extends StreamText {
  role: string
  shown?: number
  receipt?: TurnReceipt | null
  restored?: boolean
  images?: readonly { id: string }[]
  via?: string | null
  steered?: boolean
  failed?: boolean
  asked?: string
  taskId?: string
  cardsAfter?: readonly string[]
}
export interface ConversationTool {
  id?: string
  title: string
  kind?: string
  status?: string
  rawInput?: unknown
  locations?: readonly { path: string, line?: number | null }[]
  at?: number
}
export type DoneNotice = 'fresh' | 'still' | 'seen'
export interface MemoryInjection { at: number, fixed?: string | null, pushed?: readonly { names: string[], text: string }[] }
interface TraceBase { ref: string, at: number }
export type ConversationTrace = TraceBase & (
  | { kind: 'thought' } | { kind: 'tool' }
  | { kind: 'permission', title: string } | { kind: 'question', title: string } | { kind: 'secret', title: string }
  | { kind: 'decision', title: string, allowed: boolean, choice: string }
  | { kind: 'answer', title: string, answered: boolean }
  | { kind: 'secret_answer', title: string, provided: boolean }
  | { kind: 'memory', injection: MemoryInjection }
)
export interface AskedQuestion { questionId: string, questions: readonly QuestionItem[], picks: Readonly<Record<string, readonly string[]>> }
export interface AskedPermission { requestId: string, title: string, kind: string, toolCallId: string | null, rawInput: unknown, options: readonly PermissionOption[] }
export interface AskedSecret { requestId: string, server: string, names: readonly string[] }
export interface ConversationState {
  phase: 'idle' | 'working' | 'waiting' | 'asking' | 'error'
  messages: readonly ConversationMessage[]
  thoughts: readonly StreamText[]
  tools: Readonly<Record<string, ConversationTool>>
  timeline: readonly ConversationTrace[]
  permission: AskedPermission | null
  question: AskedQuestion | null
  secret: AskedSecret | null
  turn: { startedAt: number, tools: number, thoughts: number, by?: string, messageCount?: number } | null
  lastReceipt: TurnReceipt | null
  /**
   * Whether the last turn's 已完成 is still news (done-notice-actions.ts): fresh as it ends, still once her done pose
   * has played a while unwatched, seen once the user has looked (then the island and she are at rest, 待命).
   */
  doneNotice: DoneNotice
  /** Runtime timing of the last completed turn, used to distinguish pending background results from older tasks. */
  completedTurn: { startedAt: number, endedAt: number } | null
  error: string | null
  usage: { used: number, size: number } | null
}
export type VivaStreamUpdate = { sessionUpdate: 'viva_stream', key: string } & (
  | { kind: 'delta' | 'block', index: number, blockType: 'text' | 'reasoning', text: string }
  | { kind: 'settle', blocks: readonly { type: string, text?: string }[], before?: { text?: string, reasoning?: string } }
)
type ChunkKind = 'agent_message_chunk' | 'agent_thought_chunk'
type ToolKind = 'tool_call' | 'tool_call_update'
/** View projection of ACP: ignored variants retain only their tag, never opaque payloads. */
export type ConversationUpdate = VivaStreamUpdate
  | { [K in ChunkKind]: { sessionUpdate: K, content: { type: 'text', text: string } | { type: Exclude<ContentBlock['type'], 'text'> } } }[ChunkKind]
  | { [K in ToolKind]: { sessionUpdate: K, toolCallId: string, title?: string | null, kind?: string | null, status?: string | null, locations?: readonly { path: string, line?: number | null }[] | null, rawInput?: unknown } }[ToolKind]
  | { sessionUpdate: 'usage_update', used: number, size: number }
  | { [K in Exclude<SessionUpdate['sessionUpdate'], ChunkKind | ToolKind | 'usage_update'>]: { sessionUpdate: K } }[Exclude<SessionUpdate['sessionUpdate'], ChunkKind | ToolKind | 'usage_update'>]
export interface PermissionRequest { requestId: string, toolCall: { toolCallId?: string, title?: string | null, kind?: string | null, rawInput?: unknown }, options: readonly PermissionOption[] }
export interface ForegroundWaits {
  permissions: readonly PermissionRequest[]
  questions: readonly { questionId: string, questions: readonly QuestionItem[] }[]
  secrets: readonly AskedSecret[]
}

/** Only conversation payloads. Task identity and stream order belong to separate task actions. */
export interface ConversationPayloads {
  user_prompt: { text: string, at: number, via?: string | null, images?: readonly { id: string }[] }
  user_steer: { text: string, via?: string | null }
  steer_failed: { id: string | undefined }
  steer_resent: { at: number }
  agent_turn_started: { at: number, by?: string | null }
  acp_update: { update: ConversationUpdate, at: number }
  permission_request: PermissionRequest & { at: number }
  permission_resolved: { requestId: string, optionId: string | null, at: number }
  permission_closed: { requestId: string, at?: number }
  question_request: { questionId: string, questions: readonly QuestionItem[], at: number }
  question_pick: { id: string, label: string }
  question_answered: { questionId: string, answers: readonly QuestionAnswer[], at: number }
  question_closed: { questionId: string, at: number }
  secret_request: AskedSecret & { at: number }
  secret_resolved: { requestId: string, provided: boolean, at: number }
  secret_closed: { requestId: string }
  waits_restored: Partial<ForegroundWaits> & { at: number }
  turn_end: { stopReason?: string, finalReply?: boolean, at: number }
  done_still: {}
  done_seen: {}
  error: { message: string }
  memory_context: { injected: readonly MemoryInjection[] }
  report_delivered: { conversationId: string | null, sessionId: string | null, reportId: string, text: string, at: number }
}
export type ConversationAction = { [K in keyof ConversationPayloads]: { type: K } & ConversationPayloads[K] }[keyof ConversationPayloads]
export type ConversationHandlers = { [K in keyof ConversationPayloads]?: (view: ConversationState, action: ConversationPayloads[K] & { type?: K }) => ConversationState }
