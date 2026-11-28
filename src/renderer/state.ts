import { handleAction, type ActionHandlers, type PayloadFor } from './action-types.ts'
import { t } from '../shared/i18n/translate.ts'
import { retainedMessagePositions, retainedMessageBoundary } from '../shared/message-order.ts'
import { CONVERSATION_WINDOW_MESSAGES } from '../shared/renderer-sync.ts'
import { CONVERSATION_ACTIONS, initialConversation, reduceConversation, isConversationAction } from './conversation-state.ts'
import { EARLIER_ACTIONS, initialEarlier, withCurrentKept } from './earlier-state.ts'
import { recordsFrom, REPORT_ACTIONS } from './report-state.ts'
import { FILES_ACTIONS, initialFiles } from './files-state.ts'
import { HISTORY_ACTIONS, initialHistory } from './history-state.ts'
import { REVIEW_ACTIONS, initialReview } from './review-state.ts'
import { RESUME_ACTIONS, initialResume } from './resume-state.ts'
import { closeHub, hubPage, initialHub, oneHubPage } from './hub-state.ts'
import { initialModels, MODEL_ACTIONS } from './model-state.ts'
import { initialPlugins, PLUGIN_ACTIONS } from './plugins-state.ts'
import { initialRewind, rewindActions } from './rewind-state.ts'
import { initialSchedules, SCHEDULES_ACTIONS } from './schedules-state.ts'
import { initialTasks, routeToTask, taskActions, toldByRecords } from './tasks-state.ts'
import { SECRET_ACTIONS } from './secret-state.ts'
import { WAITS_ACTIONS } from './waits-state.ts'
import { PROPOSAL_ACTIONS } from './proposal-state.ts'
import { CAPABILITY_ACTIONS, initialCapabilities } from './capabilities-state.ts'
import { initialImportFlow, IMPORT_FLOW_ACTIONS } from './import-flow-state.ts'
import { initialWorkDir, WORKDIR_ACTIONS } from './workdir-state.ts'
import { initialTopic } from './topics.ts'
import { initialExtensions, initialMemory, PERSONAL_ACTIONS } from './personal-state.ts'
import { MEMORY_FILE_ACTIONS } from './memory-file-state.ts'
import { initialDiagnostics, DIAGNOSTICS_ACTIONS } from './diagnostics-state.ts'
import { initialTheme, THEME_ACTIONS } from './theme-state.ts'

function removeRestoredTrace(state: State): State {
  const restored = state.restoredTraceData
  if (!restored) return state
  const thoughts = new Set(restored.thoughts), timeline = new Set(restored.timeline)
  return { ...state, restoredTraceData: null,
    thoughts: state.thoughts.filter(item => !thoughts.has(item)),
    tools: Object.fromEntries(Object.entries(state.tools).filter(([id, tool]) => restored.tools[id] !== tool)),
    modelCalls: Object.fromEntries(Object.entries(state.modelCalls).filter(([id, model]) => restored.modelCalls[id] !== model)),
    timeline: state.timeline.filter(item => !timeline.has(item)),
  }
}

/**
 * Pure, immutable conversation state. ACP updates go in; the views read it out.
 * Thoughts and tool calls live in `timeline` (shown in the drawer), never in `messages`.
 */
