import type { AgentEvent } from './agent-event-types.ts'
export type { AgentEvent as EventEnvelope } from './agent-event-types.ts'

/** Exhaustive conversion of validated pushes. Receive time survives selection buffering. */
export function createEventActions({ now = Date.now }: { now?: () => number } = {}) {
  return (event: AgentEvent, at = now()): Action | null => {
    switch (event.type) {
      case 'ready': return { type: 'ready', info: event.info }
      case 'workdir': return { type: 'workdir_switched', info: event.info }
      case 'config': return { type: 'config_applied', info: event.info }
      case 'mcp_status': return { type: 'config_applied', info: { mcp: event.mcp } }
      case 'update': return { type: 'acp_update', update: event.update, at }
      case 'turn_started': return { type: 'agent_turn_started', by: event.by ?? null, at }
      case 'permission': return event.taskId !== undefined
        ? { type: 'task_permission_request', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, requestId: event.requestId, toolCall: event.toolCall, options: event.options, at }
        : { type: 'permission_request', requestId: event.requestId, toolCall: event.toolCall, options: event.options, at }
      case 'task_update': return { type: 'task_update', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, update: event.update, at }
      case 'task_snapshot': return { type: 'task_snapshot', snapshot: event.snapshot }
      case 'task_permission_closed': return { type: 'task_permission_closed', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, requestId: event.requestId, at }
      case 'report_delivered': return { type: 'report_delivered', conversationId: event.conversationId, sessionId: event.sessionId, reportId: event.reportId, text: event.text, at: event.at }
      case 'task_end': return { type: 'task_end', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, stopReason: event.stopReason, message: event.message ?? null, at }
      case 'task_question': return { type: 'task_question', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, questionId: event.questionId, questions: event.questions, at }
      case 'task_question_closed': return { type: 'task_question_closed', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, questionId: event.questionId, at }
      case 'task_steered': return { type: 'task_steer', taskId: event.taskId, runId: event.runId, seq: event.taskSeq, text: event.text, at }
      case 'question': return { type: 'question_request', questionId: event.questionId, questions: event.questions, at }
      case 'question_closed': return { type: 'question_closed', questionId: event.questionId, at }
      case 'waits': return { type: 'waits_restored', permissions: event.permissions, questions: event.questions, secrets: event.secrets, at }
      case 'secret_request': return { type: 'secret_request', requestId: event.requestId, server: event.server, names: event.names, at }
      case 'secret_closed': return { type: 'secret_closed', requestId: event.requestId }
      case 'turn_end': return { type: 'turn_end', stopReason: event.stopReason, ...(event.finalReply === undefined ? {} : { finalReply: event.finalReply }), at }
      case 'memory_context': return { type: 'memory_context', injected: event.injected }
      case 'error': return { type: 'error', message: event.message }
      case 'schedule_propose': return { type: 'schedule_proposed', proposal: event.proposal }
      case 'memory_changed': case 'files_changed': case 'feed_changed': case 'schedules_changed': case 'sources_changed': return null
      default: { const exhaustive: never = event; return exhaustive }
    }
  }
}
