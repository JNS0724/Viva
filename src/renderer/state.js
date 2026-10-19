import { HISTORY_ACTIONS, initialHistory } from './history-state.js'
import { initialModels, MODEL_ACTIONS } from './model-state.js'
import { QUESTION_ACTIONS } from './question-state.js'
import { closeLast, closeStreams } from './streams.js'
import { initialExtensions, initialMemory, PERSONAL_ACTIONS } from './personal-state.js'

/**
 * Pure, immutable conversation state. ACP updates go in; the views read it out.
 * Thoughts and tool calls live in `timeline` (shown in the drawer), never in `messages`.
 */
export const initialState = Object.freeze({
  info: { mode: 'connecting', model: '', cwd: '', reason: '' },
  phase: 'idle',
  messages: [],
  thoughts: [],
  tools: {},
  timeline: [],
  permission: null,
  /** A question the agent is waiting on (question-state.js). */
  question: null,
  turn: null,
  lastReceipt: null,
  drawer: null,
  island: false,
  picker: false,
  error: null,
  usage: null,
  /** Set when the thread opened with saved messages: how many there are and when they were saved. */
  restored: null,
  /** Id of the conversation on screen once it is in the history (null for a new, unsaved one). */
  conversationId: null,
  /** Trace of the restored messages, read back from dsh's logs: null | 'loading' | 'loaded' | 'unavailable'. */
  restoredTrace: null,
  history: initialHistory,
  memory: initialMemory,
  extensions: initialExtensions,
  models: initialModels,
  toast: null,
  /** A new or reopened conversation is on its way; sending now would land in the one being replaced. */
  switching: false,
  settings: {
    open: false,
    loaded: false,
    hasKey: false,
    keyHint: '',
    source: null,
    encryptionAvailable: true,
    busy: false,
    error: null,
    notice: null,
  },
})

const TOOL_FIELDS = ['title', 'kind', 'status', 'locations', 'rawInput']
/** Typewriter pace for assistant text; speeds up so the display never trails the agent by more than ~1.2 s. */
const REVEAL_BASE_CPS = 90
const REVEAL_MAX_LAG_S = 1.2

/**
 * @param {number} shown characters already on screen
 * @param {number} length characters received so far
 * @param {number} dtMs time since the previous frame
 * @returns {number} characters to show after this frame
 */
export function revealStep(shown, length, dtMs) {
  if (shown >= length) return length
  const cps = Math.max(REVEAL_BASE_CPS, (length - shown) / REVEAL_MAX_LAG_S)
  return Math.min(length, shown + Math.max(1, Math.round((cps * dtMs) / 1000)))
}

const isRevealingMessage = (m) => m.role === 'assistant' && m.shown < m.text.length

/** @returns {boolean} whether some assistant text is still being typed out */
export const isRevealing = (state) => state.messages.some(isRevealingMessage)

function contentText(content) {
  if (!content) return ''
  if (content.type === 'text') return content.text ?? ''
  return `[${content.type}]`
}

function appendStream(list, chunk, makeItem) {
  const last = list[list.length - 1]
  if (last?.open) return { list: [...list.slice(0, -1), { ...last, text: last.text + chunk }], created: null }
  const item = makeItem(list.length)
  return { list: [...list, item], created: item }
}

const bumpTurn = (turn, key) => (turn ? { ...turn, [key]: turn[key] + 1 } : turn)

function onMessageChunk(state, update) {
  const chunk = contentText(update.content)
  if (!chunk) return state
  const { list } = appendStream(state.messages, chunk, (i) => ({
    id: `m${i}`, role: 'assistant', text: chunk, shown: 0, open: true, receipt: null,
  }))
  return { ...state, thoughts: closeLast(state.thoughts), messages: list }
}

function onThoughtChunk(state, update, at) {
  const chunk = contentText(update.content)
  if (!chunk) return state
  const { list, created } = appendStream(state.thoughts, chunk, (i) => ({ id: `t${i}`, text: chunk, open: true, at }))
  return {
    ...state,
    messages: closeLast(state.messages),
    thoughts: list,
    timeline: created ? [...state.timeline, { kind: 'thought', ref: created.id, at }] : state.timeline,
    turn: created ? bumpTurn(state.turn, 'thoughts') : state.turn,
  }
}

