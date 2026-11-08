// What the preload scripts put on the page (src/preload/preload.cjs, desk-preload.cjs). A call that only forwards
// to a channel takes that channel's arguments from the IPC contract (src/shared/ipc-contract.ts), the same table the
// main process checks them against; test/window-api.test.js keeps these names and the preload scripts in step.
// Conversation/task results use IpcResults; the remaining channels migrate with their features.

type Args<C extends import('../shared/ipc-contract.ts').Channel> = import('../shared/ipc-contract.ts').ChannelArgs<C>
type IpcResults = import('../shared/ipc-results.ts').IpcResults
/** A channel's call: its arguments, and its answer where written out (ipc-results.ts), else `any` for now. */
type Invoke<C extends import('../shared/ipc-contract.ts').Channel> = (...args: Args<C>) => Promise<C extends keyof IpcResults ? IpcResults[C] : any>
type Unlisten = () => void

/** A part of the state whose shape is not written out yet: what an empty start (null, []) was before strict. */
type Untyped = any

/**
 * What a part of the state can hold, from its first value: false any boolean, '' any text; a field that starts
 * null, or a list that starts empty, holds what is not written out yet (Untyped); an object that starts empty
 * ({}), entries by key.
 */
type Widened<T> = [T] extends [never] ? Untyped
  : T extends null ? Untyped
  : T extends string ? string
  : T extends number ? number
  : T extends boolean ? boolean
  : T extends readonly (infer U)[] ? ReadonlyArray<Widened<U>>
  : T extends (...args: any[]) => any ? T
  : T extends BackgroundTask ? BackgroundTask
  : T extends object ? ([keyof T] extends [never] ? Readonly<Record<string, Untyped>> : { -readonly [K in keyof T]: Widened<T[K]> })
  : T
/** What the main process tells the window of the agent (session-info.ts, acp-bridge.ts): the fields the window reads. */
type AgentInfo = import('../shared/agent-info.ts').AgentInfo
type ToolCall = import('./conversation-types.ts').ConversationTool
type Receipt = import('./conversation-types.ts').TurnReceipt
type ThreadMessage = import('./conversation-types.ts').ConversationMessage
/**
 * A background task's result the model read, as a conversation draws it (report-state.ts): which report, when it
 * came (ms), the note as given, and how many of the conversation's messages come before it.
 */
interface ReportRecord { readonly reportId: string, readonly at: number, readonly text: string, readonly after: number }
/** A message of an earlier segment, as the history keeps it: `seq` counts the segment's saved messages. */
interface SegmentMessage {
  seq: number
  role: string
  text: string
  receipt?: Receipt | null
  at?: number
  images?: ReadonlyArray<{ id: string }>
  [field: string]: any
}
/** A part of the one timeline before the one on screen (history-db.ts segmentsBefore). */
interface Segment {
  id: string
  cwd?: string | null
  /** What it went on from (topics.ts). */
  parentId?: string | null
  createdAt: number
  messages: ReadonlyArray<SegmentMessage>
  /** Its task records, each after the messages before it (history-db.ts recordsOf). */
  records?: ReadonlyArray<ReportRecord>
  [field: string]: any
}
/**
 * Where a search found the words (history-db.ts searchMessages), or a link or a star names a message: the segment,
 * the message's seq in it, and its id when known (what stays the same while the message is there).
 */
interface SearchHit { segmentId: string, seq: number, messageId?: number, [field: string]: any }
/** One answer dsh offers to an approval: allow once, always, reject. */
interface PermissionOption { optionId: string, name: string, kind?: string }
/** One question the agent asks, with its options. */
interface QuestionItem {
  id: string
  question: string
  header?: string
  options: ReadonlyArray<{ label: string, description?: string }>
  multiSelect?: boolean
}
/** A turn that went on in the background (tasks-state.ts): where it stands, and the view of what it says. */
interface BackgroundTask {
  id: string
  title: string
  /** Persisted original position of a standalone background task's history row. */
  host?: { conversationId: string, at: number, order: number }
  /** running, waiting (on the user), done, stopped, error. */
  status: string
  /** What it is doing now, in a few words. */
  now?: string | null
  startedAt?: number
  endedAt?: number | null
  permission?: any
  question?: any
  /** What it said and did, and where its turn is: a conversation of its own (conversation-state.ts). */
  view: ConversationView
  [field: string]: any
}
/**
 * What the island is given to show: islandView's (island-view.ts IslandView), or a form only the desktop's page
 * makes (desk.ts: mini, coach, input, drop), with the fields that form reads.
 */
type IslandShown = { form: string, tone: string, mood: string, label: string, recent: ReadonlyArray<{ title: string, tone: string }>, [field: string]: any }
/** What a click on the island asks for (island-dom.ts): its kind, and what that needs. */
type IslandAct = (action: { kind: string, [field: string]: unknown }) => void
/** What a view draws: an element, several, text, or nothing. */
type View = Node | string | null | false | undefined | ReadonlyArray<View>

