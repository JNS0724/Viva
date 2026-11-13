const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Each call takes its channel's arguments, as the page is told it does (globals.d.ts AgentApi).
contextBridge.exposeInMainWorld('agent', /** @satisfies {AgentApi} */ ({
  getLanguage: () => ipcRenderer.invoke('language:get'),
  setLanguage: (language) => ipcRenderer.invoke('language:set', language),
  onLanguage: (callback) => {
    const listener = (/** @type {Electron.IpcRendererEvent} */ _event, /** @type {import('../shared/i18n/locale.ts').LanguageState} */ state) => callback(state)
    ipcRenderer.on('language:changed', listener)
    return () => ipcRenderer.removeListener('language:changed', listener)
  },
  /** 'darwin' | 'win32' | 'linux': the page lays out its title bar around the system window buttons. */
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('agent:info'),
  waits: () => ipcRenderer.invoke('agent:waits'),
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
  setWebSearch: (on) => ipcRenderer.invoke('settings:set-web-search', on),
  setOpenAtLogin: (on) => ipcRenderer.invoke('settings:set-open-at-login', on),
  resetDeskPlace: () => ipcRenderer.invoke('settings:reset-desk-place'),
  getModels: () => ipcRenderer.invoke('models:get'),
  addModelProvider: (input) => ipcRenderer.invoke('models:add', input),
  updateModelProvider: (id, input) => ipcRenderer.invoke('models:update', id, input),
  removeModelProvider: (id) => ipcRenderer.invoke('models:remove', id),
  discoverModels: (input, providerId) => ipcRenderer.invoke('models:discover', input, providerId),
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (messages) => ipcRenderer.invoke('history:save', messages),
  listHistory: (offset) => ipcRenderer.invoke('history:list', offset),
  searchHistory: (query) => ipcRenderer.invoke('history:search', query),
  /** 回到这个话题 / 撤销 a new topic: { info, parentId } (history-ipc.js). */
  resumeTopic: (id) => ipcRenderer.invoke('history:resume-topic', id),
  /** Before 继续这个话题: its directory, whether it is there, whether it is the one in use. */
  resumeCheck: (id) => ipcRenderer.invoke('history:resume-check', id),
  /** Its own session gone: a new conversation in `dir` going on from its saved records. */
  continueFromRecords: (id, dir) => ipcRenderer.invoke('history:continue-from-records', id, dir),
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
   * 回顾: the topics, the one last talked in first ({ topics, hasMore }); a part of a topic or a segment to read
   * ({ topic, total, from, messages }); where a message named by a link, hit or star is now; starring a message.
   */
  reviewTimeline: (after, filter) => ipcRenderer.invoke('history:review', after, filter),
  readHistory: (key, request) => ipcRenderer.invoke('history:read', key, request),
  locateMessage: (ref) => ipcRenderer.invoke('history:locate', ref),
  starMessage: (id, seq, starred) => ipcRenderer.invoke('history:star', id, seq, starred),
  starsIn: (ids) => ipcRenderer.invoke('history:stars-in', ids),
  starredMessages: () => ipcRenderer.invoke('history:starred'),
  /**
   * Back to something the user said ({ words, occurrence, keep }) and on with `text`:
   * { ok, info, conversation: { id, messages }, folds } | { ok: false, problem }.
   */
  rewind: (request) => ipcRenderer.invoke('timeline:rewind', request),
  /** The tasks an earlier launch kept, ended or interrupted: [{ task, status, endedAt, messages }]. */
  finishedTasks: () => ipcRenderer.invoke('task:finished'),
  closeTask: (taskId) => ipcRenderer.invoke('task:close', taskId),
  stopTask: (taskId) => ipcRenderer.invoke('task:stop', taskId),
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
  restartMcpServer: (name) => ipcRenderer.invoke('ext:restart-mcp', name),
  updateMcpServer: (name, changes) => ipcRenderer.invoke('ext:update-mcp', name, changes),
  importDsh: (from) => ipcRenderer.invoke('ext:import-dsh', from),
  removeSkill: (id) => ipcRenderer.invoke('ext:remove-skill', id),
  revealSkill: (id) => ipcRenderer.invoke('ext:reveal-skill', id),
  skillSources: () => ipcRenderer.invoke('ext:skill-sources'),
  scanSkills: (from) => ipcRenderer.invoke('ext:scan-skills', from),
  importSkills: (scanId, picks) => ipcRenderer.invoke('ext:import-skills', scanId, picks),
  mcpSources: () => ipcRenderer.invoke('ext:mcp-sources'),
  scanMcp: (from) => ipcRenderer.invoke('ext:scan-mcp', from),
  importMcp: (scanId, picks) => ipcRenderer.invoke('ext:import-mcp', scanId, picks),
  getPlugins: () => ipcRenderer.invoke('plugins:get'),
  /** What a spec (npm name, git address, folder) names, before anything is installed. */
  inspectPlugin: (spec) => ipcRenderer.invoke('plugins:inspect', spec),
  /** The dsh plugins the company source finds for `query`: { ok, entries } | { ok: false, problem, detail }. */
  searchPluginCatalog: (query) => ipcRenderer.invoke('plugins:catalog', query),
  /** approvedBuilds: the dependency build scripts the user allowed after a first attempt asked. */
  installPlugin: (spec, approvedBuilds) => ipcRenderer.invoke('plugins:install', spec, approvedBuilds),
  removePlugin: (name) => ipcRenderer.invoke('plugins:remove', name),
  setPluginEnabled: (name, enabled) => ipcRenderer.invoke('plugins:set-enabled', name, enabled),
  getPluginSource: () => ipcRenderer.invoke('plugins:source'),
  setPluginSource: (registry, token) => ipcRenderer.invoke('plugins:set-source', registry, token),
  listSchedules: () => ipcRenderer.invoke('schedules:list'),
  acceptSchedule: (proposalId, edits) => (edits ? ipcRenderer.invoke('schedules:accept', proposalId, edits) : ipcRenderer.invoke('schedules:accept', proposalId)),
  declineSchedule: (proposalId) => ipcRenderer.invoke('schedules:decline', proposalId),
  pauseSchedule: (id, paused) => ipcRenderer.invoke('schedules:pause', id, paused),
  deleteSchedule: (id) => ipcRenderer.invoke('schedules:delete', id),
  listSources: () => ipcRenderer.invoke('sources:list'),
  pauseSource: (id, paused) => ipcRenderer.invoke('sources:pause', id, paused),
  deleteSource: (id) => ipcRenderer.invoke('sources:delete', id),
  listFeed: () => ipcRenderer.invoke('feed:list'),
  markFeedSeen: (id) => ipcRenderer.invoke('feed:seen', id),
  /** What the island shows; the main process passes it to the desktop island while the window is away. */
  islandView: (view) => ipcRenderer.send('island:view', view),
  islandAskResult: (receiptId, result) => ipcRenderer.send('island:ask-result', receiptId, result),
  getDraft: () => ipcRenderer.invoke('draft:get'),
  updateDraft: (draft) => ipcRenderer.send('draft:update', draft),
  appendDraftImage: (key, image) => ipcRenderer.invoke('draft:append-image', key, image),
  keepDraftImages: (key, images) => ipcRenderer.invoke('draft:keep-images', key, images),
  appendDraftFiles: (key, paths) => ipcRenderer.invoke('draft:append-files', key, paths),
  onDraft: (callback) => {
    const listener = (/** @type {Electron.IpcRendererEvent} */ _event, /** @type {import('../shared/composer-draft.ts').DraftSnapshot} */ draft) => callback(draft)
    ipcRenderer.on('draft:changed', listener)
    return () => ipcRenderer.removeListener('draft:changed', listener)
  },
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
