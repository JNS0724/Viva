import { withFiles } from '../shared/attachments.js'
import { createExtensionActions } from './extension-actions.js'
import { createFilesActions } from './files-actions.js'
import { createHistoryActions } from './history-actions.js'
import { createMemoryActions } from './memory-actions.js'
import { createModelActions } from './model-actions.js'
import { islandView } from './island-view.js'
import { answersFrom } from './question-state.js'
import { hubPage } from './hub-state.js'
import { historyMessages, setupView } from './selectors.js'
import { initialState, isBusy, isRevealing, reduce } from './state.js'
import { createRewindActions } from './rewind-actions.js'
import { createTaskActions } from './task-actions.js'
import { liveTasks, mentionedTask, mentionNameOf, routeOf, taskTab } from './tasks-state.js'
import { createTimelineActions } from './timeline-actions.js'
import { createWorkDirActions } from './workdir-actions.js'
import { render, renderRouteHint, renderSendButton, renderStream, renderTick } from './view/render.js'
import { createScrollFollower } from './view/scroll-follow.js'

const TICK_MS = 1000
const MAX_FRAME_MS = 100
/** Moments when the conversation changes in a way worth keeping across launches. */
const SAVE_AFTER = new Set(['user_prompt', 'user_steer', 'steer_failed', 'turn_end', 'error'])
const STEER_LOST = '插话没有送到助手，等这一轮结束后再说一次'
const api = window.agent
const byId = (id) => document.getElementById(id)
/** The title bar makes room for the system window buttons: traffic lights on macOS, caption buttons elsewhere. */
const platform = api?.platform ?? 'darwin'
document.documentElement.dataset.platform = platform

const dom = {
  island: byId('island'),
  scroll: byId('scroll'),
  home: byId('home'),
  earlier: byId('earlier'),
  thread: byId('thread'),
  drawer: byId('drawer'),
  composer: byId('composer'),
  input: byId('composer-input'),
  routeHint: byId('route-hint'),
  sendBtn: byId('send-btn'),
  context: byId('composer-context'),
  workdirArea: document.querySelector('.workdir-area'),
  workdirMenu: byId('workdir-menu'),
  workdirConfirm: byId('workdir-confirm-root'),
  rewindConfirm: byId('rewind-confirm-root'),
  toggleDrawer: byId('toggle-drawer'),
  settings: byId('settings-root'),
  modelArea: byId('model-area'),
  modelBtn: byId('model-btn'),
  modelMenu: byId('model-menu'),
  jumpLatest: byId('jump-latest'),
  historySearch: byId('history-search'),
  historyList: byId('history-list'),
  toast: byId('toast-root'),
  openProfile: byId('open-profile'),
  profile: byId('profile-root'),
  /** 搜索 · 关于你 · 设置, one page under the title bar (view/hub.js). */
  hub: byId('hub'),
  hubBack: byId('hub-back'),
  hubNavs: [...document.querySelectorAll('.hub-nav')],
  hubPages: [...document.querySelectorAll('.hub-page')],
  hubSearchKey: byId('hub-search-key'),
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
  publishIsland()
  if (SAVE_AFTER.has(action.type)) saveHistory()
}

let publishedIsland = ''

/** The desktop island (desk.js) shows the same view while the window is in the background; send it when it changes. */
function publishIsland() {
  const view = JSON.stringify(islandView(state))
  if (view === publishedIsland || !api?.islandView) return
  publishedIsland = view
  api.islandView(JSON.parse(view))
}

/** The card the agent waits on, brought into view with its first button focused. */
function jumpToCard() {
  const card = dom.thread.querySelector('.confirm')
  if (!card) return
  card.scrollIntoView({ block: 'center', behavior: 'smooth' })
  card.querySelector('button')?.focus({ preventScroll: true })
}

/** The task in the background that asks `questionId`, if one does. */
const askingTask = (questionId) => liveTasks(state).find((task) => task.question?.questionId === questionId)

/**
 * What the island asks for, from the title bar or the desktop. Answers name the request or question they
 * were shown for, and one that has since closed is dropped.
 */