/** The window's state: what state.ts's initialState can become. */
type State = Omit<Widened<typeof import('./state.ts').initialState>, keyof ConversationView | 'info'> & ConversationView & { info: AgentInfo }
/**
 * One conversation as it is reduced (conversation-state.ts): the one on screen (part of State) or a background
 * task's (BackgroundTask.view), and no more.
 */
type ConversationView = import('./conversation-types.ts').ConversationState
/** What changes the state: its type, and the fields its reducer reads (each reducer destructures its own). */
type Action = import('./action-types.ts').AppAction
/** The state after an action: a new object, never the one given changed in place. */
type Reducer = (state: State, action: Action) => State
/** A button on a toast: what it says, what it does (app.ts TOAST_ACTIONS), and what that needs. */
type ToastAction = { label: string, kind: string, payload?: unknown }
/** What the window's action modules (*-actions.ts) are given: the bridge, the state, how to change it and say so. */
interface ActionDeps {
  api: AgentApi
  getState: () => State
  dispatch: (action: Action) => void
  errorMessage: (err: unknown) => string
  showToast: (text: string, options?: { action?: ToastAction | null, ms?: number }) => void
  /** Sends words as the user's next question (app.ts ask); false when the agent can't take them now. */
  ask: (text: string) => boolean
}
/** What the views call back (app.ts handlers), by name. */
type Handlers = Readonly<Record<string, (...args: any[]) => any>>