function mergeTool(existing, update, at) {
  const base = existing ?? { id: update.toolCallId, title: '工具调用', kind: 'other', status: 'pending', locations: [], at }
  const changes = Object.fromEntries(
    TOOL_FIELDS.filter((key) => update[key] !== undefined && update[key] !== null).map((key) => [key, update[key]]),
  )
  return { ...base, ...changes }
}

function onToolUpdate(state, update, at) {
  if (!update.toolCallId) return state
  const closed = closeStreams(state)
  const existing = closed.tools[update.toolCallId]
  return {
    ...closed,
    tools: { ...closed.tools, [update.toolCallId]: mergeTool(existing, update, at) },
    timeline: existing ? closed.timeline : [...closed.timeline, { kind: 'tool', ref: update.toolCallId, at }],
    turn: existing ? closed.turn : bumpTurn(closed.turn, 'tools'),
  }
}

const UPDATE_HANDLERS = {
  agent_message_chunk: onMessageChunk,
  agent_thought_chunk: onThoughtChunk,
  tool_call: onToolUpdate,
  tool_call_update: onToolUpdate,
  usage_update: (state, update) => ({ ...state, usage: { used: update.used, size: update.size } }),
}

function attachReceipt(messages, receipt) {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') return [...messages.slice(0, -1), { ...last, receipt }]
  const text = receipt.stopReason === 'cancelled' ? '已停止本轮任务。' : '本轮没有文字回复。'
  return [...messages, { id: `m${messages.length}`, role: 'note', text, open: false, receipt }]
}

