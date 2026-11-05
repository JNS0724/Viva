import type { TaskOpening } from '../shared/ipc-results.ts'
import { currentAction } from './selectors.ts'

/**
 * Background tasks in the window: work that goes on in sessions of its own (backend/task-ipc.ts) beside the
 * conversation on screen. Each keeps a view shaped like the state, updated by the same handlers the
 * conversation uses, so what it is doing, what it said and what it asks are worked out the same way. Pure and
 * immutable like `state.ts`, which merges these in.
 */
export const initialTasks = Object.freeze({
  submissions: [] as Array<{ id: string, text: string, origin: string | null, status: string, problem?: string }>,
  /** { id, segmentId, title, words, status, now, startedAt, endedAt, view } in the order they started */
  list: [] as BackgroundTask[],
  /**
   * The 后台 page (view/tasks-page.js): open or not, the task shown whole, whether its steps are unfolded, and whether
   * all of them are drawn or only the latest (tasks-page.ts STEPS_SHOWN).
   */
  page: Object.freeze({ open: false, selected: null as string | null, steps: false, allSteps: false }),
  /** The 后台 page's list folded to a narrow strip by the user (view/tasks-page.ts), kept for the next launch. */
  listFolded: false,
  /**
   * Ended tasks the user has seen (opened on the 后台 page): no longer counted at the island's tail; their line
   * in the conversation stays. Something new from one brings it back. Kept for the next launch (app.ts).
   */
  seen: [] as string[],
})

/**
 * A task from the last launch starts from what it had said; the rest of its view begins afresh: at work
 * when taken up again (`at`), at rest when it had ended (no `at`).
 */
type SavedMessage = { role: string, text: string, receipt?: Receipt | null, open?: boolean, streamKey?: string, blocks?: ReadonlyArray<{ index: number, text: string }> }
const savedView = (messages: ReadonlyArray<SavedMessage>, at: number | null = null) => ({
  messages: messages.map((message, i): ThreadMessage => {
    // Open: the answer a task at work was still writing when the window opened (a reload), which goes on from here.
    // A stream's message keeps its key, open or not, settled or not, so what comes next for it lands on it rather than
    // starting another: more of it (with its blocks, until it settles), or the turn's fallback withdrawing it.
    const open = at !== null && message.open === true
    const stream = at !== null && message.streamKey ? { streamKey: message.streamKey, ...(message.blocks ? { streamBlocks: message.blocks } : {}) } : {}
    return { id: `r${i}`, role: message.role, text: message.text, shown: message.text.length, open, receipt: message.receipt ?? null, ...stream }
  }),
  thoughts: [], tools: {}, timeline: [], permission: null, question: null, secret: null,
  turn: at === null ? null : { startedAt: at, tools: 0, thoughts: 0 }, phase: at === null ? 'idle' : 'working', usage: null, lastReceipt: null, error: null,
})

/** A task as `task:finished` gives it back: at rest, or (a reloaded window) at work with what it waits on. */
type RestoredTask = {
  task: BackgroundTask, status: string, endedAt: number | null, startedAt?: number | null, messages: SavedMessage[],
  waits?: { permissions: Array<Record<string, unknown>>, questions: Array<Record<string, unknown>> } | null,
  /** The run it is at and the last piece of its stream in what it said (ipc-results.ts TaskMark). */
  mark?: unknown,
}

const ENDED: Readonly<Record<string, string>> = { end_turn: 'done', cancelled: 'stopped', error: 'error' }
const LIVE = new Set(['running', 'waiting'])

/**
 * status: running · waiting (on the user) · done · stopped · error; now: what it is doing (its tool calls);
 * permission / question: what it waits on the user for.
 */
function settled(task: BackgroundTask): BackgroundTask {
  const asks = { permission: task.view.permission, question: task.view.question }
  if (task.endedAt !== null) return { ...task, ...asks, now: null }
  const waiting = task.view.phase === 'waiting' || task.view.phase === 'asking'
  return { ...task, ...asks, status: waiting ? 'waiting' : 'running', now: currentAction(task.view) }
}

export const liveTasks = (state: State): BackgroundTask[] => state.tasks.list.filter((task) => LIVE.has(task.status))

/** Ended tasks the user has not seen yet: what the island's ✓ counts. */
export const unseenEnded = (state: State): BackgroundTask[] =>
  state.tasks.list.filter((task) => task.endedAt !== null && !LIVE.has(task.status) && task.status !== 'interrupted' && !state.tasks.seen.includes(task.id))

