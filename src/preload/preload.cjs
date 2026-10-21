const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  /** 'darwin' | 'win32' | 'linux': the page lays out its title bar around the system window buttons. */
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('agent:info'),
  prompt: (text) => ipcRenderer.invoke('agent:prompt', text),
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
  resetDeskPlace: () => ipcRenderer.invoke('settings:reset-desk-place'),
  getModels: () => ipcRenderer.invoke('models:get'),
  addModelProvider: (input) => ipcRenderer.invoke('models:add', input),
  removeModelProvider: (id) => ipcRenderer.invoke('models:remove', id),
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (messages) => ipcRenderer.invoke('history:save', messages),
  listHistory: (offset) => ipcRenderer.invoke('history:list', offset),
  searchHistory: (query) => ipcRenderer.invoke('history:search', query),
  openConversation: (id) => ipcRenderer.invoke('history:open', id),
  loadTrace: (id, until) => ipcRenderer.invoke('history:trace', id, until),
  renameConversation: (id, title) => ipcRenderer.invoke('history:rename', id, title),
  pinConversation: (id, pinned) => ipcRenderer.invoke('history:pin', id, pinned),
  deleteConversation: (id) => ipcRenderer.invoke('history:delete', id),
  restoreConversation: (id) => ipcRenderer.invoke('history:restore', id),
  exportConversation: (id) => ipcRenderer.invoke('history:export', id),
  /** The one timeline: the segments before `id`, oldest first; messages across all of it that contain `query`. */
  earlierSegments: (id, limit) => ipcRenderer.invoke('history:segments-before', id, limit),
  searchTimeline: (query) => ipcRenderer.invoke('history:search-messages', query),
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
  removeSkill: (id) => ipcRenderer.invoke('ext:remove-skill', id),
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
    const listener = (_event, action) => callback(action)
    ipcRenderer.on('island:action', listener)
    return () => ipcRenderer.removeListener('island:action', listener)
  },
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
})
