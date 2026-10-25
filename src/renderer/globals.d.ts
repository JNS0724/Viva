// What the preload scripts put on the page (src/preload/preload.cjs, desk-preload.cjs). A call that only forwards
// to a channel takes that channel's arguments from the IPC contract (src/main/ipc-contract.ts), the same table the
// main process checks them against; test/window-api.test.js keeps these names and the preload scripts in step.
// What comes back is not typed yet.

type Args<C extends import('../main/ipc-contract.ts').Channel> = import('../main/ipc-contract.ts').ChannelArgs<C>
type Invoke<C extends import('../main/ipc-contract.ts').Channel> = (...args: Args<C>) => Promise<any>
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
  : T extends object ? ([keyof T] extends [never] ? Readonly<Record<string, Untyped>> : { -readonly [K in keyof T]: Widened<T[K]> })
  : T
/** What the main process tells the window of the agent (session-info.ts, acp-bridge.ts): the fields the window reads. */
interface AgentInfo {
  mode: string
  model: string
  cwd: string
  reason?: string
  /** Why the agent cannot start ('no-key', 'no-dsh'), in setup mode. */
  problem?: string
  remembersHistory?: boolean
  [field: string]: any
}
/** A tool call as the state keeps it from the agent's updates. */
interface ToolCall {
  title: string
  kind?: string
  status?: string
  rawInput?: any
  locations?: ReadonlyArray<{ path: string }>
  [field: string]: any
}
/** How a turn ended, shown under its answer. */
interface Receipt { ms: number, stopReason?: string, tools?: number, [field: string]: any }
/** A message of the conversation on screen: who said it, what, and how far it is typed out. */
interface ThreadMessage {
  id: string
  role: string
  text: string
  /** Still arriving from the agent. */
  open?: boolean
  /** How much of the text is typed out so far. */
  shown?: number
  receipt?: Receipt | null
  restored?: boolean
  images?: ReadonlyArray<{ id: string }>
  /** Where it was said from ('island'), whether into a running turn, whether it got through. */
  via?: string
  steered?: boolean
  failed?: boolean
  /** The agent's question it answers. */
  asked?: string
  taskId?: string
  [field: string]: any
}
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
  [field: string]: any
}
/** Where a search found the words (history-db.ts searchMessages): the segment, and the message's seq in it. */
interface SearchHit { segmentId: string, seq: number, [field: string]: any }
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
  /** running, waiting (on the user), done, stopped, error. */
  status: string
  /** What it is doing now, in a few words. */
  now?: string | null
  startedAt?: number
  endedAt?: number | null
  permission?: any
  question?: any
  [field: string]: any
}
/** What an ended task came back with, for the conversation: shown in the thread until put away. */
interface TaskReport { taskId: string, title: string, status: string, preview: string, shown: boolean }
/**
 * What the island is given to show: islandView's (island-view.ts IslandView), or a form only the desktop's page
 * makes (desk.ts: mini, coach, input, drop), with the fields that form reads.
 */
type IslandShown = { form: string, tone: string, mood: string, label: string, recent: ReadonlyArray<{ title: string, tone: string }>, [field: string]: any }
/** What a click on the island asks for (island-dom.ts): its kind, and what that needs. */
type IslandAct = (action: { kind: string, [field: string]: unknown }) => void
/** What a view draws: an element, several, text, or nothing. */
type View = Node | string | null | false | undefined | ReadonlyArray<View>

/** The window's state: what state.ts's initialState can become (a task's view has the same shape). */
type State = Widened<typeof import('./state.ts').initialState>
/** What changes the state: its type, and the fields its reducer reads (each reducer destructures its own). */
type Action = { type?: string, [field: string]: any }
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
interface AgentApi {
  /** 'darwin' | 'win32' | 'linux': the page lays out its title bar around the system window buttons. */
  platform: string
  getInfo: Invoke<'agent:info'>
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
  removeModelProvider: Invoke<'models:remove'>
  loadHistory: Invoke<'history:load'>
  saveHistory: Invoke<'history:save'>
  listHistory: Invoke<'history:list'>
  searchHistory: Invoke<'history:search'>
  openConversation: Invoke<'history:open'>
  resumeTopic: Invoke<'history:resume-topic'>
  loadTrace: Invoke<'history:trace'>
  renameConversation: Invoke<'history:rename'>
  pinConversation: Invoke<'history:pin'>
  deleteConversation: Invoke<'history:delete'>
  restoreConversation: Invoke<'history:restore'>
  exportConversation: Invoke<'history:export'>
  earlierSegments: Invoke<'history:segments-before'>
  searchTimeline: Invoke<'history:search-messages'>
  rewind: Invoke<'timeline:rewind'>
  spinOffTask: Invoke<'task:spin-off'>
  startTask: Invoke<'task:start'>
  saveTask: Invoke<'task:save'>
  unfinishedTasks: Invoke<'task:unfinished'>
  finishedTasks: Invoke<'task:finished'>
  askTask: Invoke<'task:ask'>
  resumeTask: Invoke<'task:resume'>
  forgetTask: Invoke<'task:forget'>
  undoTask: Invoke<'task:undo'>
  closeTask: Invoke<'task:close'>
  stopTask: Invoke<'task:stop'>
  steerTask: Invoke<'task:steer'>
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
  getSources: Invoke<'sources:get'>
  saveSource: Invoke<'sources:save'>
  checkSource: Invoke<'sources:check'>
  pollSourceNow: Invoke<'sources:poll-now'>
  openSourcesFolder: Invoke<'sources:open-folder'>
  chooseSource: Invoke<'sources:choose'>
  installSource: Invoke<'sources:install'>
  cancelSourceInstall: Invoke<'sources:cancel-install'>
  removeSource: Invoke<'sources:remove'>
  /** What the island shows; the main process passes it to the desktop island while the window is away. */
  islandView: (...args: Args<'island:view'>) => void
  onFocusComposer: (callback: () => void) => Unlisten
  onIslandAction: (callback: (action: any) => void) => Unlisten
  onEvent: (callback: (event: any) => void) => Unlisten
}

/** The desktop island's bridge (desk-preload.cjs): dropped files are known to it only by their paths. */
interface DeskApi {
  onView: (callback: (view: any) => void) => Unlisten
  act: (...args: Args<'island:act'>) => void
  describeFiles: (files: ArrayLike<File>) => Promise<{ files?: Array<{ path: string, name: string, size: number }>, error?: string }>
  ask: (text: string, files: unknown[], images?: Array<{ id: string }>) => Promise<any>
  keepImage: Invoke<'island:keep-image'>
  /** The ask shortcut as the user presses it (island-main.ts ASK_SHORTCUT). */
  shortcut: string
}

interface Window {
  agent: AgentApi
  desk: DeskApi
}