/** An ended task opened on the 后台 page has been seen: no more reminders of it. */
function markSeen(state: State, taskId: string | null): State {
  const task = state.tasks.list.find((entry) => entry.id === taskId)
  if (!task || task.endedAt === null || LIVE.has(task.status) || task.status === 'interrupted') return state
  if (state.tasks.seen.includes(task.id)) return state
  return { ...state, tasks: { ...state.tasks, seen: [...state.tasks.seen, task.id] } }
}

export const endedTasks = (state: State): BackgroundTask[] => state.tasks.list.filter((task) => !LIVE.has(task.status)).toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

/** The 后台 page's list: those waiting on the user, then those at work, then those that ended, latest first. */
export function pageGroups(state: State): Array<{ key: string, tasks: BackgroundTask[] }> {
  const groups = [
    { key: 'waiting', tasks: state.tasks.list.filter((task) => task.status === 'waiting') },
    { key: 'running', tasks: state.tasks.list.filter((task) => task.status === 'running') },
    { key: 'ended', tasks: endedTasks(state) },
  ]
  return groups.filter((group) => group.tasks.length)
}

/** The task the 后台 page shows whole, or null. */
export const pageTask = (state: State): BackgroundTask | null => state.tasks.list.find((task) => task.id === state.tasks.page.selected) ?? null
const firstOnPage = (state: State): string | null => pageGroups(state)[0]?.tasks[0]?.id ?? null

/** Follow-ups on the 后台 page are picked by this prefix, beside the tasks' ids. */
export const FOLLOWUP_KEY = 'followup:'
const LISTED_FOLLOWUPS = ['ready', 'preparing', 'scheduled'] as const

/** The keys on the page's list, in its order: follow-ups by group, then the tasks. */
function listedKeys(state: State): string[] {
  const followups = LISTED_FOLLOWUPS.flatMap((status) => state.followups.followups
    .filter((item: Untyped) => item.status === status)
    .map((item: Untyped) => `${FOLLOWUP_KEY}${item.id}`))
  const tasks = pageGroups(state).flatMap((group) => group.tasks.map((task) => task.id))
  return [...followups, ...tasks]
}

/** What the 后台 page shows: the one picked while it is still listed, else the first listed (view/tasks-page.ts onPage). */
export function shownOnPage(state: State): string | null {
  const keys = listedKeys(state)
  const selected = state.tasks.page.selected
  return selected && keys.includes(selected) ? selected : keys[0] ?? null
}

export const taskMessages = (task: BackgroundTask) => task.view.messages.map(({ role, text }: ThreadMessage) => ({ role, text }))

const startsTurn = (message: ThreadMessage) => message.role === 'user' && !message.open && !message.steered && !message.asked && !message.failed
const isBusy = (state: { phase: string }) => state.phase === 'working' || state.phase === 'waiting' || state.phase === 'asking'

/**
 * The turn running in the conversation on screen: the words that started it, and how many saved messages come
 * before them (selectors.ts historyMessages keeps the finished ones). 后台做 starts from before it.
 */
export function runningTurn(state: State): { words: string, keep: number } | null {
  if (!isBusy(state) || !state.conversationId) return null
  const saved = state.messages.filter((message) => !message.open)
  for (let keep = saved.length - 1; keep >= 0; keep -= 1) {
    if (startsTurn(saved[keep])) return { words: saved[keep].text, keep }
  }
  return null
}

const PREVIEW_CHARS = 80
/** The first line of what a task said last, for its line in the conversation (its page has all of it). */
export function taskPreview(view: { error?: string | null, messages: readonly ThreadMessage[] }) {
  // Failed, why it did; else the first line of what it said last.
  const answer = view.error || (view.messages.findLast((message) => message.role === 'assistant')?.text ?? '')
  const line = answer.split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line
}

/** What a task said last, whole: its drawer tab shows it above what it did (view/drawer.js). */
export const taskAnswer = (task: BackgroundTask): string => task.view.messages.findLast((message: ThreadMessage) => message.role === 'assistant')?.text ?? ''

const withTasks = (state: State, changes: Partial<State['tasks']>): State => ({ ...state, tasks: { ...state.tasks, ...changes } })

/**
 * A task started with no words of its own on screen (moved there mid-turn, or 后台做 while a turn ran): its card
 * goes under the message that was last when it started (view/thread.ts), so it stays where it happened as the
 * conversation goes on, instead of below everything.
 */
export function withCardAfter(messages: readonly ThreadMessage[], taskId: string): ThreadMessage[] {
  const last = messages.at(-1)
  if (!last) return [...messages]
  return [...messages.slice(0, -1), { ...last, cardsAfter: [...(last.cardsAfter ?? []), taskId] }]
}

