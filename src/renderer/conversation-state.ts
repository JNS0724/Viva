import type { ConversationState, ConversationUpdate, ConversationHandlers, ConversationAction } from './conversation-types.ts'
import { t } from '../shared/i18n/translate.ts'
import { isSilentReply } from '../shared/task-report.ts'
import { approvalTitle, optionName } from './approval.ts'
import { assistantStream } from './assistant-stream.ts'
import { QUESTION_ACTIONS } from './question-state.ts'
import { closeLast, closeStreams } from './streams.ts'

/**
 * One conversation as it is reduced (system-design §11.3): what was said and done in it, and where its turn is.
 * The conversation on screen is one (state.ts keeps it among the window's state), and so is each background task's
 * (tasks-state.ts `view`). Pure and immutable: every handler returns the view it was given spread with what changed,
 * so a view with more to it (the window's state) keeps the rest; none reads or writes anything else.
 */
export const initialConversation: Readonly<ConversationState> = Object.freeze({
  phase: 'idle', messages: [], thoughts: [], tools: {}, timeline: [], permission: null, question: null,
  secret: null, turn: null, lastReceipt: null, error: null, usage: null,
})

const TOOL_FIELDS = ['title', 'kind', 'status', 'locations', 'rawInput'] as const

/** An update from the agent (ACP session/update), as the window gets it: its kind, and what each kind carries. */
type AcpUpdate = ConversationUpdate

function contentText(content: { type: string, text?: string } | null | undefined) {
  if (!content) return ''
  if (content.type === 'text') return content.text ?? ''
  return `[${content.type}]`
}

function appendStream<T extends { open?: boolean, text: string }>(list: readonly T[], chunk: string, makeItem: (index: number) => T): { list: T[], created: T | null } {
  const last = list[list.length - 1]
  if (last?.open) return { list: [...list.slice(0, -1), { ...last, text: last.text + chunk }], created: null }
  const item = makeItem(list.length)
  return { list: [...list, item], created: item }
}

const bumpTurn = (turn: ConversationView['turn'], key: 'tools' | 'thoughts') => (turn ? { ...turn, [key]: turn[key] + 1 } : turn)

function onMessageChunk(view: ConversationView, update: Extract<AcpUpdate, { sessionUpdate: 'agent_message_chunk' }>): ConversationView {
  const chunk = contentText(update.content)
  if (!chunk) return view
  const { list } = appendStream(view.messages, chunk, (i): ThreadMessage => ({
    id: `m${i}`, role: 'assistant', text: chunk, shown: 0, open: true, receipt: null,
  }))
  return { ...view, thoughts: closeLast(view.thoughts), messages: list }
}

function onThoughtChunk(view: ConversationView, update: Extract<AcpUpdate, { sessionUpdate: 'agent_thought_chunk' }>, at: number): ConversationView {
  const chunk = contentText(update.content)
  if (!chunk) return view
  const { list, created } = appendStream(view.thoughts, chunk, (i: number) => ({ id: `t${i}`, text: chunk, open: true, at }))
  return {
    ...view,
    messages: closeLast(view.messages),
    thoughts: list,
    timeline: created ? [...view.timeline, { kind: 'thought', ref: created.id, at }] : view.timeline,
    turn: created ? bumpTurn(view.turn, 'thoughts') : view.turn,
  }
}

function mergeTool(existing: ToolCall | undefined, update: Extract<AcpUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>, at: number): ToolCall {
  const base = existing ?? { id: update.toolCallId, title: t("state.tool.call"), kind: 'other', status: 'pending', locations: [], at }
  const changes = Object.fromEntries(
    TOOL_FIELDS.filter((key) => update[key] !== undefined && update[key] !== null).map((key) => [key, update[key]]),
  )
  return { ...base, ...changes }
}

function onToolUpdate(view: ConversationView, update: Extract<AcpUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>, at: number): ConversationView {
  if (!update.toolCallId) return view
  const closed = closeStreams(view)
  const existing = closed.tools[update.toolCallId]
  return {
    ...closed,
    tools: { ...closed.tools, [update.toolCallId]: mergeTool(existing, update, at) },
    timeline: existing ? closed.timeline : [...closed.timeline, { kind: 'tool', ref: update.toolCallId, at }],
    turn: existing ? closed.turn : bumpTurn(closed.turn, 'tools'),
  }
}

function updateConversation(view: ConversationView, update: AcpUpdate, at: number): ConversationView {
  switch (update.sessionUpdate) {
    case 'viva_stream': return assistantStream(view, update, at)
    case 'agent_message_chunk': return onMessageChunk(view, update)
    case 'agent_thought_chunk': return onThoughtChunk(view, update, at)
    case 'tool_call': case 'tool_call_update': return onToolUpdate(view, update, at)
    case 'usage_update': return { ...view, usage: { used: update.used, size: update.size } }
    // These protocol updates do not contribute to this conversation view.
    case 'user_message_chunk': case 'plan': case 'plan_update': case 'plan_removed':
    case 'available_commands_update': case 'current_mode_update': case 'config_option_update':
    case 'session_info_update': case 'notice': case 'compaction_update': case 'compaction_summary_chunk':
    case 'subagent_update': case 'session_message': case 'session_message_chunk': return view
    default: { const exhaustive: never = update; return exhaustive }
  }
}