const ISLAND_ACTIONS = {
  toggle: () => dispatch({ type: 'toggle_island' }),
  jump: jumpToCard,
  cancel: () => isBusy(state) && handlers.cancel(),
  trace: () => handlers.openDrawer('trace'),
  /** A task's line in the island's 后台 list: what it did, in its tab of the drawer. */
  task: ({ taskId }) => handlers.openDrawer(taskTab(taskId)),
  /** 停下 on a task's line in the island's 后台 list. */
  'stop-task': ({ taskId }) => handlers.stopTask(taskId),
  /** 放到后台, offered on the opened island once a turn runs a while (view/island-dom.js offersBackground). */
  background: () => {
    dispatch({ type: 'close_island' })
    taskActions.moveToBackground()
  },
  /** The conversation's, or one a task in the background waits on (island-view.js background). */
  permission: ({ requestId, optionId }) => {
    const asked = [state.permission, ...liveTasks(state).map((task) => task.permission)].some((item) => item?.requestId === requestId)
    if (asked) handlers.respond(requestId, optionId)
  },
  answer: ({ questionId, id, label }) => {
    if (state.question?.questionId === questionId) return handlers.pickOption(id, label)
    const task = askingTask(questionId)
    return task ? handlers.pickTaskOption(task.id, id, label) : undefined
  },
  skip: ({ questionId }) => {
    if (state.question?.questionId === questionId) return handlers.skipQuestion()
    const task = askingTask(questionId)
    return task ? handlers.skipTaskQuestion(task.id) : undefined
  },
  /** Asked on the desktop island, with the files dropped there: into this conversation, as if typed here. */
  ask: ({ text, files }) => {
    if (!ask(withFiles(text, files), { via: 'island' })) historyActions.showToast('Viva 岛上的问题没有送出：助手现在还不能接收')
  },
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
    dispatch({ type: 'history_loaded', conversationId: saved.id, messages: saved.messages, savedAt: saved.updatedAt, folds: saved.folds ?? [] })
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
  jumpTo: (hit) => timelineActions.jumpTo(hit),
})

/** How long a message found by search stays marked after the timeline scrolls to it. */
const FOUND_MS = 2400