/** A task going on again (taken up after a relaunch, asked again) keeps its card where it was, else gets one here. */
function hostTask(state: State, taskId: string): Pick<State, 'messages' | 'taskCards'> {
  const hosted = state.taskCards.includes(taskId) || state.messages.some((message) => message.taskId === taskId || message.cardsAfter?.includes(taskId))
  if (hosted) return { messages: state.messages, taskCards: state.taskCards }
  return state.messages.length ? { messages: withCardAfter(state.messages, taskId), taskCards: state.taskCards }
    : { messages: state.messages, taskCards: [...state.taskCards, taskId] }
}
const mapTask = (state: State, taskId: string, change: (task: BackgroundTask) => BackgroundTask) => withTasks(state, {
  list: state.tasks.list.map((task) => (task.id === taskId ? settled(change(task)) : task)),
})

/**
 * A piece of a task's stream (task-runtime.ts, §12.2), taken only when it is the window's: of a task it knows, of the
 * run it is at, and after the last it has (`seq`). Taken, it is the last it has. A piece without its place (not from
 * the runtime) is taken as it comes.
 */
function takePiece(state: State, action: Action, take: (state: State) => State): State {
  const { taskId, runId, seq } = action
  if (typeof seq !== 'number') return take(state)
  const task = state.tasks.list.find((entry) => entry.id === taskId)
  if (!task || (task.runId && runId !== task.runId) || seq <= (task.seq ?? 0)) return state
  return mapTask(take(state), taskId, (entry) => ({ ...entry, seq }))
}

/** A task's mark from what the window was given of it (task:finished): the run it is at, the last piece in it. */
const markOf = (mark: unknown): { runId?: string, seq?: number } => {
  const { runId, seq } = (mark && typeof mark === 'object' ? mark : {}) as { runId?: unknown, seq?: unknown }
  return typeof runId === 'string' && typeof seq === 'number' ? { runId, seq } : {}
}

