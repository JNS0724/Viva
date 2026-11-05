import type { DshTaskEvent, Signal } from './event-core.ts'

/**
 * What dsh reports of a background task (acp-bridge.ts), on its way to the task runtime (task-runtime.ts). dsh says
 * each once, so it goes to the runtime first, always, and the runtime is what keeps it (an end it cannot write yet is
 * tried again, task-runtime.ts endRun). A turn's end and the start or end of a wait on the user are then recorded as
 * signals of the event core, for the record only: what follows from a task ending follows from the runtime's kept
 * `task.ended`, never from this signal, and a signal that cannot be recorded loses nothing.
 */

/** What a background task reports that is a signal of its waiting on the user, beginning or ending. */
const TASK_WAITS: ReadonlySet<string> = new Set(['permission', 'task_permission_closed', 'task_question', 'task_question_closed'])
const TASK_EVENTS: ReadonlySet<string> = new Set(['task_update', 'task_end', ...TASK_WAITS])

/** An event of a background task's (it names one), or null: the conversation's own permission has no taskId. */
export function taskEventOf(event: { type: string, [field: string]: unknown }): DshTaskEvent | null {
  return TASK_EVENTS.has(event.type) && typeof event.taskId === 'string' && event.taskId ? event as DshTaskEvent : null
}

export interface TaskSignalsDeps {
  /** The event core's signal: recorded (its route does nothing more, compose.ts). */
  signal: (input: Extract<Signal, { kind: 'agent.task_ended' | 'agent.task_waits' }>) => unknown
  /** The task runtime's receive. */
  receive: (event: DshTaskEvent) => void
  onError?: (err: unknown) => void
}

export function createTaskSignals({ signal, receive, onError = () => {} }: TaskSignalsDeps) {
  /** An event dsh reported of a task: to the runtime, then, a signal, recorded. */
  function report(event: DshTaskEvent): void {
    try {
      receive(event)
    } finally {
      const kind = event.type === 'task_end' ? 'agent.task_ended' as const : TASK_WAITS.has(event.type) ? 'agent.task_waits' as const : null
      if (kind) {
        try {
          signal({ kind, event })
        } catch (err) {
          onError(err)
        }
      }
    }
  }

  return { report }
}