/** Scrolls a message of the timeline (its `data-msg`, view/thread.js markMessage) to the middle and marks it a moment. */
function revealMessage(msgId) {
  const row = dom.scroll.querySelector(`[data-msg="${CSS.escape(msgId)}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center' })
  row.classList.add('msg-found')
  setTimeout(() => row.classList.remove('msg-found'), FOUND_MS)
}

/**
 * Sends `text` as the user's next question, or, while the agent works, into the turn it is on — unless it is
 * about something else, when that turn moves to the background first (tasks-state.js routeOf);
 * `via: 'island'` when it was asked on the desktop island.
 * @returns {boolean} false when the agent can't take it now
 */
function ask(text, { via = null } = {}) {
  if (!text || setupView(state.info) || state.switching) return false
  // 「#name …」: to the background task it names, whether or not the conversation on screen is busy:
  // into its turn while it goes on, as its next question once it has ended.
  const mentioned = mentionedTask(state, text)
  if (mentioned) {
    // Only the name so far (接着问 just wrote it): nothing to send yet.
    if (!mentioned.text) return false
    if (mentioned.ended) taskActions.askTask(mentioned.taskId, mentioned.text)
    else taskActions.steerTask(mentioned.taskId, mentioned.text)
    return true
  }
  if (isBusy(state) && routeOf(state, text) === 'other') {
    taskActions.moveAndAsk(text)
    return true
  }
  if (isBusy(state)) return steer(text, via)
  dom.follower.resetForPrompt()
  dispatch({ type: 'user_prompt', text, at: Date.now(), via })
  api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  return true
}

/** Words said as a turn was ending: sent as the next question once it has ended. */
let afterTurn = []

/**
 * Said while the agent works: into the running turn, which reads it at its next step (the viva-steer plugin).
 * Should that turn have just ended, the words go as the next question; should they not get through at all,
 * they stay in the thread marked as not sent.
 */
function steer(text, via) {
  dispatch({ type: 'user_steer', text, via })
  const { id } = state.messages.at(-1)
  api.steer(text)
    .then((result) => {
      if (result.ok) return
      if (result.reason !== 'idle') throw new Error(STEER_LOST)
      if (isBusy(state)) afterTurn = [...afterTurn, text]
      else resend(text)
    })
    .catch((err) => {
      dispatch({ type: 'steer_failed', id })
      historyActions.showToast(errorMessage(err) || STEER_LOST)
    })
  return true
}

function resend(text) {
  dispatch({ type: 'steer_resent', at: Date.now() })
  api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
}

function sendAfterTurn() {
  if (!afterTurn.length) return
  const text = afterTurn.join('\n\n')
  afterTurn = []
  resend(text)
}

/** Answers the agent's open question; the reply shows at once, like an approval. */
function answer(answers) {
  const question = state.question
  if (!question) return
  dispatch({ type: 'question_answered', questionId: question.questionId, answers, at: Date.now() })
  api.answerQuestion(question.questionId, answers)
    .then((accepted) => accepted || historyActions.showToast('这个问题已经结束，回答没有送出'))
    .catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
}

async function provideSecrets(values) {
  const secret = state.secret
  if (!secret) return
  try {
    const accepted = await api.provideSecrets(secret.requestId, values)
    if (!accepted) historyActions.showToast('这次接入已经结束了')
    dispatch({ type: 'secret_resolved', requestId: secret.requestId, provided: values !== null, at: Date.now() })
  } catch (err) {
    historyActions.showToast(errorMessage(err))
  }
}

const memoryActions = createMemoryActions({ api, getState: () => state, dispatch, errorMessage, showToast: historyActions.showToast, ask })
const rewindActions = createRewindActions({ api, getState: () => state, dispatch, showToast: historyActions.showToast, errorMessage, ask })
const taskActions = createTaskActions({
  api, getState: () => state, dispatch, showToast: historyActions.showToast, errorMessage, ask, steer: (text) => steer(text, null), deliver: handleEvent,
  isTyping: () => Boolean(dom.input.value.trim()),
})
const timelineActions = createTimelineActions({ api, getState: () => state, dispatch, scroll: dom.scroll, reveal: revealMessage })
const workDirActions = createWorkDirActions({ api, getState: () => state, dispatch, errorMessage, showToast: historyActions.showToast })
const extensionActions = createExtensionActions({ api, getState: () => state, dispatch, errorMessage })
const modelActions = createModelActions({ api, getState: () => state, dispatch, errorMessage })
const filesActions = createFilesActions({ api, getState: () => state, dispatch, errorMessage })

/** What a toast's button does. */
const TOAST_ACTIONS = {
  'open-profile': () => memoryActions.openProfile(),
  'undo-memory': (toast) => memoryActions.undoMemoryDelete(toast.action.payload),
  'open-settings': () => handlers.openSettings(),
}

const handlers = {
  ...historyActions,
  ...memoryActions,
  ...extensionActions,
  ...modelActions,
  ...filesActions,
  /** Going back to something the user said: its bar and the editor in place (view/rewind.js). */
  ...rewindActions,
  /** Background tasks: 撤销 on the line a move leaves, and stopping or closing one. */
  undoMove: () => taskActions.undoMove(),
  /** 放到后台, beside a turn the agent said will take long (view/thread.js offerRow). */
  moveToBackground: () => taskActions.moveToBackground(),
  stopTask: (taskId) => taskActions.stopTask(taskId),
  closeTask: (taskId) => taskActions.closeTask(taskId),
  pickTaskOption: (taskId, id, label) => taskActions.pickTaskOption(taskId, id, label),
  /** A task's report in the thread, put away (view/thread.js reportCard). */
  dismissReport: (taskId) => taskActions.dismissReport(taskId),
  /** 接着问 on a task that ended (its card, its drawer tab): 「#name 」 in the input, for the words to go to it. */
  followUpTask(taskId) {
    const task = state.tasks.list.find((entry) => entry.id === taskId)
    if (!task) return
    dom.input.value = `#${mentionNameOf(task)} `
    dom.input.focus()
    renderSendButton(dom, state)
    renderRouteHint(dom, state)
  },
  /** A task the last launch left going (view/thread.js unfinishedCard): 接着做, or 不做了. */
  resumeUnfinished: (taskId) => taskActions.resumeUnfinished(taskId),
  forgetUnfinished: (taskId) => taskActions.forgetUnfinished(taskId),
  submitTaskAnswer: (taskId) => taskActions.submitTaskAnswer(taskId),
  skipTaskQuestion: (taskId) => taskActions.skipTaskQuestion(taskId),
  send() {
    if (setupView(state.info)) return handlers.openSettings()
    // 「#name 」 with no words yet (接着问 just wrote it): nothing to send, to the task or anywhere else.
    if (!state.question && mentionedTask(state, dom.input.value)?.text === '') return undefined
    const text = dom.input.value.trim()
    if (state.question) {
      if (!text) return
      answer(answersFrom(state.question, text))
      dom.input.value = ''
    } else if (ask(text)) dom.input.value = ''
    // Emptied while the agent works, the button goes back to stopping it.
    renderSendButton(dom, state)
  },
  /** One question, one choice: picking is answering. Otherwise picks wait for 提交. */
  pickOption(id, label) {
    const question = state.question
    if (!question) return
    const only = question.questions.length === 1 && !question.questions[0].multiSelect
    if (only) answer([{ id, selected: [label] }])
    else dispatch({ type: 'question_pick', id, label })
  },
  submitAnswer() {
    if (!state.question) return
    answer(answersFrom(state.question, dom.input.value))
    dom.input.value = ''
  },
  /** The card closes once the main process has the keys; a check that fails keeps it open and says why. */
  submitSecrets: (values) => provideSecrets(values),
  declineSecrets: () => provideSecrets(null),
  skipQuestion() {
    if (state.question) answer(state.question.questions.map((item) => ({ id: item.id, selected: [] })))
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
  async openSettings() {
    dispatch({ type: 'settings_open' })
    extensionActions.loadExtensions()
    modelActions.loadModels()
    try {
      dispatch({ type: 'settings_loaded', view: await api.getSettings() })
    } catch (err) {
      dispatch({ type: 'settings_failed', message: errorMessage(err) })
    }
  },
  closeSettings: () => dispatch({ type: 'settings_close' }),
  /** The page under the title bar: on the page asked for, or on the one last shown (hub-state.js). */
  openHubPage: (page) => HUB_OPENERS[page]?.(),
  openHub: () => handlers.openHubPage(state.hub.last),
  /** ← 返回, Esc, or the 关于你 icon again: back to the conversation. */
  closeHub: () => dispatch({ type: 'hub_close' }),
  toggleHub: () => (hubPage(state) ? handlers.closeHub() : handlers.openHub()),
  async setDeskIsland(on) {
    try {
      dispatch({ type: 'settings_loaded', view: await api.setDeskIsland(on) })
    } catch (err) {
      dispatch({ type: 'settings_failed', message: errorMessage(err) })
    }
  },
  async resetDeskPlace() {
    try {
      dispatch({ type: 'settings_loaded', view: await api.resetDeskPlace() })
      historyActions.showToast('Viva 岛已放回屏幕顶部正中')
    } catch (err) {
      dispatch({ type: 'settings_failed', message: errorMessage(err) })
    }
  },
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
  openDrawer(tab) {
    dispatch({ type: 'open_drawer', tab })
    if (tab === 'files') filesActions.loadFiles()
  },
  closeDrawer: () => dispatch({ type: 'close_drawer' }),
  islandAction: (action) => ISLAND_ACTIONS[action?.kind]?.(action),
  /** The earlier part of the timeline, a page more (the button at its top). */
  loadEarlier: () => timelineActions.loadEarlier(),
  /** The working directory: the chip under the input, its menu, and the question the first time (view/workdir.js). */
  pickWorkDir: (dir) => workDirActions.switchTo(dir),
  chooseWorkDir: () => workDirActions.choose(),
  confirmWorkDir: () => workDirActions.confirm(),
  cancelWorkDir: () => workDirActions.cancelConfirm(),
  closeWorkDirMenu: () => workDirActions.closeMenu(),
  revealWorkDir: () => workDirActions.reveal(),
  /** A link in an answer opens in the browser (or mail app), never inside the window. */
  openLink: (url) => api.openLink(url).catch((err) => dispatch({ type: 'error', message: `打不开链接：${errorMessage(err)}` })),
}

/** Each page of the hub opens with what it needs loaded (the settings, the memories) or its field focused. */
const HUB_OPENERS = {
  search: () => handlers.openSearch(),
  profile: () => handlers.openProfile(),
  settings: () => handlers.openSettings(),
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
    type: 'permission_request', requestId: event.requestId, taskId: event.taskId, toolCall: event.toolCall, options: event.options, at: Date.now(),
  }),
  /** What a turn moved to the background says, asks and how it ends (tasks-state.js). */
  task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: Date.now() }),
  task_end: (event) => ({ type: 'task_end', taskId: event.taskId, stopReason: event.stopReason, at: Date.now() }),
  task_question: (event) => ({ type: 'task_question', taskId: event.taskId, questionId: event.questionId, questions: event.questions, at: Date.now() }),
  task_question_closed: (event) => ({ type: 'task_question_closed', taskId: event.taskId, questionId: event.questionId, at: Date.now() }),
  question: (event) => ({ type: 'question_request', questionId: event.questionId, questions: event.questions, at: Date.now() }),
  question_closed: (event) => ({ type: 'question_closed', questionId: event.questionId, at: Date.now() }),
  secret_request: (event) => ({ type: 'secret_request', requestId: event.requestId, server: event.server, names: event.names, at: Date.now() }),
  secret_closed: (event) => ({ type: 'secret_closed', requestId: event.requestId }),
  turn_end: (event) => ({ type: 'turn_end', stopReason: event.stopReason, at: Date.now() }),
  memory_context: (event) => ({ type: 'memory_context', injected: event.injected }),
  error: (event) => ({ type: 'error', message: event.message }),
  /** The conversation goes on in another working directory (work-dir-ipc.js): a new part of the timeline. */
  workdir: (event) => ({ type: 'workdir_switched', info: event.info }),
}