/** @param handlers state.ts's handlers: a task's view is updated the way the conversation is */
export function taskActions(handlers: Record<string, Reducer>): Record<string, Reducer> {
  const inView = (state: State, taskId: string, type: string, action: Action) => mapTask(state, taskId, (task) => ({ ...task, view: handlers[type](task.view, action) }))

  /** A task's turn ended: how, in its view and on its card; something new, so unseen again. */
  function ended(state: State, { taskId, stopReason, message = null, at }: Action): State {
    const task = state.tasks.list.find((entry) => entry.id === taskId)
    if (!task) return state
    const status = ENDED[stopReason] ?? 'done'
    const turnEnded = handlers.turn_end(task.view, { stopReason, at })
    // Failed: why, as the conversation shows it (its error row), and on the card when it said nothing.
    const view = message ? { ...turnEnded, phase: 'error', error: message } : turnEnded
    const list = state.tasks.list.map((entry) => (entry.id === taskId ? { ...entry, view, status, now: null, endedAt: at } : entry))
    // Something new came back: unseen again, even if what it said before was seen.
    const seen = state.tasks.seen.filter((id) => id !== taskId)
    return withTasks(state, { list, seen })
  }

  /**
   * A task made by the snapshot that begins it: the words it was given, its first message; its line under what the
   * conversation on screen shows, when it was started from that one (by its session, as the window may not have the
   * conversation's id yet), else nowhere here.
   */
  function made(state: State, snapshot: Untyped, opening: TaskOpening): State {
    const { task, words, hostSession = null } = opening
    if (!task) return state
    const entry = settled({ ...task, runId: snapshot.runId, seq: snapshot.taskSeq ?? 0, startedAt: snapshot.startedAt, endedAt: null,
      status: snapshot.status, now: snapshot.currentAction ?? null, view: savedView([{ role: 'user', text: words }], snapshot.startedAt) })
    const here = !state.newTopicPending && hostSession !== null && hostSession === (state.info.sessionId ?? null)
    const host = here ? hostTask(state, entry.id) : { messages: state.messages, taskCards: state.taskCards }
    return { ...withTasks(state, { list: [...state.tasks.list, entry] }), ...host }
  }

  const ACTIONS: Record<string, Reducer> = {
    tasks_list_folded: (state, { folded }) => withTasks(state, { listFolded: Boolean(folded) }),
    task_submitting: (state, { submission }) => withTasks(state, {
      submissions: [...state.tasks.submissions.filter(item => item.id !== submission.id), submission],
    }),
    task_submit_failed: (state, { id, problem }) => withTasks(state, {
      submissions: state.tasks.submissions.map(item => item.id === id ? { ...item, status: 'failed', problem } : item),
    }),
    task_submit_dismissed: (state, { id }) => withTasks(state, { submissions: state.tasks.submissions.filter(item => item.id !== id) }),

    task_update: (state, action) => takePiece(state, action, (taken) => inView(taken, action.taskId, 'acp_update', { update: action.update, at: action.at })),
    /**
     * How a task stands (task-runtime.ts). The one that begins a run comes before the run's first piece, with what it
     * begins with: a task new is made from it (its line in the conversation it was started from, when that is the one
     * on screen); one known goes on with a new run, its words its next question. Every snapshot says the last piece
     * of the stream it includes.
     */
    task_snapshot: (state, { snapshot }) => {
      const task = state.tasks.list.find((entry) => entry.id === snapshot.taskId)
      const opening: TaskOpening | undefined = snapshot.opening
      if (!task) return opening?.task ? made(state, snapshot, opening) : state
      // Older than what the window has (one that waited for a read of the tasks): how it stood then, not now.
      if (!opening && typeof snapshot.taskSeq === 'number' && snapshot.taskSeq < (task.seq ?? 0)) return state
      const begun = opening && snapshot.runId !== task.runId
        ? ACTIONS.task_asked(state, { taskId: task.id, text: opening.words, at: snapshot.startedAt }) : state
      // How it stands is the snapshot's, as it says it (not worked out again from its view).
      return withTasks(begun, { list: begun.tasks.list.map((entry) => entry.id !== task.id ? entry : {
        ...entry, status: snapshot.status, now: snapshot.currentAction, updatedAt: snapshot.updatedAt,
        endedAt: snapshot.endedAt, waitingFor: snapshot.waitingFor, revision: snapshot.revision,
        runId: snapshot.runId, seq: Math.max(begun === state ? entry.seq ?? 0 : 0, snapshot.taskSeq ?? 0),
      }) })
    },

    task_end: (state, action) => takePiece(state, action, (taken) => ended(taken, action)),
    task_question: (state, action) => takePiece(state, action, (taken) =>
      inView(taken, action.taskId, 'question_request', { questionId: action.questionId, questions: action.questions, at: action.at })),
    task_question_closed: (state, action) => takePiece(state, action, (taken) =>
      inView(taken, action.taskId, 'question_closed', { questionId: action.questionId, at: action.at })),

    /** Tasks that had ended by the last launch (task-store.js): back as they were, to be asked again or closed. */
    tasks_restored: (state, { list }) => {
      // One still at work (a reloaded window) goes on from what it said so far, with what it waits on the user for;
      // the others are at rest.
      const restored = list.map(({ task, status, endedAt, startedAt = null, messages, waits = null, mark }: RestoredTask) => {
        if (endedAt !== null) return settled({ ...task, ...markOf(mark), startedAt: endedAt, endedAt, status, now: null, view: savedView(messages) })
        const at = startedAt ?? 0
        const asked = (waits?.permissions ?? []).reduce<BackgroundTask['view']>((view, wait) => handlers.permission_request(view, { ...wait, at }), savedView(messages, at))
        const view = (waits?.questions ?? []).reduce<BackgroundTask['view']>((current, wait) => handlers.question_request(current, { ...wait, at }), asked)
        return settled({ ...task, ...markOf(mark), startedAt: at, endedAt: null, status, now: null, view })
      })
      // What the window has of a task already, as new as what was read or newer (by the last piece of its stream,
      // one count across its runs), stays: a read that came back late never puts a task back to where it was.
      const fresher = (task: BackgroundTask) => {
        const known = state.tasks.list.find((entry) => entry.id === task.id)
        return Boolean(known && typeof task.seq === 'number' && typeof known.seq === 'number' && known.seq >= task.seq)
      }
      const taken = restored.filter((task: BackgroundTask) => !fresher(task))
      return withTasks(state, {
        list: [...state.tasks.list.filter((entry) => !taken.some((task: BackgroundTask) => task.id === entry.id)), ...taken],
      })
    },
    /**
     * 接着问 to a task that ended: the words are its next question, and it is back at work in the background,
     * its line in the conversation saying so.
     */
    task_asked: (state, { taskId, text, at }) =>
      mapTask({ ...state, ...hostTask(state, taskId) }, taskId, (task) => ({ ...task, startedAt: at, endedAt: null, view: handlers.user_prompt(task.view, { text, at }) })),
    /**
     * 后台做: the request belongs to the task's own conversation. Only its card joins the main thread,
     * whether the foreground is idle or busy.
     */
    task_started: (state, { task, text, at, submissionId, origin }) => {
      // Made already by the snapshot that began it (the usual way): its submission is done, nothing else.
      if (state.tasks.list.some((entry) => entry.id === task.id)) {
        return withTasks(state, { submissions: state.tasks.submissions.filter((item) => item.id !== submissionId) })
      }
      const entry = settled({ ...task, startedAt: at, endedAt: null, status: 'running', now: null, view: savedView([{ role: 'user', text }], at) })
      const host = origin !== undefined && (state.newTopicPending || origin !== (state.info.sessionId ?? null))
        ? { messages: state.messages, taskCards: state.taskCards } : hostTask(state, task.id)
      return { ...withTasks(state, { list: [...state.tasks.list, entry], submissions: state.tasks.submissions.filter(item => item.id !== submissionId) }), ...host }
    },

    /** The 后台 page, on the task asked for, else the one it was on, else the first in its list. */
    tasks_page_open: (state, { taskId = null }) => {
      const known = (id: string | null) => state.tasks.list.some((task) => task.id === id)
      const selected = [taskId, state.tasks.page.selected].find((id) => id && known(id)) ?? firstOnPage(state)
      // Opened again, its steps start folded; the task shown, if ended, is seen.
      return markSeen(withTasks({ ...state, island: false }, { page: { open: true, selected, steps: false, allSteps: false } }), selected)
    },
    /** Left, the task it showed has been seen, also when the page picked it by itself (shownOnPage). */
    tasks_page_close: (state) => withTasks(markSeen(state, state.tasks.page.open ? shownOnPage(state) : null), { page: { ...state.tasks.page, open: false } }),
    tasks_page_select: (state, { taskId }) => markSeen(withTasks(state, { page: { ...state.tasks.page, selected: taskId, allSteps: false } }), taskId),
    /** The tasks seen by the last launch, so a relaunch does not remind of them again. */
    tasks_seen_restored: (state, { ids }) => withTasks(state, {
      seen: [...new Set([...state.tasks.seen, ...(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])])],
    }),
    tasks_page_steps: (state) => withTasks(state, { page: { ...state.tasks.page, steps: !state.tasks.page.steps, allSteps: false } }),
    tasks_page_all_steps: (state) => withTasks(state, { page: { ...state.tasks.page, allSteps: true } }),

    /** Words into that task's turn (task-ipc.js task:steer), shown in its part of the conversation. */
    task_steer: (state, { taskId, text, at }) => inView(state, taskId, 'user_steer', { text, via: null, at }),

    task_closed: (state, { taskId }) => {
      const closed = {
        ...withTasks(state, { list: state.tasks.list.filter((task) => task.id !== taskId) }),
        taskCards: state.taskCards.filter(id => id !== taskId),
      }
      // The page goes on to the next task when the one it showed is closed; shown, that one is seen.
      if (state.tasks.page.selected !== taskId) return closed
      const next = firstOnPage(closed)
      const moved = withTasks(closed, { page: { ...closed.tasks.page, selected: next } })
      return closed.tasks.page.open ? markSeen(moved, next) : moved
    },
  }
  return ACTIONS
}

/** Picking for a task's question, and answering it: the window names the task (app.js). */
const ASKED_OF_TASK = new Set(['question_pick', 'question_answered'])

/**
 * A permission request or answer, or a pick or answer for a question, that belongs to a task: into its view
 * instead of the conversation's.
 * @returns the state, or null when the action is the conversation's own
 */
export function routeToTask(state: State, action: Action, handlers: Record<string, Reducer>): State | null {
  if (ASKED_OF_TASK.has(action.type ?? '') && action.taskId) {
    return mapTask(state, action.taskId, (task) => ({ ...task, view: handlers[action.type ?? ''](task.view, action) }))
  }
  if (action.type === 'permission_request' && action.taskId) {
    return takePiece(state, action, (taken) => mapTask(taken, action.taskId, (task) => ({ ...task, view: handlers.permission_request(task.view, action) })))
  }
  if (action.type === 'permission_resolved' && state.permission?.requestId !== action.requestId) {
    const owner = state.tasks.list.find((task) => task.view.permission?.requestId === action.requestId)
    if (owner) return mapTask(state, owner.id, (task) => ({ ...task, view: handlers.permission_resolved(task.view, action) }))
  }
  return null
}
