import { initialState, reduce as windowReduce } from '../../src/renderer/state.ts'

/**
 * The window as the backend drives it (system-design §11.3): a task's lifecycle is its snapshots' alone, and the
 * task runtime sends one where tests say only what happened. A test that starts a task (`task_started` with its
 * summary, as 后台做 answers), asks one again (`task_asked`) or ends one (`task_end`) gets the snapshot the runtime
 * would send with it: the one that begins the run first, the one that says it ended after its end. Everything else is
 * the window's own reducer.
 */

export { initialState }

type WindowState = ReturnType<typeof windowReduce>
type Action = { type?: string, [field: string]: any }

const ENDED: Readonly<Record<string, string>> = { end_turn: 'done', cancelled: 'stopped', error: 'error' }
/** What a task waits on the user for once an action is taken: begun (permission, answer), or one ended. */
const WAITS: Readonly<Record<string, 'permission' | 'answer' | 'ended'>> = {
  permission_request: 'permission', task_question: 'answer',
  permission_resolved: 'ended', question_answered: 'ended', task_question_closed: 'ended',
}

const snapshotOf = (task: { id: string, title?: string }, fields: Record<string, unknown>) => ({
  taskId: task.id, runId: 'run-1', title: task.title ?? task.id, status: 'running', currentAction: null, waitingFor: null,
  startedAt: 0, updatedAt: 0, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0, ...fields,
})

/** The session a task started from the window is hung on: the one on screen (the window's own, or one for it). */
const hostOf = (state: WindowState, origin: unknown) => {
  if (origin !== undefined) return origin === null || state.newTopicPending ? '-not-here-' : origin
  return state.newTopicPending ? '-not-here-' : state.info.sessionId ?? 'window-session'
}

export function reduce(state: WindowState, action: Action): WindowState {
  if (action?.type === 'task_started' && action.task && !state.tasks.list.some((task) => task.id === action.task.id)) {
    const host = hostOf(state, action.origin)
    const own = state.info.sessionId ? state : { ...state, info: { ...state.info, sessionId: host === '-not-here-' ? undefined : host } }
    const begun = windowReduce(own as WindowState, { type: 'task_snapshot', snapshot: snapshotOf(action.task, {
      startedAt: action.at ?? 0, updatedAt: action.at ?? 0, opening: { words: action.text, task: action.task, hostSession: host === '-not-here-' ? null : host },
    }) })
    return windowReduce({ ...begun, info: state.info }, action)
  }
  if (action?.type === 'task_asked') {
    const task = state.tasks.list.find((entry) => entry.id === action.taskId)
    if (!task) return windowReduce(state, action)
    const run = `run-${(task.revision ?? 1) + 1}`
    return windowReduce(state, { type: 'task_snapshot', snapshot: snapshotOf(task, {
      runId: run, startedAt: action.at ?? 0, updatedAt: action.at ?? 0, revision: (task.revision ?? 1) + 1, taskSeq: task.seq ?? 0,
      opening: { words: action.text },
    }) })
  }
  const next = windowReduce(state, action)
  // Waiting on the user begins or ends: the snapshot that says so (the registry's waitingFor) follows.
  const waitOf = WAITS[action?.type ?? '']
  if (waitOf) {
    const taskId = action.taskId ?? next.tasks.list.find((entry) => entry.permission === null && state.tasks.list.find((was) => was.id === entry.id)?.permission?.requestId === action.requestId)?.id
    const task = next.tasks.list.find((entry) => entry.id === taskId)
    if (task && task.status !== 'done' && task.status !== 'stopped' && task.status !== 'error') {
      const waiting = waitOf === 'ended' ? (task.view.permission ? 'permission' : task.view.question ? 'answer' : null) : waitOf
      return windowReduce(next, { type: 'task_snapshot', snapshot: snapshotOf(task, {
        runId: task.runId ?? 'run-1', status: waiting ? 'waiting' : 'running', waitingFor: waiting, startedAt: task.startedAt ?? 0,
        updatedAt: action.at ?? 0, revision: (task.revision ?? 1) + 1, taskSeq: task.seq ?? 0,
      }) })
    }
  }
  if (action?.type === 'task_end') {
    const task = next.tasks.list.find((entry) => entry.id === action.taskId)
    if (!task) return next
    return windowReduce(next, { type: 'task_snapshot', snapshot: snapshotOf(task, {
      runId: task.runId ?? 'run-1', status: ENDED[action.stopReason] ?? 'done', startedAt: task.startedAt ?? 0, updatedAt: action.at ?? 0,
      endedAt: action.at ?? 0, revision: (task.revision ?? 1) + 1, taskSeq: task.seq ?? 0,
    }) })
  }
  return next
}