export const initialState = Object.freeze({
  initialization: Object.freeze({ status: 'ready' as 'loading' | 'ready' | 'failed', reason: null as import('./initialization-actions.ts').InitializationFailure | null }),
  info: { mode: 'connecting', model: '', cwd: '', reason: '' } as AgentInfo,
  /** idle; working on a turn; waiting on a permission; asking a question; or stopped by an error. */
  /** The conversation on screen: what was said and done, and where its turn is (conversation-state.ts). */
  ...initialConversation,
  /** Number of persisted messages in the active segment before `messages[0]` (windowed load or sliding trim). */
  historyOffset: 0,
  /** Background tasks' results the model read, each drawn after the messages before it (report-state.ts). */
  records: [] as readonly ReportRecord[],
  drawer: null as string | null,
  island: false,
  picker: false,
  /** Set when the thread opened with saved messages: how many there are and when they were saved. */
  restored: null as Untyped,
  /** Id of the conversation on screen once it is in the history (null for a new, unsaved one). */
  conversationId: null as string | null,
  /** Trace of the restored messages, read back from dsh's logs: null | 'loading' | 'loaded' | 'unavailable'. */
  restoredTrace: null as 'loading' | 'loaded' | 'unavailable' | null,
  restoredTraceData: null as PayloadFor<'trace_restored'>['trace'],
  traceRevision: 0,
  traceDetail: null as null | { key: string, conversationId: string, loading: boolean, request: import('../shared/trace.ts').ModelCallDetail | null, error: string | null },
  history: initialHistory,
  /** 回顾 on the 搜索 page: the timeline by day, filtered, a topic read in place, the stars (review-state.ts). */
  review: initialReview,
  /** 搜索, 关于你 and 设置 share one page over the conversation: the one it opens on next (hub-state.js). */
  hub: initialHub,
  /** The one timeline: the segments before the one on screen (earlier-state.js). */
  earlier: initialEarlier,
  /** The working directory: the chip under the input, its menu, the confirmation (workdir-state.js). */
  workDir: initialWorkDir,
  /** Going back to something the user said: the message being edited, and the agent going back (rewind-state.js). */
  rewind: initialRewind,
  /** Paths folded off the conversation on screen, each where it went another way: { id, at, count } (rewind-state.js). */
  folds: [] as Untyped[],
  /** The topic on screen: the segment it goes on from (null: a new topic), when it started, its menu (topics.js). */
  topic: initialTopic,
  /** 继续这个话题 waiting on the user: another directory, a directory gone, a session gone (resume-state.ts). */
  resume: initialResume,
  /** Turns that went on in the background, and the move that can still be undone (tasks-state.js). */
  tasks: initialTasks,
  /** Saved conversational schedules shown on the 定时任务 hub sub-page (schedules-state.ts). */
  schedules: initialSchedules,
  /** Task cards started before any foreground message, anchored at the start of this topic only. */
  taskCards: [] as string[],
  files: initialFiles,
  memory: initialMemory,
  extensions: initialExtensions,
  /** Cards for the schedules the model proposed in this conversation (proposal-state.ts ProposalCard). */
  proposals: [] as Untyped[],
  models: initialModels,
  diagnostics: initialDiagnostics,
  theme: initialTheme,
  /** The 插件 section of settings (plugins-state.ts). */
  plugins: initialPlugins,
  /** 能力: which of skills, MCP and plugins is shown, and the one picked (capabilities-state.ts). */
  capabilities: initialCapabilities,
  /** 能力 · 导入, skills or MCP servers: where from, what was found, what is ticked (import-flow-state.ts). */
  importFlow: initialImportFlow,
  toast: null as Untyped,
  /** A new or reopened conversation is on its way; sending now would land in the one being replaced. */
  switching: false,
  /** The blank topic is visible, but it has no usable runtime session yet (also true after a failed attempt). */
  newTopicPending: false,
  settings: {
    open: false,
    loaded: false,
    hasKey: false,
    keyHint: '',
    source: null as string | null,
    encryptionAvailable: true,
    busy: false,
    error: null as string | null,
    notice: null as string | null,
    /** The pictures folder (main/image-store.js): { dir, bytes, count }, and whether 清空 waits for a yes. */
    images: null as { dir: string, bytes: number, count: number } | null,
    imagesConfirm: false,
    imagesBusy: false,
    /** What the assistant may do without asking (view/permission-picker.js), its menu, and a switch under way. */
    permission: 'workspace-write',
    /** 联网搜索 as it is now (compose.ts webSearchNow), and a switch under way (dsh restarts). */
    webSearch: true,
    webSearchBusy: false,
    permissionMenu: false,
    permissionBusy: false,
  },
})

/** Typewriter pace for assistant text; speeds up so the display never trails the agent by more than ~1.2 s. */
const REVEAL_BASE_CPS = 90
const REVEAL_MAX_LAG_S = 1.2

/**
 * @param shown characters already on screen
 * @param length characters received so far
 * @param dtMs time since the previous frame
 * @returns characters to show after this frame
 */
export function revealStep(shown: number, length: number, dtMs: number): number {
  if (shown >= length) return length
  const cps = Math.max(REVEAL_BASE_CPS, (length - shown) / REVEAL_MAX_LAG_S)
  return Math.min(length, shown + Math.max(1, Math.round((cps * dtMs) / 1000)))
}

const isRevealingMessage = (m: ThreadMessage): m is ThreadMessage & { shown: number } => m.role === 'assistant' && m.shown !== undefined && m.shown < m.text.length

/** Whether some assistant text is still being typed out. */
export const isRevealing = (state: State): boolean => state.messages.some(isRevealingMessage)

