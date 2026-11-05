import type { DshTaskEvent, Signal } from './event-core.ts'

/**
 * What dsh reports of a background task (acp-bridge.ts), on its way to the task runtime (task-runtime.ts). A turn's
 * end and the start or end of a wait on the user are signals of the event core, recorded and then routed; what a task
 * says streams straight to the runtime. dsh says each of these once, so one must reach the runtime even when its
 * signal cannot be recorded (the database busy or full): then it goes straight there, and the runtime, which keeps
 * an end it cannot write yet, tries again (task-runtime.ts endRun).
 */

/** What a background task reports that is a signal of its waiting on the user, beginning or ending. */
const TASK_WAITS: ReadonlySet<string> = new Set(['permission', 'task_permission_closed', 'task_question', 'task_question_closed'])
const TASK_EVENTS: ReadonlySet<string> = new Set(['task_update', 'task_end', ...TASK_WAITS])

/** An event of a background task's (it names one), or null: the conversation's own permission has no taskId. */
export function taskEventOf(event: { type: string, [field: string]: unknown }): DshTaskEvent | null {
  return TASK_EVENTS.has(event.type) && typeof event.taskId === 'string' && event.taskId ? event as DshTaskEvent : null
}

export interface TaskSignalsDeps {
  /** The event core's signal: recorded, then routed (to `routed` below). */
  signal: (input: Extract<Signal, { kind: 'agent.task_ended' | 'agent.task_waits' }>) => unknown
  /** The task runtime's receive. */
  receive: (event: DshTaskEvent) => void
  onError?: (err: unknown) => void
}

export function createTaskSignals({ signal, receive, onError = () => {} }: TaskSignalsDeps) {
  /** Events their route has handed on: not handed again if what follows the route fails. */
  const handed = new WeakSet<DshTaskEvent>()

  /** An event dsh reported of a task: by way of its signal, or straight on when it is no signal or one not recorded. */
  function report(event: DshTaskEvent): unknown {
    const kind = event.type === 'task_end' ? 'agent.task_ended' as const : TASK_WAITS.has(event.type) ? 'agent.task_waits' as const : null
    if (!kind) return receive(event)
    try {
      return signal({ kind, event })
    } catch (err) {
      if (handed.has(event)) throw err
      onError(err)
      return receive(event)
    }
  }

  /** The signals' route: the event to the runtime. */
  function routed(event: DshTaskEvent) {
    handed.add(event)
    receive(event)
  }

  return { report, routed }
}
