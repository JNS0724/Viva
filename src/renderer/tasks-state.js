import { currentAction } from './selectors.js'

/**
 * Background tasks in the window (phase 3): turns that went on in the background (main/task-ipc.js) while the
 * conversation on screen went on. Each keeps a view shaped like the state, updated by the same handlers the
 * conversation uses, so what it is doing, what it said and what it asks are worked out the same way; undone,
 * that view is the conversation on screen again. Pure and immutable like `state.js`, which merges these in.
 */
export const initialTasks = Object.freeze({
  /** { id, segmentId, title, words, status, now, startedAt, endedAt, view } in the order they started */
  list: [],
  /** The move just made, while it can still be undone: { taskId, prefix, text }. */
  undo: null,
  /** Tab: the words typed now go the other way than routeOf would send them. */
  flip: false,
  /** The task that just ended, for the island to say so a moment: { taskId, title, status }. */
  finished: null,
  /**
   * What ended tasks came back with, for the conversation (F): { taskId, title, status, preview, shown }.
   * shown: put in the thread once the user is not typing (task-actions.js); gone once put away.
   */
  reports: [],
  /** Tasks the last launch left going (task-store.js), offered to take up or let go: { id, title, segmentId, startedAt }. */
  unfinished: [],
})

/** A task taken up again starts from what it had said; the rest of its view begins afresh, at work. */
const takenUpView = (messages, at) => ({
  messages: messages.map((message, i) => ({
    id: `r${i}`, role: message.role, text: message.text, shown: message.text.length, open: false, receipt: message.receipt ?? null,
  })),
  thoughts: [], tools: {}, timeline: [], permission: null, question: null, secret: null,
  turn: { startedAt: at, tools: 0, thoughts: 0 }, phase: 'working', usage: null, lastReceipt: null, error: null,
})

/** The parts of the state a task's view keeps (the conversation, as it was when the turn left). */
const VIEW_KEYS = ['messages', 'thoughts', 'tools', 'timeline', 'permission', 'question', 'secret', 'turn', 'phase', 'usage', 'lastReceipt', 'error']
const viewOf = (state) => Object.fromEntries(VIEW_KEYS.map((key) => [key, state[key]]))

const ENDED = { end_turn: 'done', cancelled: 'stopped', error: 'error' }
const LIVE = new Set(['running', 'waiting'])

/**
 * status: running · waiting (on the user) · done · stopped · error; now: what it is doing (its tool calls);
 * permission / question: what it waits on the user for.
 */
function settled(task) {
  const asks = { permission: task.view.permission, question: task.view.question }
  if (task.endedAt !== null) return { ...task, ...asks, now: null }
  const waiting = task.view.phase === 'waiting' || task.view.phase === 'asking'
  return { ...task, ...asks, status: waiting ? 'waiting' : 'running', now: currentAction(task.view) }
}

export const liveTasks = (state) => state.tasks.list.filter((task) => LIVE.has(task.status))

/** A task's tab in the drawer (view/drawer.js): what it did, as the 过程 tab shows the conversation's. */
const TAB_PREFIX = 'task:'
export const taskTab = (taskId) => `${TAB_PREFIX}${taskId}`
export function taskOfTab(state, tab) {
  if (!tab?.startsWith(TAB_PREFIX)) return null
  return state.tasks.list.find((task) => task.id === tab.slice(TAB_PREFIX.length)) ?? null
}
export const taskMessages = (task) => task.view.messages.map(({ role, text }) => ({ role, text }))

const startsTurn = (message) => message.role === 'user' && !message.open && !message.steered && !message.asked && !message.failed
const isBusy = (state) => state.phase === 'working' || state.phase === 'waiting' || state.phase === 'asking'

/**
 * What would move to the background now: the words that started the turn running, and how many saved
 * messages come before them (selectors.js historyMessages keeps the finished ones).
 * @returns {{ words: string, keep: number } | null}
 */
export function spinOffTarget(state) {
  if (!isBusy(state) || !state.conversationId) return null
  const saved = state.messages.filter((message) => !message.open)
  for (let keep = saved.length - 1; keep >= 0; keep -= 1) {
    if (startsTurn(saved[keep])) return { words: saved[keep].text, keep }
  }
  return null
}