function wireComposer() {
  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault()
    // Words in the composer go in (an answer while the agent asks, else into the turn); with none, it stops.
    if (isBusy(state) && !dom.input.value.trim()) handlers.cancel()
    else handlers.send()
  })
  dom.input.addEventListener('input', () => {
    renderSendButton(dom, state)
    renderRouteHint(dom, state)
  })
  dom.input.addEventListener('keydown', (event) => {
    // Tab, while the line over the input says where the words would go: the other way.
    if (event.key === 'Tab' && !event.shiftKey && !event.isComposing && routeOf(state, dom.input.value)) {
      event.preventDefault()
      taskActions.toggleRoute()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    handlers.send()
  })
  dom.context.addEventListener('click', () => workDirActions.toggleMenu())
  dom.modelBtn.addEventListener('click', () => handlers.togglePicker())
  dom.jumpLatest.addEventListener('click', () => dom.follower.jumpToLatest())
  dom.toggleDrawer.addEventListener('click', () => dispatch({ type: 'toggle_drawer' }))
  dom.historySearch.addEventListener('input', () => handlers.searchHistory(dom.historySearch.value))
}

function wireHub() {
  dom.openProfile.addEventListener('click', () => handlers.toggleHub())
  dom.hubBack.addEventListener('click', () => handlers.closeHub())
  for (const nav of dom.hubNavs) {
    nav.addEventListener('click', () => {
      if (hubPage(state) !== nav.dataset.page) handlers.openHubPage(nav.dataset.page)
    })
  }
}