const topicChanged = (state: State, info: AgentInfo) =>
  info.topicId !== undefined && state.info.topicId !== undefined && info.topicId !== state.info.topicId

// The saved segment can load before the renderer gets its first topic identity.
const readyStartsNewTopic = (state: State, info: AgentInfo) => topicChanged(state, info)
  || (info.remembersHistory === false && Boolean(info.conversationId && state.conversationId && info.conversationId !== state.conversationId))

/** Maximum in-memory foreground messages before trimming back to the visible window on idle turn_end. */
export const CONVERSATION_WINDOW_LIMIT = CONVERSATION_WINDOW_MESSAGES + 50
const TRACE_TIMELINE_LIMIT = 500
const TRACE_TIMELINE_KEEP = 400

/**
 * Keeps a long-lived foreground session bounded in memory without shifting indices mid-turn or while editing a rewind.
 * Only trims messages already above `#thread`'s `THREAD_MAX` (`CONVERSATION_WINDOW_MESSAGES = 200`) viewport, which
 * `#thread` never renders or offers rewind on (see `view/thread.ts` `restLine`, `timeline-search.ts`, and
 * `test/smoke/smoke-perf.ts` `BUDGET.drawn`); earlier messages remain persisted in SQLite and reachable in 回顾 via
 * `.thread-rest` -> `history:read`.
 */
export function trimConversationWindow(state: State): State {
  if (state.phase !== 'idle' || state.rewind.editing) return state
  let next = state
  if (next.messages.length > CONVERSATION_WINDOW_LIMIT) {
    const drop = next.messages.length - CONVERSATION_WINDOW_MESSAGES
    let safe = 0
    while (safe < drop && !next.messages[safe]!.open) safe += 1
    if (safe > 0) {
      const dropped = next.messages.slice(0, safe)
      const carriedCards = dropped.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])]).filter((id): id is string => Boolean(id))
      const taskCards = carriedCards.length ? [...new Set([...next.taskCards, ...carriedCards])] : next.taskCards
      const proposals = next.proposals.length
        ? (next.proposals as import('./proposal-types.ts').ProposalCard[]).map(card => ({
          ...card,
          after: card.after === undefined ? undefined : Math.max(0, card.after - safe),
        }))
        : next.proposals
      const nextOffset = (next.historyOffset ?? 0) + safe
      const records = next.records.some(record => record.after < nextOffset)
        ? next.records.filter(record => record.after >= nextOffset)
        : next.records
      next = {
        ...next,
        historyOffset: nextOffset,
        messages: next.messages.slice(safe),
        records,
        taskCards,
        proposals,
      }
    }
  }
  if (next.timeline.length > TRACE_TIMELINE_LIMIT) {
    const timeline = next.timeline.slice(-TRACE_TIMELINE_KEEP)
    const keptThoughts = new Set(timeline.filter(item => item.kind === 'thought').map(item => item.ref))
    const keptTools = new Set(timeline.filter(item => item.kind === 'tool').map(item => item.ref))
    const keptModels = new Set(timeline.filter(item => item.kind === 'model').map(item => item.ref))
    const thoughts = next.thoughts.filter(item => keptThoughts.has(item.id))
    const tools = Object.fromEntries(Object.entries(next.tools).filter(([id]) => keptTools.has(id)))
    const modelCalls = Object.fromEntries(Object.entries(next.modelCalls).filter(([id]) => keptModels.has(id)))
    next = { ...next, timeline, thoughts, tools, modelCalls }
  }
  return next
}

