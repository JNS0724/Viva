import { t } from '../shared/i18n/translate.ts'
import { CONVERSATION_ACTIONS, initialConversation, reduceConversation } from './conversation-state.ts'
import { EARLIER_ACTIONS, initialEarlier, withCurrentKept } from './earlier-state.ts'
import { recordsFrom, REPORT_ACTIONS } from './report-state.ts'
import { FILES_ACTIONS, initialFiles } from './files-state.ts'
import { HISTORY_ACTIONS, initialHistory } from './history-state.ts'
import { REVIEW_ACTIONS, initialReview } from './review-state.ts'
import { RESUME_ACTIONS, initialResume } from './resume-state.ts'
import { closeHub, initialHub, oneHubPage } from './hub-state.ts'
import { initialModels, MODEL_ACTIONS } from './model-state.ts'
import { initialPlugins, PLUGIN_ACTIONS } from './plugins-state.ts'
import { initialRewind, rewindActions } from './rewind-state.ts'
import { initialTasks, routeToTask, taskActions } from './tasks-state.ts'
import { SECRET_ACTIONS } from './secret-state.ts'
import { WAITS_ACTIONS } from './waits-state.ts'
import { FOLLOWUP_ACTIONS, initialFollowups } from './followup-state.ts'
import { FEED_ACTIONS, initialFeed } from './feed-state.ts'
import { initialWorkDir, WORKDIR_ACTIONS } from './workdir-state.ts'
import { initialTopic } from './topics.ts'
import { initialExtensions, initialMemory, PERSONAL_ACTIONS } from './personal-state.ts'

/**
 * Pure, immutable conversation state. ACP updates go in; the views read it out.
 * Thoughts and tool calls live in `timeline` (shown in the drawer), never in `messages`.
 */