const PREVIEW_CHARS = 80
/** The first line of what a task said last, for its report (the drawer tab has all of it). */
function previewOf(view) {
  const answer = view.messages.findLast((message) => message.role === 'assistant')?.text ?? ''
  const line = answer.split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line
}

/** What a task said last, whole: its drawer tab shows it above what it did (view/drawer.js). */
export const taskAnswer = (task) => task.view.messages.findLast((message) => message.role === 'assistant')?.text ?? ''

const MENTION = /^#(\S+)\s+(\S[\s\S]*)$/
/**
 * 「#name words」: the words go to the background task whose title has `name` in it, not to the
 * conversation on screen. Only tasks still going take words.
 * @returns {{ taskId: string, title: string, text: string } | null}
 */
export function mentionedTask(state, text) {
  const match = MENTION.exec(text.trim())
  if (!match) return null
  const task = liveTasks(state).find((entry) => entry.title.includes(match[1]))
  return task ? { taskId: task.id, title: task.title, text: match[2].trim() } : null
}

/** The tool the agent calls to say, before it starts, that a job will take long (plugins/steer/lib/offer.js). */
export const OFFER_TOOL = 'viva_offer_background'

/**
 * Whether the agent said the turn running will take long (E): the window then offers 放到后台 beside it.
 * Only for the turn it said so in, and only while there is a turn to move.
 * @returns {{ why: string } | null}
 */
export function offeredBackground(state) {
  if (!spinOffTarget(state)) return null
  const since = state.turn?.startedAt ?? Infinity
  const entry = state.timeline.findLast((item) => item.kind === 'tool' && item.at >= since && state.tools[item.ref]?.title === OFFER_TOOL)
  return entry ? { why: String(state.tools[entry.ref].rawInput?.why ?? '') } : null
}

/** Said to go on with what runs: 「顺便」「再」「改成」… */
const GOES_ON = /^(顺便|再|还要|还有|另外|也|并且|然后|接着|改成|换成|别|不要|加上|补充|记得|继续|等等)/
/** Something of its own: a question, or a request of its own (「帮我…」「查一下…」). */
const ASKING = /^(帮我|帮忙|麻烦|给我|请|查一?下|看一?下|问一?下|搜一?下|写一?个|做一?个|翻译|算一?下)/
const NEW_THING = new RegExp(`[？?]$|${ASKING.source}`)
/** What the words are about: two letters at a time, leaving out how a request starts (「帮我」). */
const pairsOf = (text) => {
  const letters = [...text.replace(ASKING, '').replace(/[\s\p{P}\p{S}]+/gu, '')]
  return new Set(letters.slice(1).map((letter, i) => `${letters[i]}${letter}`))
}

/**
 * Where words typed while a turn runs would go: on their own ('other'), the turn moving to the background,
 * when they ask something of their own and share nothing with what started it; else 'into' the turn (the
 * viva-steer plugin), which, when unsure, adds nothing to undo. Tab turns it round. null when nothing runs.
 */
export function routeOf(state, text) {
  const target = spinOffTarget(state)
  const words = text.trim()
  if (!target || !words) return null
  const asked = pairsOf(target.words)
  const shares = [...pairsOf(words)].some((pair) => asked.has(pair))
  const auto = NEW_THING.test(words) && !GOES_ON.test(words) && !shares ? 'other' : 'into'
  if (!state.tasks.flip) return auto
  return auto === 'into' ? 'other' : 'into'
}

const withTasks = (state, changes) => ({ ...state, tasks: { ...state.tasks, ...changes } })
const mapTask = (state, taskId, change) => withTasks(state, {
  list: state.tasks.list.map((task) => (task.id === taskId ? settled(change(task)) : task)),
})

/**
 * @param {Record<string, Function>} handlers state.js's handlers: a task's view is updated the way the
 *   conversation is, and the conversation goes on without the turn as after going back (`rewound`)
 */
