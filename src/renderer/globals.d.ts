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
 * null, or a list that starts empty, holds what is not written out yet (Untyped).
 */
type Widened<T> = [T] extends [never] ? Untyped
  : T extends null ? Untyped
  : T extends string ? string
  : T extends number ? number
  : T extends boolean ? boolean
  : T extends readonly (infer U)[] ? Widened<U>[]
  : T extends (...args: any[]) => any ? T
  : T extends object ? { -readonly [K in keyof T]: Widened<T[K]> }
  : T
/** The window's state: what state.ts's initialState can become (a task's view has the same shape). */
type State = Widened<typeof import('./state.ts').initialState>
/** What changes the state: its type, and the fields its reducer reads (each reducer destructures its own). */
type Action = { type?: string, [field: string]: any }
/** The state after an action: a new object, never the one given changed in place. */
type Reducer = (state: State, action: Action) => State

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
  removeSkill: Invoke<'ext:remove-skill'>
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
