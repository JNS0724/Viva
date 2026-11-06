import type { ContextEvent } from '../shared/conversation-context.ts'

/** Routing metadata and opaque payload; validation is independent of the conversation context queue. */
export interface EventEnvelope extends ContextEvent { type?: string, [field: string]: unknown }

export function createEventActions({ now = Date.now }: { now?: () => number } = {}) {
  /**
   * A piece of a task's stream, where it is in it (task-runtime.ts): its run and number (`taskSeq`; the push's own
   * `seq` is the event core's), for the window to take it once.
   */
  const streamPlace = (event: EventEnvelope) => (typeof event.taskSeq === 'number' && typeof event.runId === 'string' ? { runId: event.runId, seq: event.taskSeq } : {})

  const EVENT_ACTIONS: Readonly<Record<string, (event: EventEnvelope, at: number) => Action>> = {
    ready: (event, at) => ({ type: 'ready', info: event.info }),
    config: (event, at) => ({ type: 'config_applied', info: event.info }),
    update: (event, at) => ({ type: 'acp_update', update: event.update, at }),
    /** A turn the app started (a background task's result coming back): no words of the user's. */
    turn_started: (event, at) => ({ type: 'agent_turn_started', by: event.by ?? null, at }),
    permission: (event, at) => ({
      type: 'permission_request', requestId: event.requestId, taskId: event.taskId, toolCall: event.toolCall, options: event.options, at, ...streamPlace(event),
    }),
    /** What a background task says, asks and how it ends (tasks-state.ts), each with its place in the task's stream. */
    task_update: (event, at) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at, ...streamPlace(event) }),
    task_snapshot: (event, at) => ({ type: 'task_snapshot', snapshot: event.snapshot }),
    task_permission_closed: (event, at) => ({ type: 'task_permission_closed', taskId: event.taskId, requestId: event.requestId, at, ...streamPlace(event) }),
    /** A background task's result the model read (report-records.ts): its record in the conversation, where it came. */
    report_delivered: (event, at) => ({ type: 'report_delivered', conversationId: event.conversationId, sessionId: event.sessionId, reportId: event.reportId, text: event.text, at: event.at }),
    task_end: (event, at) => ({ type: 'task_end', taskId: event.taskId, stopReason: event.stopReason, message: event.message ?? null, at, ...streamPlace(event) }),
    task_question: (event, at) => ({ type: 'task_question', taskId: event.taskId, questionId: event.questionId, questions: event.questions, at, ...streamPlace(event) }),
    task_question_closed: (event, at) => ({ type: 'task_question_closed', taskId: event.taskId, questionId: event.questionId, at, ...streamPlace(event) }),
    /**
     * What the agent said into a task's turn (viva-tasks), a piece of its stream like what the task says. A task it
     * starts, asks again or takes up comes by the snapshot that begins the run (task_snapshot), before what the run says.
     */
    task_steered: (event, at) => ({ type: 'task_steer', taskId: event.taskId, text: event.text, at, ...streamPlace(event) }),
    question: (event, at) => ({ type: 'question_request', questionId: event.questionId, questions: event.questions, at }),
    question_closed: (event, at) => ({ type: 'question_closed', questionId: event.questionId, at }),
    /** What the conversation on screen waits on the user for, asked for on opening (waits-state.ts). */
    waits: (event, at) => ({ type: 'waits_restored', permissions: event.permissions, questions: event.questions, secrets: event.secrets, at }),
    secret_request: (event, at) => ({ type: 'secret_request', requestId: event.requestId, server: event.server, names: event.names, at }),
    secret_closed: (event, at) => ({ type: 'secret_closed', requestId: event.requestId }),
    turn_end: (event, at) => ({ type: 'turn_end', stopReason: event.stopReason, at }),
    memory_context: (event, at) => ({ type: 'memory_context', injected: event.injected }),
    error: (event, at) => ({ type: 'error', message: event.message }),
    /** The conversation goes on in another working directory (work-dir-ipc.js): a new part of the timeline. */
    workdir: (event, at) => ({ type: 'workdir_switched', info: event.info }),
    /** The model proposed a follow-up: a card under the conversation, for the user to decide on. */
    /** A schedule the model proposed (schedules.ts): its card under the conversation. */
    schedule_propose: (event, at) => ({ type: 'schedule_proposed', proposal: event.proposal }),
  }
  return (event: EventEnvelope, receivedAt = now()): Action | null => typeof event.type === 'string' ? EVENT_ACTIONS[event.type]?.(event, receivedAt) ?? null : null
}
