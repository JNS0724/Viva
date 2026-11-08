import { initialState, reduce as windowReduce } from '../../src/renderer/state.ts'

/**
 * The window as the backend drives it (system-design §11.3): a task's lifecycle is its snapshots' alone, and the
 * task runtime sends one where tests say only what happened. A test that starts a task (`task_started` with its
 * summary: a fixture name only, for the snapshot that makes it), asks one again (`task_asked`) or ends one (`task_end`) gets the snapshot the runtime
 * would send with it: the one that begins the run first, the one that says it ended after its end. Everything else is
 * the window's own reducer.
 */

export { initialState }

type WindowState = ReturnType<typeof windowReduce>
/** The task's summary a start gives the window (ipc-results.ts TaskSummary), as far as the snapshots here read it. */
type StartedTask = { id: string, title?: string, segmentId?: string, words?: string }
/** An action as the tests give it, as far as the snapshots here read it; the rest goes to the window's reducer as given. */
type FixtureStart = { type: 'task_started', task: StartedTask, origin?: string | null, text?: string, at?: number }
type FixtureEnd = { type: 'task_end', taskId: string, stopReason?: string, message?: string | null, at: number }
type TestAction = Action | FixtureStart | FixtureEnd

const ENDED: Readonly<Record<string, import('../../src/shared/ipc-results.ts').TaskStatus>> = { end_turn: 'done', cancelled: 'stopped', error: 'error' }
/** What a task waits on the user for once an action is taken: begun (permission, answer), or one ended. */
const WAITS: Readonly<Record<string, 'permission' | 'answer' | 'ended'>> = {
  task_permission_request: 'permission', task_question: 'answer',
  permission_resolved: 'ended', task_question_answered: 'ended', task_question_closed: 'ended',
}

const snapshotOf = (task: { id: string, title?: string }, fields: Partial<import('../../src/shared/ipc-results.ts').WindowSnapshot>): import('../../src/shared/ipc-results.ts').WindowSnapshot => ({
  taskId: task.id, runId: 'run-1', title: task.title ?? task.id, status: 'running', currentAction: null, waitingFor: null,
  startedAt: 0, updatedAt: 0, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0, ...fields,
})

/** The session a task started from the window is hung on: the one on screen (the window's own, or one for it). */
const hostOf = (state: WindowState, origin: unknown) => {
  if (origin !== undefined) return origin === null || state.newTopicPending ? '-not-here-' : String(origin)
  return state.newTopicPending ? '-not-here-' : state.info.sessionId ?? 'window-session'
}

export function reduce(state: WindowState, incoming: TestAction): WindowState {
  // This fixture supplies the runtime marks and old JS fixture aliases; production accepts only typed task actions.
  let action = incoming
  const id = 'taskId' in action && typeof action.taskId === 'string' ? action.taskId : null
  const task = state.tasks.list.find(task => task.id === id)
  const place = { runId: task?.runId ?? 'run-1', seq: (task?.seq ?? 0) + 1 }
  if (action.type === 'permission_request' && id) action = { ...action, type: 'task_permission_request', taskId: id, ...place }
  if (action.type === 'question_pick' && id) action = { ...action, type: 'task_question_pick', taskId: id }
  if (action.type === 'question_answered' && id) action = { ...action, type: 'task_question_answered', taskId: id }
  const at = 'at' in action ? action.at ?? 0 : 0

  if (action.type === 'task_started') {
    const started = action.task
    if (state.tasks.list.some((task) => task.id === started.id)) return state
    const host = hostOf(state, action.origin)
    const own = state.info.sessionId ? state : { ...state, info: { ...state.info, sessionId: host === '-not-here-' ? undefined : host } }
    const begun = windowReduce(own as WindowState, { type: 'task_snapshot', snapshot: snapshotOf(started, {
      startedAt: at, updatedAt: at, opening: { words: action.text ?? started.words ?? '', task: { id: started.id, title: started.title ?? started.id, words: started.words ?? action.text ?? '', segmentId: started.segmentId ?? `segment-${started.id}` }, hostSession: host === '-not-here-' ? null : host },
    }) })
    return { ...begun, info: state.info }
  }
  const committed: Action = action.type === 'task_end' ? { ...place, ...action } : action
  if (action?.type === 'task_asked') {
    const task = state.tasks.list.find((entry) => entry.id === action.taskId)
    if (!task) return windowReduce(state, committed)
    const run = `run-${(task.revision ?? 1) + 1}`
    return windowReduce(state, { type: 'task_snapshot', snapshot: snapshotOf(task, {
      runId: run, startedAt: at, updatedAt: at, revision: (task.revision ?? 1) + 1, taskSeq: task.seq ?? 0,
      opening: { words: action.text },
    }) })
  }
  const next = windowReduce(state, committed)
  // Waiting on the user begins or ends: the snapshot that says so (the registry's waitingFor) follows.
  const waitOf = WAITS[action.type]
  if (waitOf) {
    const requestId = 'requestId' in action ? action.requestId : null
    const taskId = id ?? next.tasks.list.find((entry) => entry.permission === null && state.tasks.list.find((was) => was.id === entry.id)?.permission?.requestId === requestId)?.id
    const task = next.tasks.list.find((entry) => entry.id === taskId)
    if (task && task.status !== 'done' && task.status !== 'stopped' && task.status !== 'error') {
      const waiting = waitOf === 'ended' ? (task.view.permission ? 'permission' : task.view.question ? 'answer' : null) : waitOf
      return windowReduce(next, { type: 'task_snapshot', snapshot: snapshotOf(task, {
        runId: task.runId ?? 'run-1', status: waiting ? 'waiting' : 'running', waitingFor: waiting, startedAt: task.startedAt ?? 0,
        updatedAt: at, revision: (task.revision ?? 1) + 1, taskSeq: task.seq ?? 0,
      }) })
    }
  }
  if (action?.type === 'task_end') {
    const task = next.tasks.list.find((entry) => entry.id === action.taskId)
    if (!task) return next
    return windowReduce(next, { type: 'task_snapshot', snapshot: snapshotOf(task, {
      runId: task.runId ?? 'run-1', status: ENDED[action.stopReason ?? ''] ?? 'done', startedAt: task.startedAt ?? 0, updatedAt: at,
      endedAt: at, revision: (task.revision ?? 1) + 1, taskSeq: task.seq ?? 0,
    }) })
  }
  return next
}