/** ⌘ on the Mac, Ctrl elsewhere (either works on both), with `key` and no Shift. */
const isShortcut = (event, key) => (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === key
const isHistoryShortcut = (event) => (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'

/** Escape closes the innermost thing that is open. */
function closeTopmost() {
  if (state.rewind.confirm) rewindActions.cancelRewindConfirm()
  else if (state.rewind.editing) rewindActions.cancelEdit()
  else if (state.workDir.confirm) workDirActions.cancelConfirm()
  else if (state.workDir.menu) workDirActions.closeMenu()
  else if (state.island) dispatch({ type: 'close_island' })
  else if (hubPage(state)) dispatch({ type: 'hub_close' })
  else if (state.picker) dispatch({ type: 'picker_close' })
}

function wireDismissal() {
  document.addEventListener('click', (event) => {
    // The path as it was at the click: a click that opens a menu re-renders its button, so by now the element
    // clicked (the model's name, the folder's) is no longer in the page and contains() would call it outside.
    const path = event.composedPath()
    const within = (el) => path.includes(el)
    if (state.island && !within(dom.island)) dispatch({ type: 'close_island' })
    if (state.picker && !within(dom.modelArea)) dispatch({ type: 'picker_close' })
    if (state.workDir.menu && !within(dom.workdirArea)) workDirActions.closeMenu()
    if (state.files.menu && !event.composedPath().some((el) => el.classList?.contains('open-split'))) dispatch({ type: 'files_menu', open: false })
  })
  document.addEventListener('keydown', (event) => {
    if (isHistoryShortcut(event)) {
      event.preventDefault()
      handlers.toggleHistory()
    } else if (isShortcut(event, 'f')) {
      // ⌘F / Ctrl+F: find anything said in the timeline.
      event.preventDefault()
      handlers.openSearch()
    } else if (isShortcut(event, 'n')) {
      // ⌘N / Ctrl+N: a new topic; what was said before stays above it in the timeline.
      event.preventDefault()
      if (isBusy(state)) historyActions.showToast('先停止当前任务，再开新话题')
      else handlers.newSession()
    } else if (isShortcut(event, 'o')) {
      // ⌘O / Ctrl+O: the system's folder dialog, as in any desktop app.
      event.preventDefault()
      if (!isBusy(state) && !state.workDir.switching) workDirActions.choose()
    } else if (event.key === 'Escape') {
      closeTopmost()
    }
  })
}

const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

/**
 * A folder dragged onto the window: work there, as if picked in the chip's menu (the main process says
 * what is wrong with anything else). The window says what letting go will do while it is over it.
 */
function wireFolderDrop() {
  const showing = (on) => document.body.classList.toggle('drop-folder', on)
  document.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'link'
    showing(true)
  })
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) showing(false)
  })
  document.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    showing(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length !== 1) return historyActions.showToast('一次拖一个文件夹进来')
    if (isBusy(state) || state.workDir.switching) return historyActions.showToast('助手正在工作，等这一轮结束再换工作目录')
    const dir = api.pathForFile(files[0])
    return dir ? workDirActions.switchTo(dir) : historyActions.showToast('这不是电脑上的文件夹')
  })
}