export const initialState = Object.freeze({
  info: { mode: 'connecting', model: '', cwd: '', reason: '' } as AgentInfo,
  /** idle; working on a turn; waiting on a permission; asking a question; or stopped by an error. */
  /** The conversation on screen: what was said and done, and where its turn is (conversation-state.ts). */
  ...initialConversation,
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
  /** Task cards started before any foreground message, anchored at the start of this topic only. */
  taskCards: [] as string[],
  files: initialFiles,
  memory: initialMemory,
  extensions: initialExtensions,
  /** Follow-ups and background preparation (followup-state.ts). */
  followups: initialFollowups,
  feed: initialFeed,
  /** Cards for the follow-ups the model proposed in this conversation (followup-state.ts ProposalCard). */
  proposals: [] as Untyped[],
  models: initialModels,
  /** The 插件 section of settings (plugins-state.ts). */
  plugins: initialPlugins,
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

const ACTION_HANDLERS: Record<string, Reducer> = {
  ready: (state, { info }) => ({
    ...state,
    info,
    phase: !state.newTopicPending && state.phase === 'error' ? 'idle' : state.phase,
    error: !state.newTopicPending && state.phase === 'error' ? null : state.error,
  }),

  /** The conversation's own (conversation-state.ts): its words, its turns, what it asks and is asked. */
  ...Object.fromEntries(Object.keys(CONVERSATION_ACTIONS).map((type) => [type, (state: State, action: Action) => reduceConversation(state, action)])),

  user_prompt: (state, action) => ({ ...reduceConversation(state, action), island: false }),

  /** The turn ended just as words were said in it: they go as the next question, already in the thread. */
  steer_resent: (state, { at }) => ({
    ...state,
    phase: 'working',
    error: null,
    island: false,
    turn: { startedAt: at, tools: 0, thoughts: 0 },
  }),

  error: (state, action) => ({ ...reduceConversation(state, action), switching: state.newTopicPending && state.switching }),

  /** A saved conversation, shown fully typed out; ignored once a new conversation has started. */
  history_loaded: (state, { conversationId = null, messages, records = [], savedAt, folds = [], parentId = null, createdAt = null }) => {
    if (state.messages.length > 0 || state.newTopicPending || !Array.isArray(messages) || (!messages.length && !conversationId)) return state
    return {
      ...state,
      conversationId,
      folds,
      topic: { ...initialTopic, parentId, startedAt: createdAt },
      restoredTrace: messages.length ? 'loading' : null,
      messages: messages.map((m: { role: string, text: string, receipt?: Receipt | null, images?: ReadonlyArray<{ id: string }> }, i: number) => ({
        id: `m${i}`, role: m.role, text: m.text, shown: m.text.length, open: false, receipt: m.receipt ?? null, restored: true, ...(m.images ? { images: m.images } : {}),
      })),
      records: recordsFrom(records),
      restored: messages.length ? { count: messages.length, savedAt } : null,
    }
  },

  session_switching: (state) => ({ ...state, switching: true, picker: false }),
  session_switch_failed: (state) => ({ ...state, switching: false }),

  new_session_pending: (state, { at }) => ({
    ...(state.newTopicPending ? state : ACTION_HANDLERS.new_session(state, { at })),
    switching: true, newTopicPending: true, phase: 'idle', error: null,
  }),
  new_session_ready: (state, { info }) => ({ ...state, info, switching: false, newTopicPending: false, phase: 'idle', error: null }),
  new_session_failed: (state, { message }) => ({ ...state, switching: false, phase: 'error', error: t("state.could.not.prepare.a.new.topic.your", { message: message }) }),

  /**
   * What the memory plugin put in front of the model this turn, reported when the turn ends. Each entry
   * goes where its time puts it in the trace, ahead of the steps it informed.
   */
  memory_context: (state, { injected }) => {
    const entries = (injected ?? []).map((injection: { at: number, [field: string]: any }, i: number) => ({ kind: 'memory', ref: `memory-${injection.at}-${i}`, at: injection.at, injection }))
    if (entries.length === 0) return state
    const timeline = [...state.timeline, ...entries].sort((a, b) => a.at - b.at)
    return { ...state, timeline }
  },

  conversation_saved: (state, { id }) => (state.conversationId === id ? state : { ...state, conversationId: id }),

  /** A new session goes on below what was said so far, which stays in the timeline above: a new topic. */
  new_session: (state, { info, at = null }) => ({
    ...initialState,
    topic: { ...initialTopic, startedAt: at },
    info: info ?? state.info,
    drawer: state.drawer,
    settings: state.settings,
    history: state.history,
    earlier: withCurrentKept(state),
    workDir: state.workDir,
    // Background tasks go on whatever the conversation on screen does.
    tasks: state.tasks,
    memory: state.memory,
    extensions: state.extensions,
    followups: state.followups,
    toast: state.toast,
  }),

  /** The conversation goes on in another working directory, with everything said so far (a fork): the same topic. */
  workdir_switched: (state, { info }) => ({
    ...ACTION_HANDLERS.new_session(state, { info }),
    topic: { ...initialTopic, parentId: state.conversationId, startedAt: state.topic.startedAt },
  }),

  /** 回到这个话题 (or 撤销 a new one): the agent goes on from that segment; what is said next follows below. */
  /** `carried`: how many turns of its saved records the topic goes on from, its own session gone (null: it is the session). */
  topic_resumed: (state, { info, parentId, at = null, carried = null }) => ({
    ...ACTION_HANDLERS.new_session(state, { info }),
    topic: { ...initialTopic, parentId, startedAt: at, carried },
    resume: null,
  }),
  topic_menu: (state, { open }) => (state.topic.menu === open ? state : { ...state, topic: { ...state.topic, menu: open } }),

  /** Picked from the history panel: start over with that conversation's messages and close the panel. */
  conversation_opened: (state, { conversation, info }) => ACTION_HANDLERS.history_loaded(
    { ...ACTION_HANDLERS.new_session(state, { info }), earlier: initialEarlier, history: { ...state.history, open: false } },
    { conversationId: conversation.id, messages: conversation.messages, records: conversation.records, savedAt: conversation.updatedAt, parentId: conversation.parentId ?? null, createdAt: conversation.createdAt ?? null },
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
  open_drawer: (state, { tab }) => ({ ...state, drawer: tab, island: false }),
  close_drawer: (state) => ({ ...state, drawer: null }),
  toggle_drawer: (state) => ({ ...state, drawer: state.drawer ? null : 'trace' }),
  toggle_island: (state) => ({ ...state, island: !state.island }),
  close_island: (state) => (state.island ? { ...state, island: false } : state),
  hub_close: (state) => closeHub(state, reduce),
  ...HISTORY_ACTIONS,
  ...REVIEW_ACTIONS,
  ...RESUME_ACTIONS,
  ...EARLIER_ACTIONS,
  ...REPORT_ACTIONS,
  ...rewindActions((state, action) => ACTION_HANDLERS.new_session(state, action)),
  ...taskActions(),
  ...WORKDIR_ACTIONS,
  ...PERSONAL_ACTIONS,
  ...MODEL_ACTIONS,
  ...PLUGIN_ACTIONS,
  ...FILES_ACTIONS,
  ...SECRET_ACTIONS,
  ...WAITS_ACTIONS,
  ...FOLLOWUP_ACTIONS,
  ...FEED_ACTIONS,
}

export function reduce(state: State, action: Action): State {
  const routed = routeToTask(state, action)
  if (routed) return routed
  const handler = ACTION_HANDLERS[action?.type ?? '']
  return oneHubPage(state, handler ? handler(state, action) : state, reduce)
}

export const isBusy = (state: { phase: string }): boolean => state.phase === 'working' || state.phase === 'waiting' || state.phase === 'asking'
