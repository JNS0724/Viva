import type { ScheduleProposal } from './proposal-types.ts'
import type { ConversationContext } from '../shared/conversation-context.ts'
import type { WindowSnapshot } from '../shared/ipc-results.ts'
import type { ConversationPayloads, ForegroundWaits } from './conversation-types.ts'

interface Scoped { context: ConversationContext, taskId?: never, runId?: never, taskSeq?: never }
interface Position { taskId: string, runId: string, taskSeq: number, context?: never }
type Payload<K extends keyof ConversationPayloads> = Omit<ConversationPayloads[K], 'at'>
export type AgentEvent =
  | { type: 'ready' | 'workdir', info: AgentInfo }
  | { type: 'config', info: AgentInfo, context?: ConversationContext }
  /** How the MCP servers stand, as viva-mcp says it changed: only the agent info's `mcp`. */
  | { type: 'mcp_status', mcp: NonNullable<AgentInfo['mcp']> }
  | ({ type: 'update' } & Scoped & Payload<'acp_update'>)
  | ({ type: 'turn_started', by?: string | null } & Scoped)
  | ({ type: 'turn_end' } & Scoped & Payload<'turn_end'>)
  | ({ type: 'permission' } & Payload<'permission_request'> & (Scoped | Position))
  | ({ type: 'question' } & Scoped & Payload<'question_request'>)
  | ({ type: 'question_closed' } & Scoped & Payload<'question_closed'>)
  | ({ type: 'secret_request' } & Scoped & Payload<'secret_request'>)
  | ({ type: 'secret_closed' } & Scoped & Payload<'secret_closed'>)
  | ({ type: 'waits' } & Scoped & ForegroundWaits)
  | ({ type: 'memory_context' } & Scoped & Payload<'memory_context'>)
  | ({ type: 'report_delivered' } & Scoped & ConversationPayloads['report_delivered'])
  | ({ type: 'error', message: string, context?: ConversationContext })
  | ({ type: 'schedule_propose', proposal: ScheduleProposal } & Scoped)
  | { type: 'memory_changed', memories?: readonly string[], invalidated?: readonly string[] }
  | { type: 'files_changed', path: string }
  | { type: 'feed_changed' | 'schedules_changed' | 'sources_changed' }
  | { type: 'task_snapshot', snapshot: WindowSnapshot }
  | ({ type: 'task_update' } & Position & Payload<'acp_update'>)
  | ({ type: 'task_permission_closed' } & Position & Payload<'permission_closed'>)
  | ({ type: 'task_question' } & Position & Payload<'question_request'>)
  | ({ type: 'task_question_closed' } & Position & Payload<'question_closed'>)
  | ({ type: 'task_steered', text: string } & Position)
  | ({ type: 'task_end', stopReason?: string, message?: string | null } & Position)
