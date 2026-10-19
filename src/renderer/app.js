import { createExtensionActions } from './extension-actions.js'
import { createHistoryActions } from './history-actions.js'
import { createMemoryActions } from './memory-actions.js'
import { historyMessages, setupView } from './selectors.js'
import { initialState, isBusy, isRevealing, reduce } from './state.js'
import { render, renderStream, renderTick } from './view/render.js'
import { createScrollFollower } from './view/scroll-follow.js'

const TICK_MS = 1000
const MAX_FRAME_MS = 100
/** Moments when the conversation changes in a way worth keeping across launches. */
const SAVE_AFTER = new Set(['user_prompt', 'turn_end', 'error'])
const api = window.agent
const byId = (id) => document.getElementById(id)
/** The title bar makes room for the system window buttons: traffic lights on macOS, caption buttons elsewhere. */
const platform = api?.platform ?? 'darwin'
document.documentElement.dataset.platform = platform

const dom = {
  island: byId('island'),
  scroll: byId('scroll'),
  home: byId('home'),
  thread: byId('thread'),
  drawer: byId('drawer'),
  composer: byId('composer'),
  input: byId('composer-input'),
  sendBtn: byId('send-btn'),
  context: byId('composer-context'),
  newSession: byId('new-session'),
  toggleDrawer: byId('toggle-drawer'),
  openSettings: byId('open-settings'),
  settings: byId('settings-root'),
  modelArea: byId('model-area'),
  modelBtn: byId('model-btn'),
  modelMenu: byId('model-menu'),
  jumpLatest: byId('jump-latest'),
  toggleHistory: byId('toggle-history'),
  historyPanel: byId('history-panel'),
  historyClose: byId('history-close'),
  historySearch: byId('history-search'),
  historyList: byId('history-list'),
  toast: byId('toast-root'),
  openProfile: byId('open-profile'),
  profile: byId('profile-root'),
}
dom.follower = createScrollFollower(dom.scroll, dom.jumpLatest)
new ResizeObserver(() => dom.follower.onContentResize()).observe(dom.thread)

let state = initialState
let revealFrameId = 0
let lastFrameAt = 0
/** Nothing is saved until last launch's history has been read, so an early error can't overwrite it. */
let historyReady = false

function dispatch(action) {
  state = reduce(state, action)
  render(dom, state, handlers)
  startReveal()
  if (SAVE_AFTER.has(action.type)) saveHistory()
}

function saveHistory() {
  if (!historyReady || state.messages.length === 0) return
  api.saveHistory(historyMessages(state))
    .then((summary) => {
      dispatch({ type: 'conversation_saved', id: summary.id })
      historyActions.refreshIfOpen()
    })
    .catch((err) => console.error('[history] could not save the conversation:', errorMessage(err)))
}

async function loadHistory() {
  try {
    const saved = await api.loadHistory()
    if (!saved) return
    dispatch({ type: 'history_loaded', conversationId: saved.id, messages: saved.messages, savedAt: saved.updatedAt })
    dom.follower.jumpToLatest()
    historyActions.loadTrace(saved.id)
  } catch (err) {
    console.error('[history] could not load the last conversation:', errorMessage(err))
  } finally {
    historyReady = true
  }
}

/** Types out assistant text frame by frame; stops by itself once everything received is on screen. */
function revealFrame(now) {
  revealFrameId = 0
  const dt = Math.min(now - lastFrameAt, MAX_FRAME_MS)
  lastFrameAt = now
  state = reduce(state, { type: 'reveal_tick', dt })
  renderStream(dom, state, handlers)
  if (isRevealing(state)) revealFrameId = requestAnimationFrame(revealFrame)
}

