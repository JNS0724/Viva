const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  /** 'darwin' | 'win32' | 'linux': the page lays out its title bar around the system window buttons. */
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('agent:info'),
  prompt: (text) => ipcRenderer.invoke('agent:prompt', text),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  newSession: () => ipcRenderer.invoke('agent:new-session'),
  setConfig: (configId, value) => ipcRenderer.invoke('agent:set-config', configId, value),
  respondPermission: (requestId, optionId) => ipcRenderer.invoke('agent:permission', requestId, optionId),
  answerQuestion: (questionId, answers) => ipcRenderer.invoke('agent:answer', questionId, answers),
  openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:save-key', key),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-key'),
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
  getExtensions: () => ipcRenderer.invoke('ext:get'),
  addMcpServer: (input) => ipcRenderer.invoke('ext:add-mcp', input),
  removeMcpServer: (name) => ipcRenderer.invoke('ext:remove-mcp', name),
  importSkill: () => ipcRenderer.invoke('ext:import-skill'),
  removeSkill: (id) => ipcRenderer.invoke('ext:remove-skill', id),
  openSkillDir: () => ipcRenderer.invoke('ext:open-skill-dir'),
  /** What the island shows; the main process passes it to the desktop island while the window is away. */
  islandView: (view) => ipcRenderer.send('island:view', view),
  /** What was clicked on the desktop island: allow, answer, stop. */
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
