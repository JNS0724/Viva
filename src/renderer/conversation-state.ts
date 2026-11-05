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
export const initialConversation = Object.freeze({
  /** idle; working on a turn; waiting on a permission; asking a question; or stopped by an error. */
  phase: 'idle' as 'idle' | 'working' | 'waiting' | 'asking' | 'error',
  messages: [] as ThreadMessage[],
  thoughts: [] as Untyped[],
  tools: {} as Record<string, ToolCall>,
  timeline: [] as Untyped[],
  permission: null as Untyped,
  /** A question the agent is waiting on (question-state.ts). */
  question: null as Untyped,
  /** Keys a server set up from the conversation waits for (secret-state.ts): which server, which names. */
  secret: null as Untyped,
  turn: null as Untyped,
  lastReceipt: null as Untyped,
  error: null as Untyped,
  usage: null as Untyped,
})

type ConversationHandler = (view: ConversationView, action: Action) => ConversationView

const TOOL_FIELDS = ['title', 'kind', 'status', 'locations', 'rawInput']

/** An update from the agent (ACP session/update), as the window gets it: its kind, and what each kind carries. */
type AcpUpdate = { sessionUpdate?: string, [field: string]: any }

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

function onMessageChunk(view: ConversationView, update: AcpUpdate): ConversationView {
  const chunk = contentText(update.content)
  if (!chunk) return view
  const { list } = appendStream(view.messages, chunk, (i): ThreadMessage => ({
    id: `m${i}`, role: 'assistant', text: chunk, shown: 0, open: true, receipt: null,
  }))
  return { ...view, thoughts: closeLast(view.thoughts), messages: list }
}

function onThoughtChunk(view: ConversationView, update: AcpUpdate, at: number): ConversationView {
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

function mergeTool(existing: ToolCall | undefined, update: AcpUpdate, at: number): ToolCall {
  const base = existing ?? { id: update.toolCallId, title: t("state.tool.call"), kind: 'other', status: 'pending', locations: [], at }
  const changes = Object.fromEntries(
    TOOL_FIELDS.filter((key) => update[key] !== undefined && update[key] !== null).map((key) => [key, update[key]]),
  )
  return { ...base, ...changes }
}

function onToolUpdate(view: ConversationView, update: AcpUpdate, at: number): ConversationView {
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

const UPDATE_HANDLERS: Readonly<Record<string, (view: ConversationView, update: AcpUpdate, at: number) => ConversationView>> = {
  viva_stream: assistantStream,
  agent_message_chunk: onMessageChunk,
  agent_thought_chunk: onThoughtChunk,
  tool_call: onToolUpdate,
  tool_call_update: onToolUpdate,
  usage_update: (view, update) => ({ ...view, usage: { used: update.used, size: update.size } }),
}

function attachReceipt(messages: readonly ThreadMessage[], receipt: Receipt): ThreadMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') return [...messages.slice(0, -1), { ...last, receipt }]
  const text = receipt.stopReason === 'cancelled' ? t("state.this.turn.was.stopped") : t("state.no.text.response.this.turn")
  return [...messages, { id: `m${messages.length}`, role: 'note', text, open: false, receipt }]
}

/** The conversation's own actions: what is said, asked and done in it, and how its turns go. */
export const CONVERSATION_ACTIONS: Readonly<Record<string, ConversationHandler>> = {
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
    const handler = UPDATE_HANDLERS[update?.sessionUpdate]
    return handler ? handler(view, update, at) : view
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

  /**
   * What the conversation waits on the user for, read when the window opened on a dsh at work (a reload): each one not
   * shown yet is shown as when it was asked, so it can be answered; one shown already (it came live meanwhile) once.
   */
  waits_restored: (view, { permissions = [], questions = [], at }) => {
    const asked = (permissions as Action[]).reduce<ConversationView>((current, wait) => (current.permission?.requestId === wait.requestId
      ? current : CONVERSATION_ACTIONS.permission_request(current, { ...wait, type: 'permission_request', at })), view)
    return (questions as Action[]).reduce<ConversationView>((current, wait) => (current.question?.questionId === wait.questionId
      ? current : CONVERSATION_ACTIONS.question_request(current, { ...wait, type: 'question_request', at })), asked)
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
}

/**
 * The conversation `view` after `action`; the same view for an action not its own. A view with more to it (the
 * window's state) comes back with the rest as it was, since each handler spreads the view it is given.
 */
export function reduceConversation<V extends ConversationView>(view: V, action: Action): V {
  const handler = CONVERSATION_ACTIONS[action?.type ?? '']
  return handler ? handler(view, action) as V : view
}