function startReveal() {
  if (revealFrameId || !isRevealing(state)) return
  lastFrameAt = performance.now()
  revealFrameId = requestAnimationFrame(revealFrame)
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: msg"; keep only the message. */
const errorMessage = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const historyActions = createHistoryActions({
  api,
  getState: () => state,
  dispatch,
  searchField: dom.historySearch,
  errorMessage,
  newSession: () => handlers.newSession(),
  onOpened: () => {
    dom.follower.jumpToLatest()
    dom.input.focus()
  },
})

/** Sends `text` as the user's next question. @returns {boolean} false when the agent can't take it now */
function ask(text) {
  if (!text || setupView(state.info) || isBusy(state) || state.switching) return false
  dom.follower.resetForPrompt()
  dispatch({ type: 'user_prompt', text, at: Date.now() })
  api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  return true
}

const memoryActions = createMemoryActions({ api, getState: () => state, dispatch, errorMessage, showToast: historyActions.showToast, ask })
const extensionActions = createExtensionActions({ api, getState: () => state, dispatch, errorMessage })

/** What a toast's button does; history's undo keeps its own handler. */
const TOAST_ACTIONS = {
  'open-profile': () => memoryActions.openProfile(),
  'undo-memory': (toast) => memoryActions.undoMemoryDelete(toast.action.payload),
  'open-settings': () => handlers.openSettings(),
}

const handlers = {
  ...historyActions,
  ...memoryActions,
  ...extensionActions,
  send() {
    if (setupView(state.info)) return handlers.openSettings()
    const text = dom.input.value.trim()
    if (ask(text)) dom.input.value = ''
  },
  toastAction(toast) {
    dispatch({ type: 'toast_hide', key: toast.key })
    TOAST_ACTIONS[toast.action?.kind]?.(toast)
  },
  cancel() {
    api.cancel().catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  },
  respond(requestId, optionId) {
    dispatch({ type: 'permission_resolved', requestId, optionId, at: Date.now() })
    api.respondPermission(requestId, optionId).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  },
  async newSession() {
    if (state.switching) return
    dispatch({ type: 'session_switching' })
    try {
      dispatch({ type: 'new_session', info: await api.newSession() })
      dom.input.focus()
    } catch (err) {
      dispatch({ type: 'error', message: errorMessage(err) })
    }
  },
  suggest(text) {
    dom.input.value = text
    dom.input.focus()
  },
  async openSettings() {
    dispatch({ type: 'settings_open' })
    extensionActions.loadExtensions()
    try {
      dispatch({ type: 'settings_loaded', view: await api.getSettings() })
    } catch (err) {
      dispatch({ type: 'settings_failed', message: errorMessage(err) })
    }
  },
  closeSettings: () => dispatch({ type: 'settings_close' }),
  saveKey: (value) => applySettingsChange(() => api.saveApiKey(value), saveNotice),
  clearKey: () => applySettingsChange(() => api.clearApiKey(), () => '已清除保存的 key'),
  togglePicker: () => dispatch({ type: 'picker_toggle' }),
  async setConfig(configId, value) {
    try {
      dispatch({ type: 'config_applied', info: await api.setConfig(configId, value) })
    } catch (err) {
      dispatch({ type: 'error', message: `切换失败：${errorMessage(err)}` })
    }
  },
  openDrawer: (tab) => dispatch({ type: 'open_drawer', tab }),
  closeDrawer: () => dispatch({ type: 'close_drawer' }),
  toggleIsland: () => dispatch({ type: 'toggle_island' }),
}

function saveNotice(info) {
  if (info?.mode === 'live') return `已保存并连接 · ${info.model || 'DeepSeek'}`
  if (info?.mode === 'setup') return `已保存，但还不能连接：${setupView(info).title}`
  return '已保存，但没能连上 DeepSeek Harness，详情见对话区'
}

/** Saving or clearing the key restarts the agent in the main process, so the conversation starts over. */
async function applySettingsChange(request, noticeFor) {
  if (state.settings.busy) return
  dispatch({ type: 'settings_busy' })
  try {
    const { settings, info } = await request()
    dispatch({ type: 'settings_saved', view: settings, notice: noticeFor(info) })
    if (info) dispatch({ type: 'new_session', info })
  } catch (err) {
    dispatch({ type: 'settings_failed', message: errorMessage(err) })
  }
}

const EVENT_ACTIONS = {
  ready: (event) => ({ type: 'ready', info: event.info }),
  config: (event) => ({ type: 'config_applied', info: event.info }),
  update: (event) => ({ type: 'acp_update', update: event.update, at: Date.now() }),
  permission: (event) => ({
    type: 'permission_request', requestId: event.requestId, toolCall: event.toolCall, options: event.options, at: Date.now(),
  }),
  turn_end: (event) => ({ type: 'turn_end', stopReason: event.stopReason, at: Date.now() }),
  memory_context: (event) => ({ type: 'memory_context', injected: event.injected }),
  error: (event) => ({ type: 'error', message: event.message }),
}

function wireComposer() {
  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault()
    if (isBusy(state)) handlers.cancel()
    else handlers.send()
  })
  dom.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    handlers.send()
  })
  dom.newSession.addEventListener('click', () => handlers.newSession())
  dom.openSettings.addEventListener('click', () => handlers.openSettings())
  dom.openProfile.addEventListener('click', () => (state.memory.open ? handlers.closeProfile() : handlers.openProfile()))
  dom.modelBtn.addEventListener('click', () => handlers.togglePicker())
  dom.jumpLatest.addEventListener('click', () => dom.follower.jumpToLatest())
  dom.toggleDrawer.addEventListener('click', () => dispatch({ type: 'toggle_drawer' }))
  dom.toggleHistory.addEventListener('click', () => handlers.toggleHistory())
  dom.historyClose.addEventListener('click', () => handlers.closeHistory())
  dom.historySearch.addEventListener('input', () => handlers.searchHistory(dom.historySearch.value))
}

