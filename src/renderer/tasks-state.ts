import { currentAction } from './selectors.ts'

/**
 * Background tasks in the window (phase 3): turns that went on in the background (main/task-ipc.js) while the
 * conversation on screen went on. Each keeps a view shaped like the state, updated by the same handlers the
 * conversation uses, so what it is doing, what it said and what it asks are worked out the same way; undone,
 * that view is the conversation on screen again. Pure and immutable like `state.js`, which merges these in.
 */
export const initialTasks = Object.freeze({
  submissions: [] as Array<{ id: string, text: string, origin: string | null, status: string, problem?: string }>,
  moving: false,
  /** { id, segmentId, title, words, status, now, startedAt, endedAt, view } in the order they started */
  list: [] as BackgroundTask[],
  /** The move just made, while it can still be undone: { taskId, prefix, text }. */
  undo: null as Untyped,
  /** Tasks the last launch left going (task-store.js), offered to take up or let go: { id, title, segmentId, startedAt }. */
  unfinished: [] as Untyped[],
  /** The 后台 page (view/tasks-page.js): open or not, the task shown whole, and whether its steps are unfolded. */
  page: Object.freeze({ open: false, selected: null as string | null, steps: false }),
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
const savedView = (messages: ReadonlyArray<{ role: string, text: string, receipt?: Receipt | null }>, at: number | null = null) => ({
  messages: messages.map((message, i): ThreadMessage => ({
    id: `r${i}`, role: message.role, text: message.text, shown: message.text.length, open: false, receipt: message.receipt ?? null,
  })),
  thoughts: [], tools: {}, timeline: [], permission: null, question: null, secret: null,
  turn: at === null ? null : { startedAt: at, tools: 0, thoughts: 0 }, phase: at === null ? 'idle' : 'working', usage: null, lastReceipt: null, error: null,
})

/** The parts of the state a task's view keeps (the conversation, as it was when the turn left). */
const VIEW_KEYS = ['messages', 'thoughts', 'tools', 'timeline', 'permission', 'question', 'secret', 'turn', 'phase', 'usage', 'lastReceipt', 'error']
const viewOf = (state: State) => Object.fromEntries(VIEW_KEYS.map((key) => [key, state[key as keyof State]]))

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
 * What would move to the background now: the words that started the turn running, and how many saved
 * messages come before them (selectors.js historyMessages keeps the finished ones).
 */
export function spinOffTarget(state: State): { words: string, keep: number } | null {
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

/** The tool the agent calls to say, before it starts, that a job will take long (plugins/steer/lib/offer.js). */
export const OFFER_TOOL = 'viva_offer_background'

/**
 * Whether the agent said the turn running will take long (E): the window then offers 放到后台 beside it.
 * Only for the turn it said so in, and only while there is a turn to move.
 */
export function offeredBackground(state: State): { why: string } | null {
  if (!spinOffTarget(state)) return null
  const since = state.turn?.startedAt ?? Infinity
  const entry = state.timeline.findLast((item) => item.kind === 'tool' && item.at >= since && state.tools[item.ref]?.title === OFFER_TOOL)
  return entry ? { why: String(state.tools[entry.ref].rawInput?.why ?? '') } : null
}

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
 * @param handlers state.ts's handlers: a task's view is updated the way the conversation is, and the
 *   conversation goes on without the turn as after going back (`rewound`)
 */
export function taskActions(handlers: Record<string, Reducer>): Record<string, Reducer> {
  const inView = (state: State, taskId: string, type: string, action: Action) => mapTask(state, taskId, (task) => ({ ...task, view: handlers[type](task.view, action) }))

  return {
    task_moving: (state, { moving }) => withTasks(state, { moving }),
    tasks_list_folded: (state, { folded }) => withTasks(state, { listFolded: Boolean(folded) }),
    task_submitting: (state, { submission }) => withTasks(state, {
      submissions: [...state.tasks.submissions.filter(item => item.id !== submission.id), submission],
    }),
    task_submit_failed: (state, { id, problem }) => withTasks(state, {
      submissions: state.tasks.submissions.map(item => item.id === id ? { ...item, status: 'failed', problem } : item),
    }),
    task_submit_dismissed: (state, { id }) => withTasks(state, { submissions: state.tasks.submissions.filter(item => item.id !== id) }),

    /** The running turn went to the background: it takes its part of the conversation with it. */
    task_spun: (state, { task, conversation, info, folds, at, text = null }) => {
      const target = spinOffTarget(state)
      const from = target ? state.messages.findIndex((m) => m.text === target.words && startsTurn(m)) : state.messages.length
      const startedAt = state.turn?.startedAt ?? at
      // Its own turn's steps only: the turns before it stay with the conversation.
      const timeline = state.timeline.filter((item) => item.at >= startedAt)
      const entry = settled({ ...task, startedAt, endedAt: null, status: 'running', now: null, view: { ...viewOf(state), messages: state.messages.slice(from), timeline } })
      const going = handlers.rewound(state, { conversation, info, folds })
      // Undone, the earlier turns' steps come back in front of the task's (task_undone).
      const earlier = state.timeline.filter((item) => item.at < startedAt)
      const undo = { taskId: task.id, prefix: going.messages, text, timeline: earlier }
      return { ...going, ...hostTask({ ...going, taskCards: state.taskCards }, task.id), tasks: { ...state.tasks, list: [...state.tasks.list, entry], undo } }
    },

    task_update: (state, { taskId, update, at }) => inView(state, taskId, 'acp_update', { update, at }),
    task_snapshot: (state, { snapshot }) => withTasks(state, { list: state.tasks.list.map(task => task.id !== snapshot.taskId ? task : {
      ...task, status: snapshot.status, now: snapshot.currentAction, updatedAt: snapshot.updatedAt,
      endedAt: snapshot.endedAt, waitingFor: snapshot.waitingFor, revision: snapshot.revision,
    }) }),

    task_end: (state, { taskId, stopReason, message = null, at }) => {
      const task = state.tasks.list.find((entry) => entry.id === taskId)
      if (!task) return state
      const status = ENDED[stopReason] ?? 'done'
      const ended = handlers.turn_end(task.view, { stopReason, at })
      // Failed: why, as the conversation shows it (its error row), and on the card when it said nothing.
      const view = message ? { ...ended, phase: 'error', error: message } : ended
      const list = state.tasks.list.map((entry) => (entry.id === taskId ? { ...entry, view, status, now: null, endedAt: at } : entry))
      const undo = state.tasks.undo?.taskId === taskId ? null : state.tasks.undo
      // Something new came back: unseen again, even if what it said before was seen.
      const seen = state.tasks.seen.filter((id) => id !== taskId)
      return withTasks(state, { list, undo, seen })
    },

    tasks_unfinished: (state, { list }) => withTasks(state, { unfinished: list }),
    task_forgotten: (state, { taskId }) => withTasks(state, { unfinished: state.tasks.unfinished.filter((entry) => entry.id !== taskId) }),
    /** Taken up again after a relaunch: it goes on as a task in the background, with what it had said. */
    task_resumed: (state, { task, messages, at }) => withTasks({ ...state, ...hostTask(state, task.id) }, {
      unfinished: state.tasks.unfinished.filter((entry) => entry.id !== task.id),
      list: [...state.tasks.list.filter((entry) => entry.id !== task.id),
        settled({ ...task, startedAt: at, endedAt: null, status: 'running', now: null, view: savedView(messages, at) })],
    }),
    /** Tasks that had ended by the last launch (task-store.js): back as they were, to be asked again or closed. */
    tasks_restored: (state, { list }) => {
      const restored = list.map(({ task, status, endedAt, messages }: { task: BackgroundTask, status: string, endedAt: number, messages: ThreadMessage[] }) =>
        settled({ ...task, startedAt: endedAt, endedAt, status, now: null, view: savedView(messages) }))
      return withTasks(state, {
        list: [...state.tasks.list.filter(entry => !restored.some((task: BackgroundTask) => task.id === entry.id)), ...restored],
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
      return markSeen(withTasks({ ...state, island: false }, { page: { open: true, selected, steps: false } }), selected)
    },
    /** Left, the task it showed has been seen, also when the page picked it by itself (shownOnPage). */
    tasks_page_close: (state) => withTasks(markSeen(state, state.tasks.page.open ? shownOnPage(state) : null), { page: { ...state.tasks.page, open: false } }),
    tasks_page_select: (state, { taskId }) => markSeen(withTasks(state, { page: { ...state.tasks.page, selected: taskId } }), taskId),
    /** The tasks seen by the last launch, so a relaunch does not remind of them again. */
    tasks_seen_restored: (state, { ids }) => withTasks(state, {
      seen: [...new Set([...state.tasks.seen, ...(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])])],
    }),
    tasks_page_steps: (state) => withTasks(state, { page: { ...state.tasks.page, steps: !state.tasks.page.steps } }),

    /** The task could not be asked (its session is gone): it is as it was before. */
    task_ask_failed: (state, { task }) => withTasks(state, { list: state.tasks.list.map((entry) => (entry.id === task.id ? task : entry)) }),

    /** Words into that task's turn (task-ipc.js task:steer), shown in its part of the conversation. */
    task_steer: (state, { taskId, text, at }) => inView(state, taskId, 'user_steer', { text, via: null, at }),

    task_question: (state, { taskId, questionId, questions, at }) => inView(state, taskId, 'question_request', { questionId, questions, at }),
    task_question_closed: (state, { taskId, questionId, at }) => inView(state, taskId, 'question_closed', { questionId, at }),

    /** Undone: the turn is the conversation on screen again, with all it said since, still running. */
    task_undone: (state, { taskId, conversationId, info }) => {
      const task = state.tasks.list.find((entry) => entry.id === taskId)
      if (!task) return state
      return {
        ...state,
        ...task.view,
        messages: [...state.tasks.undo?.prefix ?? [], ...task.view.messages].map((m: ThreadMessage, i: number) => ({ ...m, id: `m${i}` })),
        timeline: [...state.tasks.undo?.timeline ?? [], ...task.view.timeline],
        conversationId,
        info: { ...state.info, ...info },
        folds: [],
        taskCards: state.taskCards.filter(id => id !== taskId),
        tasks: { ...state.tasks, list: state.tasks.list.filter((entry) => entry.id !== taskId), undo: null },
      }
    },

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
    return mapTask(state, action.taskId, (task) => ({ ...task, view: handlers.permission_request(task.view, action) }))
  }
  if (action.type === 'permission_resolved' && state.permission?.requestId !== action.requestId) {
    const owner = state.tasks.list.find((task) => task.view.permission?.requestId === action.requestId)
    if (owner) return mapTask(state, owner.id, (task) => ({ ...task, view: handlers.permission_resolved(task.view, action) }))
  }
  return null
}