function attachReceipt(messages: readonly ThreadMessage[], receipt: Receipt): ThreadMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') return [...messages.slice(0, -1), { ...last, receipt }]
  const text = receipt.stopReason === 'cancelled' ? t("state.this.turn.was.stopped") : t("state.no.text.response.this.turn")
  return [...messages, { id: `m${messages.length}`, role: 'note', text, open: false, receipt }]
}

/** The conversation's own actions: what is said, asked and done in it, and how its turns go. */
export const CONVERSATION_ACTIONS = {
  user_prompt: (view, { text, at, via = null, images = [] }) => {
    const closed = closeStreams(view)
    const message = {
      id: `m${closed.messages.length}`, role: 'user', text, open: false, receipt: null, ...(via ? { via } : {}), ...(images.length ? { images } : {}),
    }
    return { ...closed, phase: 'working', error: null, messages: [...closed.messages, message], turn: { startedAt: at, tools: 0, thoughts: 0 } }
  },

  /**
   * A turn the app started, not the user: a background task ended and its result comes back (backend/task-reports.ts).
   * The conversation works as for any turn, with no words of the user's.
   */
  agent_turn_started: (view, { by = null, at }) => ({
    ...closeStreams(view),
    phase: 'working',
    error: null,
    turn: { startedAt: at, tools: 0, thoughts: 0, ...(by ? { by } : {}) },
  }),

  /**
   * Said while the agent works (viva-steer): into the thread at once, the turn going on. What the agent was
   * writing closes, so its reply to these words starts below them.
   */
  user_steer: (view, { text, via = null }) => {
    const closed = closeStreams(view)
    const message = { id: `m${closed.messages.length}`, role: 'user', text, open: false, receipt: null, steered: true, ...(via ? { via } : {}) }
    return { ...closed, messages: [...closed.messages, message] }
  },

  /** The words could not reach the agent: they stay in the thread, marked as not sent. */
  steer_failed: (view, { id }) => ({
    ...view,
    messages: view.messages.map((message) => (message.id === id ? { ...message, failed: true } : message)),
  }),

  acp_update: (view, { update, at }) => {
    return updateConversation(view, update, at)
  },

  /** dsh names only the tool call; what it does comes from that call, announced just before (approval.js). */
  permission_request: (view, { requestId, toolCall, options, at }) => {
    const known = toolCall?.toolCallId ? view.tools[toolCall.toolCallId] : null
    const title = toolCall?.title || approvalTitle(known) || t("selectors.needs.your.approval")
    return {
      ...closeStreams(view),
      phase: 'waiting',
      permission: {
        requestId,
        title,
        kind: toolCall?.kind ?? known?.kind ?? 'other',
        toolCallId: toolCall?.toolCallId ?? null,
        rawInput: toolCall?.rawInput ?? known?.rawInput ?? null,
        options: Array.isArray(options) ? options : [],
      },
      timeline: [...view.timeline, { kind: 'permission', ref: requestId, at, title }],
    }
  },

  permission_resolved: (view, { requestId, optionId, at }) => {
    if (view.permission?.requestId !== requestId) return view
    const option = view.permission.options.find((o: PermissionOption) => o.optionId === optionId)
    return {
      ...view,
      phase: 'working',
      permission: null,
      timeline: [...view.timeline, {
        kind: 'decision',
        ref: requestId,
        at,
        title: view.permission.title,
        allowed: Boolean(option?.kind?.startsWith('allow')),
        choice: option ? optionName(option) : t("state.canceled"),
      }],
    }
  },

  permission_closed: (view, { requestId }) => view.permission?.requestId !== requestId ? view : ({ ...view, permission: null, phase: view.phase === 'waiting' ? 'working' : view.phase }),

  turn_end: (view, { stopReason, at }) => {
    const closed = closeStreams(view)
    const turn = closed.turn ?? { startedAt: at, tools: 0, thoughts: 0 }
    const receipt = { ms: Math.max(0, at - turn.startedAt), tools: turn.tools, thoughts: turn.thoughts, stopReason }
    const ended = { ...closed, phase: 'idle' as const, permission: null, question: null, secret: null, turn: null, lastReceipt: receipt }
    // A task's result the model had nothing to add to: the turn leaves nothing in the conversation.
    if (turn.by === 'task') {
      const last = closed.messages.at(-1)
      const silent = !last || last.role !== 'assistant' || isSilentReply(last.text)
      if (silent) return { ...ended, messages: last?.role === 'assistant' ? closed.messages.slice(0, -1) : closed.messages }
    }
    return { ...ended, messages: attachReceipt(closed.messages, receipt) }
  },

  error: (view, { message }) => ({
    ...closeStreams(view),
    phase: 'error',
    error: message || t("state.unknown.error"),
    permission: null,
    question: null,
    secret: null,
    turn: null,
  }),

  ...QUESTION_ACTIONS,
} satisfies ConversationHandlers

/**
 * The conversation `view` after `action`; the same view for an action not its own. A view with more to it (the
 * window's state) comes back with the rest as it was, since each handler spreads the view it is given.
 */
export function reduceConversation<V extends ConversationView>(view: V, action: ConversationAction): V {
  // The key and payload are correlated by ConversationAction; lookup cannot express that correlation.
  const handlers: ConversationHandlers = CONVERSATION_ACTIONS
  const handler = handlers[action.type] as ((view: ConversationView, action: ConversationAction) => ConversationView) | undefined
  return handler ? handler(view, action) as V : view
}

export function isConversationAction(action: Action): action is ConversationAction {
  return Object.hasOwn(CONVERSATION_ACTIONS, action.type)
}
