const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** The preload keeps at most one heartbeat awaiting its supervisor. No page content is inspected. */
/** @type {string | undefined} */
let diagnosticRunId
let diagnosticActive = 0
let diagnosticHealthPending = false
let diagnosticLastPulse = performance.now()
const diagnosticProcessId = globalThis.crypto?.randomUUID?.()
ipcRenderer.on('diagnostics:binding', (_event, runId) => {
  if (typeof runId === 'string' && /^[a-f0-9-]{36}$/.test(runId)) diagnosticRunId = runId
})
void ipcRenderer.invoke('diagnostics:binding').then(runId => { diagnosticRunId = runId }).catch(() => {})
if (diagnosticProcessId) setInterval(() => {
  const now = performance.now(), eventLoopDelayMs = Math.max(0, now - diagnosticLastPulse - 5000)
  diagnosticLastPulse = now
  if (diagnosticHealthPending) return
  diagnosticHealthPending = true
  void ipcRenderer.invoke('diagnostics:health', { type: 'diagnostic-health', version: 1, component: 'renderer',
    processInstanceId: diagnosticProcessId, ...(diagnosticRunId ? { diagnosticRunId } : {}),
    activeCount: diagnosticActive, oldestMs: 0, eventLoopDelayMs, sinkState: 'ready', droppedCount: 0,
  }).then(runId => { diagnosticRunId = runId }).catch(() => {}).finally(() => { diagnosticHealthPending = false })
}, 5000)

/** @param {unknown} event */
function bindDiagnosticEvent(event) {
  if (!event || typeof event !== 'object') return undefined
  return { ...event, ...(diagnosticRunId ? { diagnostics: { version: 1,
    traceId: globalThis.crypto.randomUUID().replaceAll('-', ''), spanId: globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16), diagnosticRunId,
  } } : {}) }
}

/**
 * @template {import('../shared/ipc-contract.ts').Channel} C
 * @param {C} channel
 * @param {import('../shared/ipc-contract.ts').ChannelArgs<C>} args
 * @returns {Promise<C extends keyof import('../shared/ipc-results.ts').IpcResults ? import('../shared/ipc-results.ts').IpcResults[C] : unknown>}
 */
function diagnosticInvoke(channel, args) {
  /** @type {import('../diagnostics/contracts.ts').DiagnosticContext | undefined} */
  let diagnostics
  try {
    const hex = (/** @type {number} */ size) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(size)), value => value.toString(16).padStart(2, '0')).join('')
    diagnostics = { version: 1, traceId: hex(16), spanId: hex(8), ...(diagnosticRunId ? { diagnosticRunId } : {}) }
  } catch { return ipcRenderer.invoke(channel, ...args) }
  diagnosticActive++
  const started = performance.now()
  /** @param {import('../diagnostics/contracts.ts').DiagnosticEvent} event */
  const report = event => { try { ipcRenderer.send('diagnostics:event', { ...event, diagnostics }) } catch { /* Logging must not fail a call. */ } }
  report({ event: 'operation.start', operation: channel === 'memory:get' ? 'memory.get' : 'ipc' })
  return ipcRenderer.invoke('diagnostics:invoke', { channel, args, diagnostics }).then(value => {
    report({ event: 'operation.end', operation: channel === 'memory:get' ? 'memory.get' : 'ipc', outcome: 'completed', metrics: { durationMs: performance.now() - started } })
    diagnosticActive--
    return value
  }, error => {
    diagnosticActive--
    report({ event: 'operation.end', operation: channel === 'memory:get' ? 'memory.get' : 'ipc', outcome: 'failed', reason: 'unknown_error', metrics: { durationMs: performance.now() - started } })
    throw error
  })
}