function labelShortcuts() {
  dom.hubSearchKey.textContent = platform === 'darwin' ? '⌘F' : 'Ctrl+F'
}

/** An MCP server that would not start is left out; say so once per connection instead of failing. */
function reportMcpProblems(info) {
  const dropped = info?.mcp?.dropped ?? []
  if (dropped.length === 0) return
  const names = dropped.map((item) => (item.name === 'memory' ? '记忆工具' : `「${item.name}」`)).join('、')
  historyActions.showToast(`${names} 没能连上，已暂时跳过`, { action: { label: '查看', kind: 'open-settings' }, ms: 8000 })
}

/** An event from the agent (main.js agent:event), into the state and on to what follows from it. */
function handleEvent(event) {
  const toAction = EVENT_ACTIONS[event?.type]
  if (toAction) dispatch(toAction(event))
  if (event?.type === 'ready') reportMcpProblems(event.info)
  if (event?.type === 'ready' || event?.type === 'workdir') workDirActions.refresh()
  if (event?.type === 'turn_end') {
    filesActions.filesAfterTurn()
    sendAfterTurn()
  }
  if (event?.type === 'task_update') taskActions.noteUpdate(event.taskId)
  if (event?.type === 'task_end') {
    taskActions.ended(event.taskId)
    filesActions.filesAfterTurn()
  }
  if (event?.type === 'error') afterTurn = []
}

async function boot() {
  labelShortcuts()
  render(dom, state, handlers)
  if (!api) {
    dispatch({ type: 'error', message: '没有找到 preload 提供的 window.agent，请通过 Electron 启动。' })
    return
  }
  api.onIslandAction?.((action) => handlers.islandAction(action))
  api.onFocusComposer?.(() => dom.input.focus())
  api.onEvent((event) => {
    if (event?.type === 'memory_changed') return memoryActions.onMemoryChanged(event)
    if (event?.type === 'files_changed') return filesActions.onFilesChanged(event)
    // While a turn moves to or from the background, what it says waits for the window to move it too.
    if (taskActions.hold(event)) return undefined
    return handleEvent(event)
  })
  await Promise.all([loadHistory(), memoryActions.loadMemory(), workDirActions.refresh()])
  // What the last launch left going in the background, offered to take up or let go.
  await taskActions.loadUnfinished()
  await timelineActions.loadEarlier()
  dom.follower.jumpToLatest()
  dom.scroll.addEventListener('scroll', () => timelineActions.onScroll(), { passive: true })
  wireComposer()
  wireHub()
  wireDismissal()
  wireFolderDrop()
  setInterval(() => renderTick(dom, state, handlers), TICK_MS)
  const info = await api.getInfo()
  if (info?.mode && info.mode !== 'connecting') dispatch({ type: 'ready', info })
  dom.input.focus()
}

boot().catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