const isHistoryShortcut = (event) => (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'

/** Escape closes the innermost thing that is open. */
function closeTopmost() {
  if (state.settings.open) dispatch({ type: 'settings_close' })
  else if (state.memory.open) dispatch({ type: 'memory_close' })
  else if (state.history.menuFor) dispatch({ type: 'history_menu', id: null })
  else if (state.history.open) dispatch({ type: 'history_close' })
  else if (state.picker) dispatch({ type: 'picker_close' })
  else dispatch({ type: 'close_island' })
}

/**
 * Uses the event path captured at dispatch: a menu item re-renders the list when clicked,
 * so by the time the click reaches the document its target is no longer in the page.
 */
function closeHistoryOnOutsideClick(event) {
  const path = event.composedPath()
  const within = (el) => path.includes(el)
  if (state.history.menuFor && !path.some((el) => el.classList?.contains('history-menu'))) dispatch({ type: 'history_menu', id: null })
  if (state.history.open && ![dom.historyPanel, dom.toggleHistory, dom.toast].some(within)) dispatch({ type: 'history_close' })
}

function wireDismissal() {
  document.addEventListener('click', (event) => {
    if (state.island && !dom.island.contains(event.target)) dispatch({ type: 'close_island' })
    if (state.picker && !dom.modelArea.contains(event.target)) dispatch({ type: 'picker_close' })
    closeHistoryOnOutsideClick(event)
  })
  document.addEventListener('keydown', (event) => {
    if (isHistoryShortcut(event)) {
      event.preventDefault()
      handlers.toggleHistory()
    } else if (event.key === 'Escape') {
      closeTopmost()
    }
  })
}

function labelShortcuts() {
  const shortcut = platform === 'darwin' ? '⌘K' : 'Ctrl+K'
  dom.toggleHistory.title = `历史对话 ${shortcut}`
  dom.toggleHistory.setAttribute('aria-label', `历史对话（${shortcut}）`)
}

/** An MCP server that would not start is left out; say so once per connection instead of failing. */
function reportMcpProblems(info) {
  const dropped = info?.mcp?.dropped ?? []
  if (dropped.length === 0) return
  const names = dropped.map((item) => (item.name === 'memory' ? '记忆工具' : `「${item.name}」`)).join('、')
  historyActions.showToast(`${names} 没能连上，已暂时跳过`, { action: { label: '查看', kind: 'open-settings' }, ms: 8000 })
}

async function boot() {
  labelShortcuts()
  render(dom, state, handlers)
  if (!api) {
    dispatch({ type: 'error', message: '没有找到 preload 提供的 window.agent，请通过 Electron 启动。' })
    return
  }
  api.onEvent((event) => {
    if (event?.type === 'memory_changed') return memoryActions.onMemoryChanged(event)
    const toAction = EVENT_ACTIONS[event?.type]
    if (toAction) dispatch(toAction(event))
    if (event?.type === 'ready') reportMcpProblems(event.info)
  })
  await Promise.all([loadHistory(), memoryActions.loadMemory()])
  wireComposer()
  wireDismissal()
  setInterval(() => renderTick(dom, state, handlers), TICK_MS)
  const info = await api.getInfo()
  if (info?.mode && info.mode !== 'connecting') dispatch({ type: 'ready', info })
  dom.input.focus()
}

boot().catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