// Each call takes its channel's arguments, as the page is told it does (globals.d.ts AgentApi).
contextBridge.exposeInMainWorld('agent', /** @satisfies {AgentApi} */ ({
  reportDiagnostic: (event) => { try { ipcRenderer.send('diagnostics:event', bindDiagnosticEvent(event)) } catch { /* Optional observation only. */ } },
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
  getSnapshot: (options) => ipcRenderer.invoke('agent:snapshot', ...options ? [options] : []),
  waits: () => ipcRenderer.invoke('agent:waits'),
  /** @param {{ id: string }[]} [images] pictures kept by keepImage, sent with the words */
  prompt: (text, images = [], operation = undefined, feedItemId = undefined) => ipcRenderer.invoke('agent:prompt', text, images, operation, feedItemId),
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
  steer: (text, operation) => ipcRenderer.invoke('agent:steer', text, operation),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  newSession: () => ipcRenderer.invoke('agent:new-session'),
  setConfig: (configId, value) => ipcRenderer.invoke('agent:set-config', configId, value),
  respondPermission: (requestId, optionId) => ipcRenderer.invoke('agent:permission', requestId, optionId),
  answerQuestion: (questionId, answers, operation) => ipcRenderer.invoke('agent:answer', questionId, answers, operation),
  /** Keys typed for a server the model set up; null declines. They go to the main process only. */
  provideSecrets: (requestId, values) => ipcRenderer.invoke('agent:secrets', requestId, values),
  openLink: (url) => ipcRenderer.invoke('shell:open-link', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveApiKey: (key) => ipcRenderer.invoke('settings:save-key', key),
  clearApiKey: () => ipcRenderer.invoke('settings:clear-key'),
  setDeskIsland: (on) => ipcRenderer.invoke('settings:set-desk-island', on),
  setWebSearch: (on) => ipcRenderer.invoke('settings:set-web-search', on),
  setOpenAtLogin: (on) => ipcRenderer.invoke('settings:set-open-at-login', on),
  getModels: () => ipcRenderer.invoke('models:get'),
  addModelProvider: (input) => ipcRenderer.invoke('models:add', input),
  updateModelProvider: (id, input) => ipcRenderer.invoke('models:update', id, input),
  removeModelProvider: (id) => ipcRenderer.invoke('models:remove', id),
  discoverModels: (input, providerId) => ipcRenderer.invoke('models:discover', input, providerId),
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (messages, mark) => ipcRenderer.invoke('history:save', messages, ...mark ? [mark] : []),
  listHistory: (offset) => ipcRenderer.invoke('history:list', offset),
  searchHistory: (query) => ipcRenderer.invoke('history:search', query),
  /** 回到这个话题 / 撤销 a new topic: { info, parentId } (history-ipc.js). */
  resumeTopic: (id) => ipcRenderer.invoke('history:resume-topic', id),
  /** Before 继续这个话题: its directory, whether it is there, whether it is the one in use. */
  resumeCheck: (id) => ipcRenderer.invoke('history:resume-check', id),
  /** Its own session gone: a new conversation in `dir` going on from its saved records. */
  continueFromRecords: (id, dir) => ipcRenderer.invoke('history:continue-from-records', id, dir),
  loadTrace: (id, until) => ipcRenderer.invoke('history:trace', id, until),
  loadModelRequest: (conversationId, sessionId, turn, step) => ipcRenderer.invoke('history:model-request', conversationId, sessionId, turn, step),
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
  getMemory: (options) => typeof globalThis.crypto === 'undefined' ? ipcRenderer.invoke('memory:get', ...options ? [options] : []) : diagnosticInvoke('memory:get', options ? [options] : []),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  openDiagnosticsFolder: () => ipcRenderer.invoke('diagnostics:open-folder'),
  diagnosticsStatus: () => ipcRenderer.invoke('diagnostics:status'),
  clearDiagnostics: () => ipcRenderer.invoke('diagnostics:clear'),
  debugDiagnostics: (enabled) => ipcRenderer.invoke('diagnostics:debug', enabled),
  getDreamStatus: () => ipcRenderer.invoke('memory:dream-status'),
  runDream: () => ipcRenderer.invoke('memory:run-dream'),
  listMemoryFiles: (request) => ipcRenderer.invoke('memory:list-files', request),
  readMemoryFile: (identity, restrictionId) => ipcRenderer.invoke('memory:read-file', identity, restrictionId),
  setMemoryFileEnabled: (request) => ipcRenderer.invoke('memory:set-file-enabled', request),
  undoMemoryFile: (request) => ipcRenderer.invoke('memory:undo-file', request),
  createMemoryFile: (request) => ipcRenderer.invoke('memory:create-file', request),
  editMemoryFile: (request) => ipcRenderer.invoke('memory:edit-file', request),
  forgetMemoryFile: (request) => ipcRenderer.invoke('memory:forget-file', request),
  saveProfile: (changes, operation) => ipcRenderer.invoke('memory:set-profile', changes, operation),
  rebuildMemoryIndexes: () => ipcRenderer.invoke('memory:rebuild-indexes'),
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
  listFeed: () => ipcRenderer.invoke('feed:list'),
  continueFeed: (id) => ipcRenderer.invoke('feed:continue', id),
  markFeedSeen: (id) => ipcRenderer.invoke('feed:seen', id),
  listFeedSources: () => ipcRenderer.invoke('feed-sources:list'),
  createFeedSource: (input) => ipcRenderer.invoke('feed-sources:create', input),
  updateFeedSource: (id, changes) => ipcRenderer.invoke('feed-sources:update', id, changes),
  pauseFeedSource: (id, paused) => ipcRenderer.invoke('feed-sources:pause', id, paused),
  deleteFeedSource: (id) => ipcRenderer.invoke('feed-sources:delete', id),
  runFeedSourceNow: (id) => ipcRenderer.invoke('feed-sources:run-now', id),
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
