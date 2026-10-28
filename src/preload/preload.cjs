const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Each call takes its channel's arguments, as the page is told it does (globals.d.ts AgentApi).
contextBridge.exposeInMainWorld('agent', /** @satisfies {AgentApi} */ ({
  /** 'darwin' | 'win32' | 'linux': the page lays out its title bar around the system window buttons. */
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('agent:info'),
  /** @param {{ id: string }[]} [images] pictures kept by keepImage, sent with the words */
  prompt: (text, images = []) => ipcRenderer.invoke('agent:prompt', text, images),
  /** A pasted or dropped picture into the pictures folder: { id, mimeType, size } (main/image-store.js). */
  keepImage: (bytes) => ipcRenderer.invoke('images:keep', bytes),
  /** Settings' 贴过的图片: its size and place; open, empty or move it. */
  imagesUsage: () => ipcRenderer.invoke('images:usage'),
  /** 完全 / 自动 / 工作区修改 / 仅可查看: dsh restarts with it on this conversation; { settings, info }. */
  setPermission: (level) => ipcRenderer.invoke('settings:set-permission', level),
  openImagesFolder: () => ipcRenderer.invoke('images:open-folder'),
  clearImages: () => ipcRenderer.invoke('images:clear'),
  moveImages: () => ipcRenderer.invoke('images:move'),
  /** Words for the turn that is running (viva-steer): { ok, reason? }. */
  steer: (text) => ipcRenderer.invoke('agent:steer', text),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  newSession: () => ipcRenderer.invoke('agent:new-session'),
  setConfig: (configId, value) => ipcRenderer.invoke('agent:set-config', configId, value),
  respondPermission: (requestId, optionId) => ipcRenderer.invoke('agent:permission', requestId, optionId),
  answerQuestion: (questionId, answers) => ipcRenderer.invoke('agent:answer', questionId, answers),
  /** Keys typed for a server the model set up; null declines. They go to the main process only. */
  provideSecrets: (requestId, values) => ipcRenderer.invoke('agent:secrets', requestId, values),
  openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:save-key', key),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-key'),
  setDeskIsland: (on) => ipcRenderer.invoke('settings:set-desk-island', on),
  setOpenAtLogin: (on) => ipcRenderer.invoke('settings:set-open-at-login', on),
  resetDeskPlace: () => ipcRenderer.invoke('settings:reset-desk-place'),
  getModels: () => ipcRenderer.invoke('models:get'),
  addModelProvider: (input) => ipcRenderer.invoke('models:add', input),
  removeModelProvider: (id) => ipcRenderer.invoke('models:remove', id),
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (messages) => ipcRenderer.invoke('history:save', messages),
  listHistory: (offset) => ipcRenderer.invoke('history:list', offset),
  searchHistory: (query) => ipcRenderer.invoke('history:search', query),
  openConversation: (id) => ipcRenderer.invoke('history:open', id),
  /** 回到这个话题 / 撤销 a new topic: { info, parentId } (history-ipc.js). */
  resumeTopic: (id) => ipcRenderer.invoke('history:resume-topic', id),
  loadTrace: (id, until) => ipcRenderer.invoke('history:trace', id, until),
  renameConversation: (id, title) => ipcRenderer.invoke('history:rename', id, title),
  pinConversation: (id, pinned) => ipcRenderer.invoke('history:pin', id, pinned),
  deleteConversation: (id) => ipcRenderer.invoke('history:delete', id),
  restoreConversation: (id) => ipcRenderer.invoke('history:restore', id),
  exportConversation: (id) => ipcRenderer.invoke('history:export', id),
  /** The one timeline: the segments before `id`, oldest first; messages across all of it that contain `query`. */
  earlierSegments: (id, limit) => ipcRenderer.invoke('history:segments-before', id, limit),
  searchTimeline: (query) => ipcRenderer.invoke('history:search-messages', query),
  /**
   * 回顾: the topics, the one last talked in first ({ topics, hasMore }); a topic's messages; a segment's; where a
   * message named by a link, hit or star is now; starring a message.
   */
  reviewTimeline: (after, filter) => ipcRenderer.invoke('history:review', after, filter),
  topicMessages: (topicId) => ipcRenderer.invoke('history:topic', topicId),
  segmentMessages: (id, whole) => ipcRenderer.invoke('history:segment', id, whole),
  locateMessage: (ref) => ipcRenderer.invoke('history:locate', ref),
  starMessage: (id, seq, starred) => ipcRenderer.invoke('history:star', id, seq, starred),
  starsIn: (ids) => ipcRenderer.invoke('history:stars-in', ids),
  starredMessages: () => ipcRenderer.invoke('history:starred'),
  /**
   * Back to something the user said ({ words, occurrence, keep }) and on with `text`:
   * { ok, info, conversation: { id, messages }, folds } | { ok: false, problem }.
   */
  rewind: (request) => ipcRenderer.invoke('timeline:rewind', request),
  /**
   * Background tasks: the running turn goes on in the background ({ words, keep, text }), and the
   * conversation goes on with `text`: { ok, task, info, conversation, folds } | { ok: false, reason | problem }.
   */
  spinOffTask: (request) => ipcRenderer.invoke('task:spin-off', request),
  /** 后台做: { text, words? } (words: the running turn's, to start from before it): { ok, task } | { ok: false, problem }. */
  startTask: (request) => ipcRenderer.invoke('task:start', request),
  /** Saved along the way and at its end ({ ended: true, status }: kept to be asked again, not offered as unfinished). */
  saveTask: (taskId, messages, options) => ipcRenderer.invoke('task:save', taskId, messages, options),
  /** Tasks an earlier launch left going: [{ id, title, segmentId, startedAt }]; taken up again, or let go. */
  unfinishedTasks: () => ipcRenderer.invoke('task:unfinished'),
  /** Tasks that had ended by an earlier launch: [{ task, status, endedAt, messages }]. */
  finishedTasks: () => ipcRenderer.invoke('task:finished'),
  /** 接着问: a task that ended is asked `text` as its next question: { ok } | { ok: false, problem }. */
  askTask: (taskId, text) => ipcRenderer.invoke('task:ask', taskId, text),
  resumeTask: (taskId) => ipcRenderer.invoke('task:resume', taskId),
  forgetTask: (taskId) => ipcRenderer.invoke('task:forget', taskId),
  undoTask: (taskId) => ipcRenderer.invoke('task:undo', taskId),
  closeTask: (taskId) => ipcRenderer.invoke('task:close', taskId),
  stopTask: (taskId) => ipcRenderer.invoke('task:stop', taskId),
  steerTask: (taskId, text) => ipcRenderer.invoke('task:steer', taskId, text),
  /** What the part that would fold did to the computer ({ keep }): { files: [{ path, times }], commands }. */
  rewindEffects: (request) => ipcRenderer.invoke('timeline:rewind-effects', request),
  /** A path folded off the conversation on screen: what it holds after the shared part ({ messages }), or back onto it. */
  foldedPath: (id) => ipcRenderer.invoke('timeline:folded', id),
  switchPath: (id) => ipcRenderer.invoke('timeline:switch-path', id),
  /** The working directory: { current, defaultDir, isDefault, recent }; a folder from the system dialog, or null. */
  getWorkDir: () => ipcRenderer.invoke('workdir:get'),
  chooseWorkDir: () => ipcRenderer.invoke('workdir:choose'),
  /** { ok, info, state } | { ok: false, needsConfirm, dir } | { ok: false, problem } | { ok: false, reason: 'busy' } */
  switchWorkDir: (dir, options) => ipcRenderer.invoke('workdir:switch', dir, options),
  forgetWorkDir: (dir) => ipcRenderer.invoke('workdir:forget', dir),
  /** Where a file or folder dragged onto the window is on disk ('' for one that is not on disk). */
  pathForFile: (file) => webUtils.getPathForFile(file),
  /** The folder in use, in Finder or Explorer. */
  revealWorkDir: () => ipcRenderer.invoke('workdir:reveal'),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  listMemories: (query) => ipcRenderer.invoke('memory:list', query),
  saveProfile: (changes) => ipcRenderer.invoke('memory:set-profile', changes),
  addMemory: (text, kind) => ipcRenderer.invoke('memory:add', text, kind),
  updateMemory: (id, text) => ipcRenderer.invoke('memory:update', id, text),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  restoreMemory: (memory) => ipcRenderer.invoke('memory:restore', memory),
  listInvalidMemories: () => ipcRenderer.invoke('memory:list-invalid'),
  reviveMemory: (id) => ipcRenderer.invoke('memory:revive', id),
  setOnboarding: (status) => ipcRenderer.invoke('memory:onboarding', status),
  addDocs: () => ipcRenderer.invoke('memory:add-docs'),
  listFiles: (rel) => ipcRenderer.invoke('files:list', rel),
  previewFile: (rel, offset = 0) => ipcRenderer.invoke('files:preview', rel, offset),
  revealFile: (rel) => ipcRenderer.invoke('files:reveal', rel),
  /** The apps registered to open a file, the default marked; `app` picks one of them, none the default. */
  fileApps: (rel) => ipcRenderer.invoke('files:apps', rel),
  openFile: (rel, app = null) => ipcRenderer.invoke('files:open', rel, app),
  fileImage: (rel) => ipcRenderer.invoke('files:image', rel),
  /** Watches the file on preview; null stops. Changes arrive as files_changed events. */
  watchFile: (rel) => ipcRenderer.invoke('files:watch', rel),
  getExtensions: () => ipcRenderer.invoke('ext:get'),
  removeMcpServer: (name) => ipcRenderer.invoke('ext:remove-mcp', name),
  updateMcpServer: (name, changes) => ipcRenderer.invoke('ext:update-mcp', name, changes),
  importDsh: (from) => ipcRenderer.invoke('ext:import-dsh', from),
  removeSkill: (id) => ipcRenderer.invoke('ext:remove-skill', id),
  getSources: () => ipcRenderer.invoke('sources:get'),
  /** changes: { enabled?, everyMinutes?, values? }; a secret left blank keeps the saved one. */
  saveSource: (id, changes) => ipcRenderer.invoke('sources:save', id, changes),
  /** Tests the form's values (saved ones where left blank) without saving them. */
  checkSource: (id, changes) => ipcRenderer.invoke('sources:check', id, changes),
  pollSourceNow: (id) => ipcRenderer.invoke('sources:poll-now', id),
  openSourcesFolder: () => ipcRenderer.invoke('sources:open-folder'),
  /** The folder dialog, then what the chosen folder is, to confirm; the path itself stays in the main process. */
  chooseSource: () => ipcRenderer.invoke('sources:choose'),
  installSource: () => ipcRenderer.invoke('sources:install'),
  cancelSourceInstall: () => ipcRenderer.invoke('sources:cancel-install'),
  removeSource: (id) => ipcRenderer.invoke('sources:remove', id),
  getFollowups: () => ipcRenderer.invoke('followups:get'),
  /** 跟进 on a card: { title, ask, remindAt, prepareBy, files, conversationId }. */
  acceptFollowup: (proposal) => ipcRenderer.invoke('followups:accept', proposal),
  declineFollowup: (proposal) => ipcRenderer.invoke('followups:decline', proposal),
  dismissFollowup: (id) => ipcRenderer.invoke('followups:dismiss', id),
  continueFollowup: (id) => ipcRenderer.invoke('followups:continue', id),
  prepareFollowupNow: (id) => ipcRenderer.invoke('followups:prepare-now', id),
  wakePreparation: () => ipcRenderer.invoke('followups:wake'),
  setPrepareSchedule: (schedule) => ipcRenderer.invoke('followups:set-schedule', schedule),
  pausePreparation: (minutes) => ipcRenderer.invoke('followups:pause', minutes),
  /** A message suggested for a follow-up: 'accept' (跟进), 'decline' (不重要) or 'never' (以后别问这类). */
  settleSuggestion: (id, action) => ipcRenderer.invoke('followups:suggestion', id, action),
  /** What the island shows; the main process passes it to the desktop island while the window is away. */
  islandView: (view) => ipcRenderer.send('island:view', view),
  /** The shortcut, pressed with the window in front: its own input takes the keyboard. */
  onFocusComposer: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('composer:focus', listener)
    return () => ipcRenderer.removeListener('composer:focus', listener)
  },
  /** What was clicked on the desktop island: allow, answer, stop, or a question asked there. */
  onIslandAction: (callback) => {
    const listener = (/** @type {Electron.IpcRendererEvent} */ _event, /** @type {unknown} */ action) => callback(action)
    ipcRenderer.on('island:action', listener)
    return () => ipcRenderer.removeListener('island:action', listener)
  },
  onEvent: (callback) => {
    const listener = (/** @type {Electron.IpcRendererEvent} */ _event, /** @type {unknown} */ payload) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
}))
