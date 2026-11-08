import { decodeWaits } from './agent-event-decoder.ts'
import type { ConversationAction, ConversationPayloads, PermissionRequest } from './conversation-types.ts'
import type { TaskStream } from './action-types.ts'
import type { ActionHandlers, PayloadFor } from './action-types.ts'
import type { ActiveTool, TaskOpening } from '../shared/ipc-results.ts'
import { reduceConversation } from './conversation-state.ts'
import { currentAction } from './selectors.ts'

/**
 * Background tasks in the window: work that goes on in sessions of its own (backend/task-ipc.ts) beside the
 * conversation on screen. Each keeps a conversation of its own (`view`, conversation-state.ts ConversationView),
 * reduced by the same pure reducer as the one on screen, so what it is doing, what it said and what it asks are worked
 * out the same way, and nothing of the window's gets into it. Pure and immutable like `state.ts`, which merges these in.
 */
export const initialTasks = Object.freeze({
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
const savedView = (messages: ReadonlyArray<SavedMessage>, at: number | null = null): ConversationView => ({
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
  task: import('../shared/ipc-results.ts').TaskSummary, status: string, endedAt: number | null, startedAt?: number | null, messages: readonly SavedMessage[],
  waits?: { permissions: readonly unknown[], questions: readonly unknown[] } | null,
  /** The tool calls it has at work (task-registry.ts activeTools), so its card says what it is doing. */
  tools?: readonly ActiveTool[] | null,
  /** The run it is at and the last piece of its stream in what it said (ipc-results.ts TaskMark). */
  mark?: unknown,
}

const LIVE = new Set(['running', 'waiting'])

/**
 * A task read at work, with the tool calls it has at work: in its view as the live channel would have left them (at
 * work, each a step), without closing what it is writing, which they may have begun before.
 */
const withTools = (view: ConversationView, tools: readonly ActiveTool[], at: number): ConversationView => (tools.length ? {
  ...view,
  tools: { ...view.tools, ...Object.fromEntries(tools.map((tool) => [tool.toolCallId, { id: tool.toolCallId, title: tool.title, kind: 'other', status: 'in_progress', locations: [], at }])) },
  timeline: [...view.timeline, ...tools.map((tool) => ({ kind: 'tool' as const, ref: tool.toolCallId, at }))],
} : view)

/**
 * What a task's card shows of its conversation: what it is doing now (its tool, or replying), and what it waits on
 * the user for (permission / question), worked out from its view. How it stands (status: running · waiting · done ·
 * stopped · error · interrupted, and when it started and ended) is its snapshot's alone (task-runtime.ts), never
 * worked out here.
 */
function settled(task: BackgroundTask): BackgroundTask {
  const asks = { permission: task.view.permission, question: task.view.question }
  return { ...task, ...asks, now: LIVE.has(task.status) ? currentAction(task.view) : null }
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

/** The keys on the page's list, in its order: the tasks by group. */
function listedKeys(state: State): string[] {
  return pageGroups(state).flatMap((group) => group.tasks.map((task) => task.id))
}

/** What the 后台 page shows: the one picked while it is still listed, else the first listed (view/tasks-page.ts onPage). */
export function shownOnPage(state: State): string | null {
  const keys = listedKeys(state)
  const selected = state.tasks.page.selected
  return selected && keys.includes(selected) ? selected : keys[0] ?? null
}

export const taskMessages = (task: BackgroundTask) => task.view.messages.map(({ role, text }: ThreadMessage) => ({ role, text }))

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
 * A task started with no words of its own on screen (moved there mid-turn): its card
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
 * A piece of a task's stream (task-runtime.ts, system-design §11.3), taken only when it is the window's: of a task it knows, of the
 * run it is at, and after the last it has (`seq`). Taken, it is the last it has. A piece without its place (not from
 * the runtime) is taken as it comes.
 */
function takePiece(state: State, action: Pick<TaskStream, 'taskId' | 'runId' | 'seq'>, take: (state: State) => State): State {
  const { taskId, runId, seq } = action
  if (typeof seq !== 'number') return take(state)
  const task = state.tasks.list.find((entry) => entry.id === taskId)
  if (!task || (task.runId && runId !== task.runId) || seq <= (task.seq ?? 0)) return state
  return mapTask(take(state), taskId, (entry) => ({ ...entry, seq }))
}

/** A task's mark from what the window was given of it (task:finished): the run it is at, the last piece in it. */
const markOf = (mark: unknown): { runId?: string, seq?: number, revision?: number } => {
  const { runId, seq, revision } = (mark && typeof mark === 'object' ? mark : {}) as { runId?: unknown, seq?: unknown, revision?: unknown }
  if (typeof runId !== 'string' || typeof seq !== 'number') return {}
  return { runId, seq, ...(typeof revision === 'number' ? { revision } : {}) }
}

/**
 * Whether a snapshot is older than what the window has of its task, or the same: by its revision, which grows with
 * every change of the task (task-registry.ts), across its runs. The last piece of the stream cannot tell, as several
 * snapshots say the same one (a run ending, the next beginning).
 */
const isStale = (snapshot: { revision?: unknown }, task: BackgroundTask) =>
  typeof snapshot.revision === 'number' && typeof task.revision === 'number' && snapshot.revision <= task.revision

/** A task's view goes on as any conversation does (conversation-state.ts), by the action's type. */
const inView = (state: State, taskId: string, action: ConversationAction) =>
  mapTask(state, taskId, (task) => ({ ...task, view: reduceConversation(task.view, action) }))

export function taskActions() {

  /**
   * A task's turn ended, in its view; something new, so unseen again. That it ended, and how, its snapshot says
   * (it follows this piece).
   */
  function ended(state: State, { taskId, stopReason, message = null, at }: PayloadFor<'task_end'>): State {
    const task = state.tasks.list.find((entry) => entry.id === taskId)
    if (!task) return state
    const turnEnded = reduceConversation(task.view, { type: 'turn_end', stopReason, at })
    // Failed: why, as the conversation shows it (its error row), and on the card when it said nothing.
    const view: ConversationView = message ? { ...turnEnded, phase: 'error', error: message } : turnEnded
    const list = state.tasks.list.map((entry) => (entry.id === taskId ? settled({ ...entry, view }) : entry))
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
    const entry = settled({ ...task, runId: snapshot.runId, seq: snapshot.taskSeq ?? 0, revision: snapshot.revision, startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt, status: snapshot.status, waitingFor: snapshot.waitingFor, view: savedView([{ role: 'user', text: words }], snapshot.startedAt) })
    const here = !state.newTopicPending && hostSession !== null && hostSession === (state.info.sessionId ?? null)
    const host = here ? hostTask(state, entry.id) : { messages: state.messages, taskCards: state.taskCards }
    return { ...withTasks(state, { list: [...state.tasks.list, entry] }), ...host }
  }

  const ACTIONS: ActionHandlers = {
    tasks_list_folded: (state, { folded }) => withTasks(state, { listFolded: Boolean(folded) }),

    task_update: (state, action) => takePiece(state, action, (taken) => inView(taken, action.taskId, { type: 'acp_update', update: action.update, at: action.at })),
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
      // Older than what the window has, or the same (one that waited for a read of the tasks, the beginning of a run
      // the read has already): how it stood then, not now; nor a run begun again.
      if (isStale(snapshot, task)) return state
      const begun = opening && snapshot.runId !== task.runId
        ? ACTIONS.task_asked!(state, { taskId: task.id, text: opening.words, at: snapshot.startedAt }) : state
      // How it stands is the snapshot's, as it says it; what it is doing now its card works out from its view.
      return withTasks(begun, { list: begun.tasks.list.map((entry) => entry.id !== task.id ? entry : settled({
        ...entry, status: snapshot.status, updatedAt: snapshot.updatedAt, startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt, waitingFor: snapshot.waitingFor, revision: snapshot.revision,
        runId: snapshot.runId, seq: Math.max(begun === state ? entry.seq ?? 0 : 0, snapshot.taskSeq ?? 0),
      })) })
    },

    task_end: (state, action) => takePiece(state, action, (taken) => ended(taken, action)),
    task_question: (state, action) => takePiece(state, action, (taken) =>
      inView(taken, action.taskId, { type: 'question_request', questionId: action.questionId, questions: action.questions, at: action.at })),
    task_question_closed: (state, action) => takePiece(state, action, (taken) =>
      inView(taken, action.taskId, { type: 'question_closed', questionId: action.questionId, at: action.at })),
    task_permission_closed: (state, action) => takePiece(state, action, (taken) =>
      inView(taken, action.taskId, { type: 'permission_closed', requestId: action.requestId, at: action.at })),

    /** Tasks that had ended by the last launch (task-store.js): back as they were, to be asked again or closed. */
    tasks_restored: (state, { list }) => {
      // One still at work (a reloaded window) goes on from what it said so far, with what it waits on the user for;
      // the others are at rest.
      const restored = list.map(({ task, status, endedAt, startedAt = null, messages, waits = null, tools = null, mark }: RestoredTask) => {
        // How it stands is what the backend says (its snapshot): at rest, or at work with what it waits on.
        if (!LIVE.has(status)) return settled({ ...task, ...markOf(mark), startedAt: endedAt ?? undefined, endedAt, status, view: savedView(messages) })
        const at = startedAt ?? 0
        const requests = decodeWaits(waits ?? {}) ?? { permissions: [], questions: [], secrets: [] }
        const asked = requests.permissions.reduce<ConversationView>((view, wait) => reduceConversation(view, { ...wait, type: 'permission_request', at }), withTools(savedView(messages, at), tools ?? [], at))
        const view = requests.questions.reduce<ConversationView>((current, wait) => reduceConversation(current, { ...wait, type: 'question_request', at }), asked)
        return settled({ ...task, ...markOf(mark), startedAt: at, endedAt: null, status, now: null, view })
      })
      // The read is the baseline of each task it is given (task-actions.ts loadKept gives those the window cannot go on
      // from itself). What the live channel said of any task while it was read waited, and follows over it, each piece
      // and snapshot let in only when newer; a task it is not given stays as it is.
      const taken = restored
      return withTasks(state, {
        list: [...state.tasks.list.filter((entry) => !taken.some((task: BackgroundTask) => task.id === entry.id)), ...taken],
      })
    },
    /**
     * 接着问 to a task that ended: the words are its next question, and it is back at work in the background,
     * its line in the conversation saying so.
     */
    task_asked: (state, { taskId, text, at }) =>
      mapTask({ ...state, ...hostTask(state, taskId) }, taskId, (task) => ({ ...task, view: reduceConversation(task.view, { type: 'user_prompt', text, at }) })),

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

    /**
     * Words the agent said into that task's turn (task-runtime.ts `said`), shown in its part of the conversation; a
     * piece of its stream, taken once (a read that has them already leaves them out by its number).
     */
    task_steer: (state, action) => takePiece(state, action, (taken) => inView(taken, action.taskId, { type: 'user_steer', text: action.text, via: null })),

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
  } satisfies ActionHandlers
  return ACTIONS
}

/** Picking for a task's question, and answering it: the window names the task (app.js). */

/**
 * A permission request or answer, or a pick or answer for a question, that belongs to a task: into its view
 * instead of the conversation's.
 * @returns the state, or null when the action is the conversation's own
 */
export function routeToTask(state: State, action: Action): State | null {
  if (action.type === 'task_question_pick') return inView(state, action.taskId, { type: 'question_pick', id: action.id, label: action.label })
  if (action.type === 'task_question_answered') return inView(state, action.taskId, { type: 'question_answered', questionId: action.questionId, answers: action.answers, at: action.at })
  if (action.type === 'task_permission_request') return takePiece(state, action, taken => inView(taken, action.taskId, { ...action, type: 'permission_request' }))
  if (action.type === 'permission_resolved' && state.permission?.requestId !== action.requestId) {
    const owner = state.tasks.list.find((task) => task.view.permission?.requestId === action.requestId)
    if (owner) return mapTask(state, owner.id, (task) => ({ ...task, view: reduceConversation(task.view, action) }))
  }
  return null
}
