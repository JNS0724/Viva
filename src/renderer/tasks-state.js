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

/** Said to go on with what runs: 「顺便」「再」「改成」… */
const GOES_ON = /^(顺便|再|还要|还有|另外|也|并且|然后|接着|改成|换成|别|不要|加上|补充|记得|继续|等等)/
const pairsOf = (text) => {
  const letters = [...text.replace(/[\s\p{P}\p{S}]+/gu, '')]
  return new Set(letters.slice(1).map((letter, i) => `${letters[i]}${letter}`))
}

/**
 * Where words typed while a turn runs would go: 'into' the turn (the viva-steer plugin) when they are about
 * the same thing — they say so, or share words with what started it — else on their own ('other'), the turn
 * moving to the background. Tab turns it round. null when nothing runs.
 */
export function routeOf(state, text) {
  const target = spinOffTarget(state)
  if (!target || !text.trim()) return null
  const asked = pairsOf(target.words)
  const shares = [...pairsOf(text)].some((pair) => asked.has(pair))
  const auto = GOES_ON.test(text.trim()) || shares ? 'into' : 'other'
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
      const entry = settled({ ...task, startedAt: state.turn?.startedAt ?? at, endedAt: null, status: 'running', now: null, view: { ...viewOf(state), messages: state.messages.slice(from) } })
      const going = handlers.rewound(state, { conversation, info, folds })
      return { ...going, tasks: { list: [...state.tasks.list, entry], undo: { taskId: task.id, prefix: going.messages, text }, flip: false } }
    },

    task_update: (state, { taskId, update, at }) => inView(state, taskId, 'acp_update', { update, at }),

    task_end: (state, { taskId, stopReason, at }) => {
      const ended = withTasks(state, {
        list: state.tasks.list.map((task) => (task.id === taskId
          ? { ...task, view: handlers.turn_end(task.view, { stopReason, at }), status: ENDED[stopReason] ?? 'done', now: null, endedAt: at }
          : task)),
      })
      return state.tasks.undo?.taskId === taskId ? withTasks(ended, { undo: null }) : ended
    },

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
        conversationId,
        info: { ...state.info, ...info },
        folds: [],
        tasks: { list: state.tasks.list.filter((entry) => entry.id !== taskId), undo: null, flip: false },
      }
    },

    task_closed: (state, { taskId }) => withTasks(state, { list: state.tasks.list.filter((task) => task.id !== taskId) }),
  }
}

/**
 * A permission request or answer that belongs to a task: into its view instead of the conversation's.
 * @returns {object | null} the state, or null when the action is the conversation's own
 */
export function routeToTask(state, action, handlers) {
  if (action.type === 'permission_request' && action.taskId) {
    return mapTask(state, action.taskId, (task) => ({ ...task, view: handlers.permission_request(task.view, action) }))
  }
  if (action.type === 'permission_resolved' && state.permission?.requestId !== action.requestId) {
    const owner = state.tasks.list.find((task) => task.view.permission?.requestId === action.requestId)
    if (owner) return mapTask(state, owner.id, (task) => ({ ...task, view: handlers.permission_resolved(task.view, action) }))
  }
  return null
}