const ACTION_HANDLERS = {
  ready: (state, { info }) => ({
    ...state,
    info,
    phase: state.phase === 'error' ? 'idle' : state.phase,
    error: state.phase === 'error' ? null : state.error,
  }),

  user_prompt: (state, { text, at }) => {
    const closed = closeStreams(state)
    const message = { id: `m${closed.messages.length}`, role: 'user', text, open: false, receipt: null }
    return {
      ...closed,
      phase: 'working',
      error: null,
      island: false,
      messages: [...closed.messages, message],
      turn: { startedAt: at, tools: 0, thoughts: 0 },
    }
  },

  acp_update: (state, { update, at }) => {
    const handler = UPDATE_HANDLERS[update?.sessionUpdate]
    return handler ? handler(state, update, at) : state
  },

  permission_request: (state, { requestId, toolCall, options, at }) => {
    const title = toolCall?.title || '需要你确认'
    return {
      ...closeStreams(state),
      phase: 'waiting',
      permission: {
        requestId,
        title,
        kind: toolCall?.kind ?? 'other',
        toolCallId: toolCall?.toolCallId ?? null,
        rawInput: toolCall?.rawInput ?? null,
        options: Array.isArray(options) ? options : [],
      },
      timeline: [...state.timeline, { kind: 'permission', ref: requestId, at, title }],
    }
  },

  permission_resolved: (state, { requestId, optionId, at }) => {
    if (state.permission?.requestId !== requestId) return state
    const option = state.permission.options.find((o) => o.optionId === optionId)
    return {
      ...state,
      phase: 'working',
      permission: null,
      timeline: [...state.timeline, {
        kind: 'decision',
        ref: requestId,
        at,
        title: state.permission.title,
        allowed: Boolean(option?.kind?.startsWith('allow')),
        choice: option?.name ?? '已取消',
      }],
    }
  },

  turn_end: (state, { stopReason, at }) => {
    const closed = closeStreams(state)
    const turn = closed.turn ?? { startedAt: at, tools: 0, thoughts: 0 }
    const receipt = { ms: Math.max(0, at - turn.startedAt), tools: turn.tools, thoughts: turn.thoughts, stopReason }
    return {
      ...closed,
      phase: 'idle',
      permission: null,
      question: null,
      turn: null,
      lastReceipt: receipt,
      messages: attachReceipt(closed.messages, receipt),
    }
  },

  error: (state, { message }) => ({
    ...closeStreams(state),
    switching: false,
    phase: 'error',
    error: message || '未知错误',
    permission: null,
    question: null,
    turn: null,
  }),

  /** A saved conversation, shown fully typed out; ignored once a new conversation has started. */
  history_loaded: (state, { conversationId = null, messages, savedAt }) => {
    if (state.messages.length > 0 || !messages?.length) return state
    return {
      ...state,
      conversationId,
      restoredTrace: 'loading',
      messages: messages.map((m, i) => ({
        id: `m${i}`, role: m.role, text: m.text, shown: m.text.length, open: false, receipt: m.receipt ?? null, restored: true,
      })),
      restored: { count: messages.length, savedAt },
    }
  },

  session_switching: (state) => ({ ...state, switching: true, picker: false }),
  session_switch_failed: (state) => ({ ...state, switching: false }),

  /**
   * What the memory plugin put in front of the model this turn, reported when the turn ends. Each entry
   * goes where its time puts it in the trace, ahead of the steps it informed.
   */
  memory_context: (state, { injected }) => {
    const entries = (injected ?? []).map((injection, i) => ({ kind: 'memory', ref: `memory-${injection.at}-${i}`, at: injection.at, injection }))
    if (entries.length === 0) return state
    const timeline = [...state.timeline, ...entries].sort((a, b) => a.at - b.at)
    return { ...state, timeline }
  },

  conversation_saved: (state, { id }) => (state.conversationId === id ? state : { ...state, conversationId: id }),

  new_session: (state, { info }) => ({
    ...initialState,
    info: info ?? state.info,
    drawer: state.drawer,
    settings: state.settings,
    history: state.history,
    memory: state.memory,
    extensions: state.extensions,
    toast: state.toast,
  }),

  /** Picked from the history panel: start over with that conversation's messages and close the panel. */
  conversation_opened: (state, { conversation, info }) => ACTION_HANDLERS.history_loaded(
    { ...ACTION_HANDLERS.new_session(state, { info }), history: { ...state.history, open: false, menuFor: null, renaming: null } },
    { conversationId: conversation.id, messages: conversation.messages, savedAt: conversation.updatedAt },
  ),

  /** Restored trace goes first: it happened before anything the live session has added since. */
  trace_restored: (state, { conversationId, trace, available }) => {
    if (conversationId !== state.conversationId) return state
    if (!available) return { ...state, restoredTrace: 'unavailable' }
    return {
      ...state,
      restoredTrace: 'loaded',
      thoughts: [...trace.thoughts, ...state.thoughts],
      tools: { ...trace.tools, ...state.tools },
      timeline: [...trace.timeline, ...state.timeline],
    }
  },
  reveal_tick: (state, { dt }) => (isRevealing(state)
    ? {
      ...state,
      messages: state.messages.map((m) => (isRevealingMessage(m) ? { ...m, shown: revealStep(m.shown, m.text.length, dt) } : m)),
    }
    : state),
  config_applied: (state, { info }) => ({ ...state, info: { ...state.info, ...info } }),
  picker_toggle: (state) => ({ ...state, picker: !state.picker, island: false }),
  picker_close: (state) => (state.picker ? { ...state, picker: false } : state),
  settings_open: (state) => ({ ...state, island: false, settings: { ...state.settings, open: true, error: null, notice: null } }),
  settings_close: (state) => ({ ...state, settings: { ...state.settings, open: false } }),
  settings_loaded: (state, { view }) => ({ ...state, settings: { ...state.settings, ...view, loaded: true } }),
  settings_busy: (state) => ({ ...state, settings: { ...state.settings, busy: true, error: null, notice: null } }),
  settings_failed: (state, { message }) => ({ ...state, settings: { ...state.settings, busy: false, error: message } }),
  settings_saved: (state, { view, notice }) => ({
    ...state, settings: { ...state.settings, ...view, loaded: true, busy: false, error: null, notice },
  }),
  open_drawer: (state, { tab }) => ({ ...state, drawer: tab, island: false }),
  close_drawer: (state) => ({ ...state, drawer: null }),
  toggle_drawer: (state) => ({ ...state, drawer: state.drawer ? null : 'trace' }),
  toggle_island: (state) => ({ ...state, island: !state.island }),
  close_island: (state) => (state.island ? { ...state, island: false } : state),
  ...HISTORY_ACTIONS,
  ...PERSONAL_ACTIONS,
  ...MODEL_ACTIONS,
  ...QUESTION_ACTIONS,
}

/**
 * @param {typeof initialState} state
 * @param {{ type: string, [key: string]: unknown }} action
 * @returns {typeof initialState}
 */
export function reduce(state, action) {
  const handler = ACTION_HANDLERS[action?.type]
  return handler ? handler(state, action) : state
}

/** @param {typeof initialState} state */
export const isBusy = (state) => state.phase === 'working' || state.phase === 'waiting' || state.phase === 'asking'