/** The main window's bridge to the main process (preload.cjs). */
interface LanguageApi {
  getLanguage: () => Promise<import('../shared/i18n/locale.ts').LanguageState>
  setLanguage: (language: import('../shared/i18n/locale.ts').Language) => Promise<import('../shared/i18n/locale.ts').LanguageState>
  onLanguage: (callback: (state: import('../shared/i18n/locale.ts').LanguageState) => void) => Unlisten
}
interface DraftApi extends LanguageApi {
  getDraft: Invoke<'draft:get'>
  updateDraft: (...args: Args<'draft:update'>) => void
  appendDraftImage: Invoke<'draft:append-image'>
  appendDraftFiles: Invoke<'draft:append-files'>
  onDraft: (callback: (draft: import('../shared/composer-draft.ts').DraftSnapshot) => void) => Unlisten
}
interface AgentApi extends DraftApi {
  /** 'darwin' | 'win32' | 'linux': the page lays out its title bar around the system window buttons. */
  platform: string
  getInfo: Invoke<'agent:info'>
  waits: Invoke<'agent:waits'>
  prompt: Invoke<'agent:prompt'>
  keepImage: Invoke<'images:keep'>
  imagesUsage: Invoke<'images:usage'>
  setPermission: Invoke<'settings:set-permission'>
  openImagesFolder: Invoke<'images:open-folder'>
  clearImages: Invoke<'images:clear'>
  moveImages: Invoke<'images:move'>
  steer: Invoke<'agent:steer'>
  cancel: Invoke<'agent:cancel'>
  newSession: Invoke<'agent:new-session'>
  setConfig: Invoke<'agent:set-config'>
  respondPermission: Invoke<'agent:permission'>
  answerQuestion: Invoke<'agent:answer'>
  provideSecrets: Invoke<'agent:secrets'>
  openLink: Invoke<'shell:open-link'>
  getSettings: Invoke<'settings:get'>
  saveApiKey: Invoke<'settings:save-key'>
  clearApiKey: Invoke<'settings:clear-key'>
  setDeskIsland: Invoke<'settings:set-desk-island'>
  setOpenAtLogin: Invoke<'settings:set-open-at-login'>
  resetDeskPlace: Invoke<'settings:reset-desk-place'>
  getModels: Invoke<'models:get'>
  addModelProvider: Invoke<'models:add'>
  updateModelProvider: Invoke<'models:update'>
  removeModelProvider: Invoke<'models:remove'>
  discoverModels: Invoke<'models:discover'>
  loadHistory: Invoke<'history:load'>
  saveHistory: Invoke<'history:save'>
  listHistory: Invoke<'history:list'>
  searchHistory: Invoke<'history:search'>
  resumeTopic: Invoke<'history:resume-topic'>
  resumeCheck: Invoke<'history:resume-check'>
  continueFromRecords: Invoke<'history:continue-from-records'>
  loadTrace: Invoke<'history:trace'>
  renameConversation: Invoke<'history:rename'>
  pinConversation: Invoke<'history:pin'>
  deleteConversation: Invoke<'history:delete'>
  restoreConversation: Invoke<'history:restore'>
  exportConversation: Invoke<'history:export'>
  earlierSegments: Invoke<'history:segments-before'>
  searchTimeline: Invoke<'history:search-messages'>
  reviewTimeline: Invoke<'history:review'>
  readHistory: Invoke<'history:read'>
  locateMessage: Invoke<'history:locate'>
  starMessage: Invoke<'history:star'>
  starsIn: Invoke<'history:stars-in'>
  starredMessages: Invoke<'history:starred'>
  rewind: Invoke<'timeline:rewind'>
  finishedTasks: Invoke<'task:finished'>
  closeTask: Invoke<'task:close'>
  stopTask: Invoke<'task:stop'>
  rewindEffects: Invoke<'timeline:rewind-effects'>
  foldedPath: Invoke<'timeline:folded'>
  switchPath: Invoke<'timeline:switch-path'>
  getWorkDir: Invoke<'workdir:get'>
  chooseWorkDir: Invoke<'workdir:choose'>
  switchWorkDir: Invoke<'workdir:switch'>
  forgetWorkDir: Invoke<'workdir:forget'>
  /** Where a file or folder dragged onto the window is on disk ('' for one that is not on disk). */
  pathForFile: (file: File) => string
  revealWorkDir: Invoke<'workdir:reveal'>
  getMemory: Invoke<'memory:get'>
  listMemories: Invoke<'memory:list'>
  saveProfile: Invoke<'memory:set-profile'>
  addMemory: Invoke<'memory:add'>
  updateMemory: Invoke<'memory:update'>
  deleteMemory: Invoke<'memory:delete'>
  restoreMemory: Invoke<'memory:restore'>
  listInvalidMemories: Invoke<'memory:list-invalid'>
  reviveMemory: Invoke<'memory:revive'>
  setOnboarding: Invoke<'memory:onboarding'>
  addDocs: Invoke<'memory:add-docs'>
  listFiles: Invoke<'files:list'>
  previewFile: Invoke<'files:preview'>
  revealFile: Invoke<'files:reveal'>
  fileApps: Invoke<'files:apps'>
  openFile: Invoke<'files:open'>
  fileImage: Invoke<'files:image'>
  watchFile: Invoke<'files:watch'>
  getExtensions: Invoke<'ext:get'>
  removeMcpServer: Invoke<'ext:remove-mcp'>
  updateMcpServer: Invoke<'ext:update-mcp'>
  importDsh: Invoke<'ext:import-dsh'>
  removeSkill: Invoke<'ext:remove-skill'>
  revealSkill: Invoke<'ext:reveal-skill'>
  skillSources: Invoke<'ext:skill-sources'>
  scanSkills: Invoke<'ext:scan-skills'>
  importSkills: Invoke<'ext:import-skills'>
  mcpSources: Invoke<'ext:mcp-sources'>
  scanMcp: Invoke<'ext:scan-mcp'>
  importMcp: Invoke<'ext:import-mcp'>
  getPlugins: Invoke<'plugins:get'>
  inspectPlugin: Invoke<'plugins:inspect'>
  installPlugin: Invoke<'plugins:install'>
  removePlugin: Invoke<'plugins:remove'>
  setPluginEnabled: Invoke<'plugins:set-enabled'>
  getPluginSource: Invoke<'plugins:source'>
  setPluginSource: Invoke<'plugins:set-source'>
  listSchedules: Invoke<'schedules:list'>
  acceptSchedule: Invoke<'schedules:accept'>
  declineSchedule: Invoke<'schedules:decline'>
  pauseSchedule: Invoke<'schedules:pause'>
  deleteSchedule: Invoke<'schedules:delete'>
  listFeed: Invoke<'feed:list'>
  markFeedSeen: Invoke<'feed:seen'>
  /** What the island shows; the main process passes it to the desktop island while the window is away. */
  islandView: (...args: Args<'island:view'>) => void
  islandAskResult: (...args: Args<'island:ask-result'>) => void
  onFocusComposer: (callback: () => void) => Unlisten
  onIslandAction: (callback: (action: any) => void) => Unlisten
  onEvent: (callback: (event: unknown) => void) => Unlisten
}

/** The desktop island's bridge (desk-preload.cjs): dropped files are known to it only by their paths. */
interface DeskApi extends DraftApi {
  onView: (callback: (view: any) => void) => Unlisten
  act: (...args: Args<'island:act'>) => void
  describeFiles: (files: ArrayLike<File>) => Promise<{ files?: Array<{ path: string, name: string, size: number }>, error?: string }>
  ask: (text: string, files: unknown[], images?: Array<{ id: string }>, draft?: { key: string, version: number }) => Promise<{ ok: boolean, error?: string }>
  keepImage: Invoke<'island:keep-image'>
  /** The ask shortcut as the user presses it (island-main.ts ASK_SHORTCUT). */
  shortcut: string
}

interface Window {
  agent: AgentApi
  desk: DeskApi
}