const ACTION_HANDLERS: ActionHandlers = {
  initialization_status: (state, { status, reason }) => ({ ...state, initialization: { status, reason: reason ?? null } }),
  initialization_turn: (state, { turn }) => ({ ...state,
    turn: { tools: 0, thoughts: 0, ...(state.turn?.id === turn.id && state.turn), id: turn.id, startedAt: turn.startedAt, by: turn.by },
    phase: turn.stopping ? 'stopping' : state.phase === 'asking' || state.phase === 'waiting' ? state.phase : 'working',
    ...(turn.stopping && { permission: null, question: null, secret: null }),
  }),
  initialization_snapshot: (state, { snapshot }) => {
    const clean = { ...state, ...initialConversation, historyOffset: 0, info: snapshot.info, conversationId: snapshot.info.conversationId ?? null,
      restored: null, restoredTrace: null, restoredTraceData: null, records: [], folds: [], topic: initialTopic,
      switching: false, newTopicPending: false, stopUnconfirmed: snapshot.stopUnconfirmed === true, stoppedReplayLost: snapshot.stoppedReplayLost === true }
    const saved = snapshot.history
    return saved ? ACTION_HANDLERS.history_loaded!(clean, { conversationId: saved.id, messages: saved.messages, offset: saved.offset ?? 0,
      records: saved.records, savedAt: saved.updatedAt, folds: [...saved.folds], parentId: saved.parentId, createdAt: saved.createdAt }) : clean
  },
  ready: (state, { info }) => !state.newTopicPending && readyStartsNewTopic(state, info) ? ACTION_HANDLERS.new_session!(state, { info }) : ({
    ...state,
    info,
    conversationId: !state.newTopicPending && typeof info.conversationId === 'string' ? info.conversationId : state.conversationId,
    ...(state.stopUnconfirmed && (info.mode === 'setup' || info.sessionId && info.sessionId !== state.info.sessionId) && { stopUnconfirmed: false, stoppedReplayLost: false, lastReceipt: null }),
    phase: !state.newTopicPending && state.phase === 'error' ? 'idle' : state.phase,
    error: !state.newTopicPending && state.phase === 'error' ? null : state.error,
  }),

  /** The conversation's own (conversation-state.ts): its words, its turns, what it asks and is asked. */


  user_prompt: (state, action) => ({ ...reduceConversation(state, { ...action, type: 'user_prompt' }), island: false }),

  turn_end: (state, action) => {
    // A delegation can end without a reply while its task and result delivery continue.
    const delegated = state.tasks.list.some(task => task.status !== 'interrupted' && typeof task.startedAt === 'number'
      && task.startedAt >= (state.turn?.startedAt ?? Infinity)
      && (task.status === 'running' || task.status === 'waiting'
        || !state.records.some(record => record.reportId === `${task.id}:${task.runId}` && record.at <= action.at)))
    return trimConversationWindow(reduceConversation(state, { ...action, type: 'turn_end', ...(delegated ? { finalReply: undefined } : {}) }))
  },

  /** The turn ended just as words were said in it: they go as the next question, already in the thread. */
  steer_resent: (state, { at, turnId }) => ({
    ...state,
    phase: 'working',
    error: null,
    island: false,
    turn: { startedAt: at, tools: 0, thoughts: 0, ...(turnId && { id: turnId }) },
  }),

  error: (state, action) => ({ ...reduceConversation(state, { ...action, type: 'error' }), switching: state.newTopicPending && state.switching }),

  /** A saved conversation, shown fully typed out; ignored once a new conversation has started. */
  history_loaded: (state, { conversationId = null, messages, offset = 0, records = [], savedAt, folds = [], parentId = null, createdAt = null }) => {
    if (state.messages.length > 0 || state.newTopicPending || !Array.isArray(messages) || (!messages.length && !offset && !conversationId)) return state
    const base = Math.max(0, Math.trunc(offset) || 0)
    const total = base + messages.length
    return {
      ...state,
      conversationId,
      historyOffset: base,
      folds,
      topic: { ...initialTopic, parentId, startedAt: createdAt },
      restoredTrace: total ? 'loading' : null,
      messages: messages.map((m: { role: string, text: string, receipt?: Receipt | null, images?: ReadonlyArray<{ id: string }>, key?: string, sourceId?: string, delivery?: 'pending' | 'not-sent' }, i: number) => ({
        id: m.key ? `stream:${m.key}:text` : `m${base + i}`, ...(m.key ? { streamKey: m.key } : {}), role: m.role, text: m.text, shown: m.text.length, open: false, receipt: m.receipt ?? null, restored: true,
        ...(m.sourceId ? { sourceId: m.sourceId } : {}), ...(m.images ? { images: m.images } : {}),
        ...(m.delivery ? { delivery: m.delivery, failed: m.delivery === 'not-sent' } : {}),
      })),
      records: recordsFrom(records),
      restored: total ? { count: total, savedAt } : null,
    }
  },

  session_switching: (state) => ({ ...state, switching: true, picker: false }),
  session_switch_failed: (state) => ({ ...state, switching: false }),

  new_session_pending: (state, { at }) => ({
    ...(state.newTopicPending ? state : ACTION_HANDLERS.new_session!(state, { at })),
    switching: true, newTopicPending: true, phase: 'idle', error: null,
  }),
  new_session_ready: (state, { info }) => ({ ...state, info, conversationId: typeof info.conversationId === 'string' ? info.conversationId : state.conversationId, switching: false, newTopicPending: false, phase: 'idle', error: null }),
  new_session_failed: (state, { message }) => ({ ...state, switching: false, phase: 'error', error: t("state.could.not.prepare.a.new.topic.your", { message: message }) }),

  /**
   * What the memory plugin put in front of the model this turn, reported when the turn ends. Each entry
   * goes where its time puts it in the trace, ahead of the steps it informed.
   */
  memory_context: (state, { injected }) => {
    const entries = injected.map((injection, i) => ({ kind: 'memory' as const, ref: `memory-${injection.at}-${i}`, at: injection.at, injection }))
    if (entries.length === 0) return state
    const timeline = [...state.timeline, ...entries].sort((a, b) => a.at - b.at)
    return { ...state, timeline }
  },

  /** A new session goes on below what was said so far, which stays in the timeline above: a new topic. */
  new_session: (state, { info, at = null }) => ({
    ...initialState,
    traceRevision: state.traceRevision,
    topic: { ...initialTopic, startedAt: at },
    info: info ?? state.info,
    conversationId: typeof info?.conversationId === 'string' ? info.conversationId : null,
    drawer: state.drawer,
    settings: state.settings,
    diagnostics: state.diagnostics,
    theme: state.theme,
    history: state.history,
    earlier: withCurrentKept(state),
    workDir: state.workDir,
    // Background tasks and saved schedules go on whatever the conversation on screen does.
    tasks: state.tasks,
    schedules: { ...state.schedules, open: false },
    memory: state.memory,
    extensions: state.extensions,
    toast: state.toast,
  }),

  /** A different project opens a fresh topic. A switch within the same project keeps the previous segment. */
  workdir_switched: (state, { info }) => {
    const next = ACTION_HANDLERS.new_session!(state, { info })
    return topicChanged(state, info) ? next : {
      ...next,
      topic: { ...initialTopic, parentId: state.conversationId, startedAt: state.topic.startedAt },
    }
  },

  /** 回到这个话题 (or 撤销 a new one): the agent goes on from that segment; what is said next follows below. */
  /** `carried`: how many turns of its saved records the topic goes on from, its own session gone (null: it is the session). */
  topic_resumed: (state, { info, parentId, at = null, carried = null }) => ({
    ...ACTION_HANDLERS.new_session!(state, { info }),
    topic: { ...initialTopic, parentId, startedAt: at, carried },
    resume: null,
  }),
  topic_menu: (state, { open }) => (state.topic.menu === open ? state : { ...state, topic: { ...state.topic, menu: open } }),

  /** Restored trace goes first: it happened before anything the live session has added since. */
  trace_restored: (state, { conversationId, trace, available }) => {
    if (conversationId !== state.conversationId) return state
    const live = removeRestoredTrace(state)
    if (!available || !trace) return { ...live, restoredTrace: 'unavailable' }
    return {
      ...live,
      restoredTrace: 'loaded',
      restoredTraceData: trace,
      thoughts: [...trace.thoughts, ...live.thoughts],
      tools: { ...trace.tools, ...live.tools },
      modelCalls: { ...trace.modelCalls, ...live.modelCalls },
      timeline: [...trace.timeline, ...live.timeline],
    }
  },
  trace_invalidated: (state, { currentSession }) => {
    const live = removeRestoredTrace(state)
    return { ...live, traceRevision: live.traceRevision + 1, traceDetail: null,
      rewind: live.rewind.confirm ? { ...live.rewind, confirm: null } : live.rewind,
      restoredTrace: live.restoredTrace === null && !currentSession ? null : 'unavailable',
      ...(currentSession ? { thoughts: [], tools: {}, modelCalls: {}, timeline: live.timeline.filter(item => item.kind !== 'thought' && item.kind !== 'tool' && item.kind !== 'model' && item.kind !== 'memory') } : {}) }
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
  /** The permission picker by the input: its menu, a switch under way (dsh restarts), and the level once switched. */
  permission_menu: (state, { open }) => (state.settings.permissionMenu === open ? state : { ...state, settings: { ...state.settings, permissionMenu: open } }),
  permission_busy: (state) => ({ ...state, settings: { ...state.settings, permissionBusy: true, permissionMenu: false } }),
  permission_done: (state, { level }) => ({ ...state, settings: { ...state.settings, permission: level ?? state.settings.permission, permissionBusy: false } }),
  /** 贴过的图片: emptying asks first; while it is emptied or moved its buttons wait; then its new size. */
  images_confirm: (state, { open }) => ({ ...state, settings: { ...state.settings, imagesConfirm: open } }),
  images_busy: (state) => ({ ...state, settings: { ...state.settings, imagesBusy: true, imagesConfirm: false } }),
  images_done: (state, { usage }) => ({
    ...state, settings: { ...state.settings, images: usage ?? state.settings.images, imagesBusy: false, imagesConfirm: false },
  }),
  settings_failed: (state, { message }) => ({ ...state, settings: { ...state.settings, busy: false, error: message } }),
  settings_saved: (state, { view, notice }) => ({
    ...state, settings: { ...state.settings, ...view, loaded: true, busy: false, error: null, notice },
  }),
  trace_detail_open: (state, { key, conversationId, loading }) => ({ ...state, traceDetail: { key, conversationId, loading, request: null, error: null } }),
  trace_detail_loaded: (state, { key, conversationId, request }) => state.traceDetail?.key === key && state.traceDetail.conversationId === conversationId
    ? { ...state, traceDetail: { ...state.traceDetail, loading: false, request, error: request?.request ? null : 'unavailable' } } : state,
  trace_detail_failed: (state, { key, conversationId, message }) => state.traceDetail?.key === key && state.traceDetail.conversationId === conversationId
    ? { ...state, traceDetail: { ...state.traceDetail, loading: false, error: message } } : state,
  trace_detail_close: (state) => ({ ...state, traceDetail: null }),
  open_drawer: (state, { tab }) => ({ ...state, drawer: tab, island: false, traceDetail: tab === 'trace' && state.drawer === 'trace' ? state.traceDetail : null }),
  close_drawer: (state) => ({ ...state, drawer: null, traceDetail: null }),
  toggle_drawer: (state) => ({ ...state, drawer: state.drawer ? null : 'trace', traceDetail: null }),
  toggle_island: (state) => ({ ...state, island: !state.island }),
  close_island: (state) => (state.island ? { ...state, island: false } : state),
  hub_close: (state) => closeHub(state, reduce),
  ...HISTORY_ACTIONS,
  ...REVIEW_ACTIONS,
  ...RESUME_ACTIONS,
  ...EARLIER_ACTIONS,
  ...REPORT_ACTIONS,
  ...rewindActions((state, action) => ACTION_HANDLERS.new_session!(state, action)),
  ...taskActions(),
  ...SCHEDULES_ACTIONS,
  ...WORKDIR_ACTIONS,
  ...PERSONAL_ACTIONS,
  ...MEMORY_FILE_ACTIONS,
  ...MODEL_ACTIONS,
  ...DIAGNOSTICS_ACTIONS,
  ...THEME_ACTIONS,
  ...PLUGIN_ACTIONS,
  ...FILES_ACTIONS,
  ...SECRET_ACTIONS,
  ...WAITS_ACTIONS,
  ...PROPOSAL_ACTIONS,
  ...CAPABILITY_ACTIONS,
  ...IMPORT_FLOW_ACTIONS,
} satisfies ActionHandlers

export function reduce(state: State, action: Action): State {
  const next = reduceOnce(state, action)
  // Results drawn in the conversation tell their tasks (tasks-state.ts) once the conversation is in view: not while a
  // hub page covers it, and again on coming back to it.
  const inView = hubPage(next) === null
  const changed = next.records !== state.records || next.tasks.list !== state.tasks.list || hubPage(state) !== null
  return inView && changed ? toldByRecords(next) : next
}

function reduceOnce(state: State, action: Action): State {
  const routed = routeToTask(state, action)
  if (routed) return routed
  const next = Object.hasOwn(ACTION_HANDLERS, action.type) ? handleAction(state, action, ACTION_HANDLERS)
    : isConversationAction(action) ? reduceConversation(state, action) : state
  const projected = oneHubPage(state, next, reduce)
  if (projected.historyOffset !== state.historyOffset || projected.messages.length <= state.messages.length || !projected.records.length) return projected
  const positions = retainedMessagePositions(state.messages, projected.messages, (before, after) => before.id === after.id)
  if (!positions) return projected
  const offset = projected.historyOffset ?? 0
  const records = projected.records.map(record => {
    if (record.after <= offset) return record
    const after = offset + retainedMessageBoundary(record.after - offset, positions)
    return after === record.after ? record : { ...record, after }
  })
  return records.some((record, index) => record !== projected.records[index]) ? { ...projected, records } : projected
}

export const isBusy = (state: { phase: string }): boolean => state.phase === 'working' || state.phase === 'waiting' || state.phase === 'asking'