export function taskActions(handlers) {
  const inView = (state, taskId, type, action) => mapTask(state, taskId, (task) => ({ ...task, view: handlers[type](task.view, action) }))

  return {
    route_toggle: (state) => withTasks(state, { flip: !state.tasks.flip }),

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
      return { ...going, tasks: { ...state.tasks, list: [...state.tasks.list, entry], undo, flip: false } }
    },

    task_update: (state, { taskId, update, at }) => inView(state, taskId, 'acp_update', { update, at }),

    task_end: (state, { taskId, stopReason, at }) => {
      const task = state.tasks.list.find((entry) => entry.id === taskId)
      if (!task) return state
      const status = ENDED[stopReason] ?? 'done'
      const view = handlers.turn_end(task.view, { stopReason, at })
      const list = state.tasks.list.map((entry) => (entry.id === taskId ? { ...entry, view, status, now: null, endedAt: at } : entry))
      const undo = state.tasks.undo?.taskId === taskId ? null : state.tasks.undo
      const report = { taskId, title: task.title, status, preview: previewOf(view), shown: false }
      const reports = [...state.tasks.reports.filter((entry) => entry.taskId !== taskId), report]
      return withTasks(state, { list, undo, finished: { taskId, title: task.title, status }, reports })
    },

    tasks_unfinished: (state, { list }) => withTasks(state, { unfinished: list }),
    task_forgotten: (state, { taskId }) => withTasks(state, { unfinished: state.tasks.unfinished.filter((entry) => entry.id !== taskId) }),
    /** Taken up again after a relaunch: it goes on as a task in the background, with what it had said. */
    task_resumed: (state, { task, messages, at }) => withTasks(state, {
      unfinished: state.tasks.unfinished.filter((entry) => entry.id !== task.id),
      list: [...state.tasks.list.filter((entry) => entry.id !== task.id),
        settled({ ...task, startedAt: at, endedAt: null, status: 'running', now: null, view: takenUpView(messages, at) })],
    }),

    task_report_shown: (state, { taskId }) => withTasks(state, {
      reports: state.tasks.reports.map((entry) => (entry.taskId === taskId ? { ...entry, shown: true } : entry)),
    }),
    task_report_dismissed: (state, { taskId }) => withTasks(state, { reports: state.tasks.reports.filter((entry) => entry.taskId !== taskId) }),

    /** 「#name …」: words into that task's turn (task-ipc.js task:steer), shown in its part of the conversation. */
    task_steer: (state, { taskId, text, at }) => inView(state, taskId, 'user_steer', { text, via: null, at }),

    /** The island has said the task ended. */
    task_finish_seen: (state, { taskId }) => (state.tasks.finished?.taskId === taskId ? withTasks(state, { finished: null }) : state),

    task_question: (state, { taskId, questionId, questions, at }) => inView(state, taskId, 'question_request', { questionId, questions, at }),
    task_question_closed: (state, { taskId, questionId, at }) => inView(state, taskId, 'question_closed', { questionId, at }),

    /** Undone: the turn is the conversation on screen again, with all it said since, still running. */
    task_undone: (state, { taskId, conversationId, info }) => {
      const task = state.tasks.list.find((entry) => entry.id === taskId)
      if (!task) return state
      return {
        ...state,
        ...task.view,
        messages: [...state.tasks.undo?.prefix ?? [], ...task.view.messages].map((m, i) => ({ ...m, id: `m${i}` })),
        timeline: [...state.tasks.undo?.timeline ?? [], ...task.view.timeline],
        conversationId,
        info: { ...state.info, ...info },
        folds: [],
        tasks: { ...state.tasks, list: state.tasks.list.filter((entry) => entry.id !== taskId), undo: null, flip: false },
      }
    },

    task_closed: (state, { taskId }) => ({
      ...withTasks(state, {
        list: state.tasks.list.filter((task) => task.id !== taskId),
        finished: state.tasks.finished?.taskId === taskId ? null : state.tasks.finished,
        reports: state.tasks.reports.filter((entry) => entry.taskId !== taskId),
      }),
      drawer: state.drawer === taskTab(taskId) ? 'trace' : state.drawer,
    }),
  }
}

/** Picking for a task's question, and answering it: the window names the task (app.js). */
const ASKED_OF_TASK = new Set(['question_pick', 'question_answered'])

/**
 * A permission request or answer, or a pick or answer for a question, that belongs to a task: into its view
 * instead of the conversation's.
 * @returns {object | null} the state, or null when the action is the conversation's own
 */
export function routeToTask(state, action, handlers) {
  if (ASKED_OF_TASK.has(action.type) && action.taskId) {
    return mapTask(state, action.taskId, (task) => ({ ...task, view: handlers[action.type](task.view, action) }))
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
