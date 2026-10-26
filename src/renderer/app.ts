import { withFiles } from '../shared/attachments.ts'
import { IMAGE_TYPES } from '../shared/images.ts'
import { createDraftImages } from './draft-images.ts'
import { insertText, pastedParts } from './paste.ts'
import { markAllGone, pictureKept } from './view/pictures.ts'
import { PERMISSION_LEVELS } from './view/permission-picker.ts'
import { createExtensionActions } from './extension-actions.ts'
import { createSourceActions } from './source-actions.ts'
import { createFollowupActions } from './followup-actions.ts'
import { createFilesActions } from './files-actions.ts'
import { createHistoryActions } from './history-actions.ts'
import { createMemoryActions } from './memory-actions.ts'
import { createModelActions } from './model-actions.ts'
import { createNewTopicAction, isPreviousTopicEvent } from './new-topic-actions.ts'
import { recordRendererTiming } from './performance-timing.ts'
import { islandView } from './island-view.ts'
import { answersFrom, type QuestionAnswer } from './question-state.ts'
import { hubPage } from './hub-state.ts'
import { historyMessages, setupView } from './selectors.ts'
import { initialState, isBusy, isRevealing, reduce } from './state.ts'
import { createRewindActions } from './rewind-actions.ts'
import { createTaskActions } from './task-actions.ts'
import { liveTasks, mentionedTask, routeOf } from './tasks-state.ts'
import { createTimelineActions } from './timeline-actions.ts'
import { createWorkDirActions } from './workdir-actions.ts'
import { render, renderRouteHint, renderSendButton, renderStream, renderTick } from './view/render.ts'
import { createScrollFollower } from './view/scroll-follow.ts'
import { scheduleFrame } from './view/frame.ts'

const TICK_MS = 1000
const MAX_FRAME_MS = 100
/** Moments when the conversation changes in a way worth keeping across launches. */
const SAVE_AFTER = new Set(['user_prompt', 'user_steer', 'steer_failed', 'turn_end', 'error', 'task_started'])
const STEER_LOST = '插话没有送到助手，等这一轮结束后再说一次'
const api = window.agent
/** A part of the page (index.html): one missing is a broken page, said at once rather than at its first use. */
function byId(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`index.html has no #${id}`)
  return el
}
/** The fields and buttons the page reads or switches, as what they are. */
const fieldById = (id: string) => byId(id) as HTMLTextAreaElement & HTMLInputElement
const buttonById = (id: string) => byId(id) as HTMLButtonElement
/** The title bar makes room for the system window buttons: traffic lights on macOS, caption buttons elsewhere. */
const platform = api?.platform ?? 'darwin'
document.documentElement.dataset.platform = platform

const elements = {
  island: byId('island'),
  scroll: byId('scroll'),
  home: byId('home'),
  earlier: byId('earlier'),
  thread: byId('thread'),
  drawer: byId('drawer'),
  composer: byId('composer'),
  input: fieldById('composer-input'),
  routeHint: byId('route-hint'),
  /** Pictures pasted or dropped into the input, above the words (draft-images.js). */
  draftPics: byId('draft-pics'),
  sendBtn: buttonById('send-btn'),
  bgSend: buttonById('bg-send'),
  context: buttonById('composer-context'),
  workdirArea: document.querySelector<HTMLElement>('.workdir-area'),
  /** 本话题 · N 条 · 已用 X% by the input, and its menu (view/topic-label.js). */
  ctxArea: byId('ctx-area'),
  /** What the assistant may do without asking, by the input (view/permission-picker.js). */
  permArea: byId('perm-area'),
  workdirMenu: byId('workdir-menu'),
  workdirConfirm: byId('workdir-confirm-root'),
  rewindConfirm: byId('rewind-confirm-root'),
  toggleDrawer: byId('toggle-drawer'),
  settings: byId('settings-root'),
  modelArea: byId('model-area'),
  modelBtn: buttonById('model-btn'),
  modelMenu: byId('model-menu'),
  jumpLatest: byId('jump-latest'),
  historySearch: fieldById('history-search'),
  historyList: byId('history-list'),
  toast: byId('toast-root'),
  openProfile: byId('open-profile'),
  profile: byId('profile-root'),
  /** 搜索 · 关于你 · 设置, one page under the title bar (view/hub.js). */
  hub: byId('hub'),
  hubBack: byId('hub-back'),
  hubNavs: [...document.querySelectorAll<HTMLElement>('.hub-nav')],
  hubPages: [...document.querySelectorAll<HTMLElement>('.hub-page')],
  hubSearchKey: byId('hub-search-key'),
  /** 后台: every background task and the one picked (view/tasks-page.js). */
  tasksPage: byId('tasks-page'),
}
/** The page's elements, and what keeps the thread scrolled to the latest (view/scroll-follow.ts). */
const dom = { ...elements, follower: createScrollFollower(elements.scroll, elements.jumpLatest) }
/** The page's elements, as the views draw into them. */
export type Dom = typeof dom
new ResizeObserver(() => dom.follower.onContentResize()).observe(dom.thread)

let state: State = initialState
let pendingReveal: (() => void) | null = null
let lastFrameAt = 0
/** Nothing is saved until last launch's history has been read, so an early error can't overwrite it. */
let historyReady = false
let pendingRender: (() => void) | null = null
const LIVE_TEXT_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'viva_stream'])

function dispatch(action: Action) {
  const timing = action.type === 'new_session_pending' ? performance.now() : null
  const next = reduce(state, action)
  if (timing !== null) recordRendererTiming('history-state', performance.now() - timing)
  if (next === state) return
  state = next
  if (['acp_update', 'task_update'].includes(action.type ?? '') && LIVE_TEXT_UPDATES.has(action.update?.sessionUpdate)) {
    // State stays current for user actions, while a burst of model chunks paints once per frame.
    pendingRender ??= scheduleFrame(() => { pendingRender = null; render(dom, state, handlers) })
  } else {
    if (pendingRender) { pendingRender(); pendingRender = null }
    const started = timing === null ? null : performance.now()
    render(dom, state, handlers)
    if (started !== null) recordRendererTiming('new-topic-render', performance.now() - started)
  }
  startReveal()
  publishIsland()
  if (SAVE_AFTER.has(action.type ?? '')) saveHistory()
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
const askingTask = (questionId: string) => liveTasks(state).find((task) => task.question?.questionId === questionId)

/** What the island asks for: its kind, and what goes with it (each entry below reads its own). */
type IslandAction = { kind?: string, [field: string]: any }

/**
 * What the island asks for, from the title bar or the desktop. Answers name the request or question they
 * were shown for, and one that has since closed is dropped.
 */
const ISLAND_ACTIONS: Readonly<Record<string, (action: IslandAction) => unknown>> = {
  toggle: () => dispatch({ type: 'toggle_island' }),
  jump: jumpToCard,
  cancel: () => isBusy(state) && handlers.cancel(),
  trace: () => handlers.openDrawer('trace'),
  /** A task's line in the island's 后台 list: that task on the 后台 page. */
  task: ({ taskId }) => handlers.openTasks(taskId),
  /** The count at the island's tail: the 后台 page. */
  tasks: () => handlers.openTasks(),
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
  /** Asked on the desktop island, with the files dropped and pictures pasted there: into this conversation, as if typed here. */
  ask: ({ text, files, images = [] }) => {
    if (!ask(withFiles(text, files), { via: 'island', images })) historyActions.showToast('Viva 岛上的问题没有送出：助手现在还不能接收')
  },
}

function saveHistory() {
  if (!historyReady || state.messages.length === 0) return
  const sessionId = state.info.sessionId
  const topicStartedAt = state.topic.startedAt
  api.saveHistory(historyMessages(state))
    .then((summary) => {
      // A save from the topic just left must not attach its id to the new blank topic.
      if (!state.newTopicPending && state.info.sessionId === sessionId && state.topic.startedAt === topicStartedAt) dispatch({ type: 'conversation_saved', id: summary.id })
      else dispatch({ type: 'archived_conversation_saved', sessionId, id: summary.id })
      historyActions.refreshIfOpen()
    })
    .catch((err) => console.error('[history] could not save the conversation:', errorMessage(err)))
}

/** At launch: the permission level picked, shown by the input (the rest of settings is read when they open). */
async function loadSettings() {
  try {
    dispatch({ type: 'settings_loaded', view: await api.getSettings() })
  } catch (err) {
    console.error('[settings] could not read them:', errorMessage(err))
  }
}

async function loadHistory() {
  try {
    const saved = await api.loadHistory()
    if (!saved) return
    dispatch({
      type: 'history_loaded', conversationId: saved.id, messages: saved.messages, savedAt: saved.updatedAt, folds: saved.folds ?? [],
      parentId: saved.parentId ?? null, createdAt: saved.createdAt ?? null,
    })
    dom.follower.jumpToLatest()
    historyActions.loadTrace(saved.id)
  } catch (err) {
    console.error('[history] could not load the last conversation:', errorMessage(err))
  } finally {
    historyReady = true
  }
}

/** Types out assistant text frame by frame; stops by itself once everything received is on screen. */
function revealFrame(now: number) {
  pendingReveal = null
  const dt = Math.min(now - lastFrameAt, MAX_FRAME_MS)
  lastFrameAt = now
  state = reduce(state, { type: 'reveal_tick', dt })
  renderStream(dom, state, handlers)
  if (isRevealing(state)) pendingReveal = scheduleFrame(revealFrame)
}

function startReveal() {
  if (pendingReveal || !isRevealing(state)) return
  lastFrameAt = performance.now()
  pendingReveal = scheduleFrame(revealFrame)
}

/** IPC errors arrive as "Error invoking remote method 'x': Error: msg"; keep only the message. */
const errorMessage = (err: unknown) => String((err as { message?: unknown } | null)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const historyActions = createHistoryActions({
  api,
  getState: () => state,
  dispatch,
  searchField: dom.historySearch,
  errorMessage,
  jumpTo: (hit: Untyped) => timelineActions.jumpTo(hit),
})

const draftImages = createDraftImages({
  keep: (bytes: Uint8Array<ArrayBuffer>) => api.keepImage(bytes),
  container: dom.draftPics,
  showError: (message: string) => historyActions.showToast(message),
})

/** How long a message found by search stays marked after the timeline scrolls to it. */
const FOUND_MS = 2400

/** Scrolls a message of the timeline (its `data-msg`, view/thread.js markMessage) to the middle and marks it a moment. */
function revealMessage(msgId: string) {
  const row = dom.scroll.querySelector(`[data-msg="${CSS.escape(msgId)}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center' })
  row.classList.add('msg-found')
  setTimeout(() => row.classList.remove('msg-found'), FOUND_MS)
}

/**
 * Sends `text` as the user's next question, or, while the agent works, into the turn it is on — unless it is
 * about something else, when that turn moves to the background first (tasks-state.js routeOf);
 * `via: 'island'` when it was asked on the desktop island; `images`: pictures pasted with it, which go only
 * as a new question (not into a running turn, nor to a background task).
 * @returns {boolean} false when the agent can't take it now
 */
function ask(text: string, { via = null as string | null, images = [] as Array<{ id: string }> } = {}): boolean {
  if ((!text && !images.length) || setupView(state.info) || state.switching || state.newTopicPending) return false
  if (images.length) return askWithImages(text, images, via)
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
  // About something else while a turn runs: the words go to a task of their own, the turn stays in front;
  // A failed submission keeps its own text and retry action.
  if (isBusy(state) && routeOf(state, text) === 'other') {
    void taskActions.startTask(text)
    return true
  }
  if (isBusy(state)) return steer(text, via)
  dom.follower.resetForPrompt()
  dispatch({ type: 'user_prompt', text, at: Date.now(), via })
  api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  return true
}

const IMAGES_WAIT = '助手正在工作，图片等这一轮结束再发'
const IMAGES_NOT_TO_TASKS = '图片只能发在这里的对话里，不能交给后台任务'

/** A question with pictures: only as the next question of the conversation on screen. */
function askWithImages(text: string, images: Array<{ id: string }>, via: string | null) {
  if (mentionedTask(state, text)) {
    historyActions.showToast(IMAGES_NOT_TO_TASKS)
    return false
  }
  if (isBusy(state)) {
    historyActions.showToast(IMAGES_WAIT)
    return false
  }
  dom.follower.resetForPrompt()
  // Kept just now (here, or on the desktop island): shown even if the folder was emptied earlier.
  for (const { id } of images) pictureKept(id)
  dispatch({ type: 'user_prompt', text, at: Date.now(), via, images })
  api.prompt(text, images).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  return true
}

/** Words said as a turn was ending: sent as the next question once it has ended. */
let afterTurn: string[] = []

/**
 * Said while the agent works: into the running turn, which reads it at its next step (the viva-steer plugin).
 * Should that turn have just ended, the words go as the next question; should they not get through at all,
 * they stay in the thread marked as not sent.
 */
function steer(text: string, via: string | null) {
  dispatch({ type: 'user_steer', text, via })
  // The words just said, the last message now (user_steer above).
  const id = state.messages.at(-1)?.id
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

function resend(text: string) {
  dispatch({ type: 'steer_resent', at: Date.now() })
  api.prompt(text).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
}

function sendAfterTurn() {
  if (!afterTurn.length) return
  const text = afterTurn.join('\n\n')
  afterTurn = []
  resend(text)
}

/** What the user answers to each question: the options picked, and words of their own. */
type Answers = QuestionAnswer[]

/** Answers the agent's open question; the reply shows at once, like an approval. */
function answer(answers: Answers) {
  const question = state.question
  if (!question) return
  dispatch({ type: 'question_answered', questionId: question.questionId, answers, at: Date.now() })
  api.answerQuestion(question.questionId, answers)
    .then((accepted) => accepted || historyActions.showToast('这个问题已经结束，回答没有送出'))
    .catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
}

async function provideSecrets(values: Record<string, string> | null) {
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
  api, getState: () => state, dispatch, showToast: historyActions.showToast, errorMessage, deliver: handleEvent,
  isTyping: () => Boolean(dom.input.value.trim()),
})
const timelineActions = createTimelineActions({ api, getState: () => state, dispatch, scroll: dom.scroll, reveal: revealMessage })
const workDirActions = createWorkDirActions({ api, getState: () => state, dispatch, errorMessage, showToast: historyActions.showToast })
const extensionActions = createExtensionActions({ api, getState: () => state, dispatch, errorMessage })
const sourceActions = createSourceActions({ api, getState: () => state, dispatch, errorMessage })
const followupActions = createFollowupActions({
  api, getState: () => state, dispatch, errorMessage,
  // 接着做: the draft in the input, the conversation in front; the user reads it and sends it.
  fillComposer: (text) => {
    dispatch({ type: 'hub_close' })
    dom.input.value = text
    dom.input.dispatchEvent(new Event('input'))
    dom.input.focus()
  },
  startTask: (text) => taskActions.startTask(text),
})
const modelActions = createModelActions({ api, getState: () => state, dispatch, errorMessage })
const filesActions = createFilesActions({ api, getState: () => state, dispatch, errorMessage })

/** Emptying or moving the pictures folder; null back means the user picked no folder. */
async function imagesChange(run: () => Promise<unknown>, done: string) {
  dispatch({ type: 'images_busy' })
  try {
    const usage = await run()
    dispatch({ type: 'images_done', usage })
    if (usage) historyActions.showToast(done)
  } catch (err) {
    dispatch({ type: 'images_done', usage: null })
    historyActions.showToast(errorMessage(err))
  }
}

/** What a toast's button does. */
const TOAST_ACTIONS: Readonly<Record<string, (toast: NonNullable<State['toast']>) => unknown>> = {
  'open-profile': () => memoryActions.openProfile(),
  'undo-memory': (toast) => memoryActions.undoMemoryDelete(toast.action.payload),
  'open-settings': () => handlers.openSettings(),
}

const handlers = {
  retrySubmission: (id: string) => {
    const item = state.tasks.submissions.find(item => item.id === id)
    if (item?.status === 'failed') void taskActions.startTask(item.text, id)
  },
  dismissSubmission: (id: string) => dispatch({ type: 'task_submit_dismissed', id }),
  ...historyActions,
  ...memoryActions,
  ...extensionActions,
  ...sourceActions,
  ...followupActions,
  ...modelActions,
  ...filesActions,
  /** Going back to something the user said: its bar and the editor in place (view/rewind.js). */
  ...rewindActions,
  /** Background tasks: 撤销 on the line a move leaves, and stopping or closing one. */
  undoMove: () => taskActions.undoMove(),
  /** 放到后台, beside a turn the agent said will take long (view/thread.js offerRow). */
  moveToBackground: () => taskActions.moveToBackground(),
  stopTask: (taskId: string) => taskActions.stopTask(taskId),
  closeTask: (taskId: string) => taskActions.closeTask(taskId),
  pickTaskOption: (taskId: string, id: string, label: string) => taskActions.pickTaskOption(taskId, id, label),
  /** A task's report in the thread, put away (view/thread.js reportCard). */
  dismissReport: (taskId: string) => taskActions.dismissReport(taskId),
  /** 后台做 beside the send button: what is typed goes to a task of its own; the conversation here goes on. */
  async startInBackground() {
    const text = dom.input.value.trim()
    if (!text || setupView(state.info) || state.switching || state.newTopicPending) return dom.input.focus()
    dom.input.value = ''
    renderSendButton(dom, state)
    renderRouteHint(dom, state)
    // Not started: the words come back, so nothing typed is lost.
    void taskActions.startTask(text)
    return undefined
  },
  /** 接着问 on a task's card: that task on the 后台 page, the cursor in its input. 「#name …」 still works too. */
  followUpTask(taskId: string) {
    handlers.openTasks(taskId)
    dom.tasksPage.querySelector<HTMLTextAreaElement>('.tp-input')?.focus()
  },
  /** A task the last launch left going (view/thread.js unfinishedCard): 接着做, or 不做了. */
  resumeUnfinished: (taskId: string) => taskActions.resumeUnfinished(taskId),
  forgetUnfinished: (taskId: string) => taskActions.forgetUnfinished(taskId),
  submitTaskAnswer: (taskId: string) => taskActions.submitTaskAnswer(taskId),
  skipTaskQuestion: (taskId: string) => taskActions.skipTaskQuestion(taskId),
  send() {
    if (setupView(state.info)) return handlers.openSettings()
    // 「#name 」 with no words yet (接着问 just wrote it): nothing to send, to the task or anywhere else.
    if (!state.question && mentionedTask(state, dom.input.value)?.text === '') return undefined
    const text = dom.input.value.trim()
    if (state.question) {
      if (!text) return
      answer(answersFrom(state.question, text))
      dom.input.value = ''
    } else if (ask(text, { images: draftImages.list() })) {
      dom.input.value = ''
      draftImages.clear()
    }
    // Emptied while the agent works, the button goes back to stopping it.
    renderSendButton(dom, state)
  },
  /** 设置 › 贴过的图片 (main/image-ipc.js): open the folder; empty it after a yes; move it, dsh starting again there. */
  openImagesFolder: () => api.openImagesFolder().catch((err) => historyActions.showToast(errorMessage(err))),
  askClearImages: () => dispatch({ type: 'images_confirm', open: true }),
  cancelClearImages: () => dispatch({ type: 'images_confirm', open: false }),
  clearImages: () => imagesChange(async () => {
    const usage = await api.clearImages()
    // Gone from the folder: so from the input waiting to send them, and from what is on screen.
    draftImages.clear()
    markAllGone(document)
    return usage
  }, '图片已清空'),
  moveImages: () => imagesChange(() => api.moveImages(), '图片已经搬过去了'),
  /** One question, one choice: picking is answering. Otherwise picks wait for 提交. */
  pickOption(id: string, label: string) {
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
  submitSecrets: (values: Record<string, string>) => provideSecrets(values),
  declineSecrets: () => provideSecrets(null),
  skipQuestion() {
    if (state.question) answer(state.question.questions.map((item: QuestionItem) => ({ id: item.id, selected: [] })))
  },
  toastAction(toast: NonNullable<State['toast']>) {
    dispatch({ type: 'toast_hide', key: toast.key })
    TOAST_ACTIONS[toast.action?.kind ?? '']?.(toast)
  },
  cancel() {
    api.cancel().catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  },
  respond(requestId: string, optionId: string | null) {
    dispatch({ type: 'permission_resolved', requestId, optionId, at: Date.now() })
    api.respondPermission(requestId, optionId).catch((err) => dispatch({ type: 'error', message: errorMessage(err) }))
  },
  /** ⌘N, or 开新话题 in the label's menu: the assistant starts afresh; what was said stays above, dimmed. */
  newSession: createNewTopicAction({
    getState: () => state, dispatch, open: () => api.newSession(),
    jump: () => dom.follower.jumpToLatest(), focus: () => dom.input.focus(),
    toast: (message) => historyActions.showToast(message), errorMessage,
    frame: (callback) => { requestAnimationFrame(callback) },
    measure: ({ stage, durationMs }) => recordRendererTiming(stage, durationMs),
  }),
  /** 回到这个话题 on an earlier topic, and 撤销 on a new one: the agent goes on from that segment. */
  async resumeTopic(segmentId: string) {
    if (state.switching) return undefined
    if (isBusy(state)) return historyActions.showToast('助手正在工作，等这一轮结束再回到那个话题')
    dispatch({ type: 'session_switching' })
    try {
      const { info, parentId } = await api.resumeTopic(segmentId)
      dispatch({ type: 'topic_resumed', info, parentId, at: Date.now() })
      dom.follower.jumpToLatest()
      dom.input.focus()
    } catch (err) {
      dispatch({ type: 'session_switch_failed' })
      historyActions.showToast(errorMessage(err))
    }
    return undefined
  },
  toggleTopicMenu: () => dispatch({ type: 'topic_menu', open: !state.topic.menu }),
  /** The permission picker by the input (view/permission-picker.js): another level restarts dsh on this conversation. */
  togglePermissionMenu: () => dispatch({ type: 'permission_menu', open: !state.settings.permissionMenu }),
  async setPermission(level: string) {
    if (state.switching || state.newTopicPending) return
    if (level === state.settings.permission) return dispatch({ type: 'permission_menu', open: false })
    dispatch({ type: 'permission_busy' })
    try {
      const { settings } = await api.setPermission(level)
      dispatch({ type: 'permission_done', level: settings.permission })
      historyActions.showToast(`权限已换成「${PERMISSION_LEVELS.find((item) => item.value === settings.permission)?.name ?? settings.permission}」`)
    } catch (err) {
      dispatch({ type: 'permission_done', level: null })
      historyActions.showToast(errorMessage(err))
    }
    return undefined
  },
  async openSettings() {
    dispatch({ type: 'settings_open' })
    extensionActions.loadExtensions()
    sourceActions.loadSources()
    followupActions.loadFollowups()
    modelActions.loadModels()
    try {
      dispatch({ type: 'settings_loaded', view: await api.getSettings() })
    } catch (err) {
      dispatch({ type: 'settings_failed', message: errorMessage(err) })
    }
  },
  closeSettings: () => dispatch({ type: 'settings_close' }),
  /** The page under the title bar: on the page asked for, or on the one last shown (hub-state.js). */
  openHubPage: (page: string) => HUB_OPENERS[page]?.(),
  openHub: () => handlers.openHubPage(state.hub.last),
  /** ← 返回, Esc, or the 关于你 icon again: back to the conversation. */
  closeHub: () => dispatch({ type: 'hub_close' }),
  /** The 后台 page, on `taskId` or the one it was on (view/tasks-page.js). */
  openTasks: (taskId: string | null = null) => {
    dispatch({ type: 'tasks_page_open', taskId })
    followupActions.loadFollowups()
  },
  selectTask: (taskId: string) => dispatch({ type: 'tasks_page_select', taskId }),
  toggleTaskSteps: () => dispatch({ type: 'tasks_page_steps' }),
  /**
   * Typed on the 后台 page: the answer while the task asks, into its turn while it works, its next question
   * once it has ended.
   */
  sendToTask(taskId: string, text: string) {
    const task = state.tasks.list.find((entry) => entry.id === taskId)
    if (!task) return
    if (task.question) taskActions.typeTaskAnswer(taskId, text)
    else if (task.endedAt === null) taskActions.steerTask(taskId, text)
    else taskActions.askTask(taskId, text)
  },
  toggleHub: () => (hubPage(state) ? handlers.closeHub() : handlers.openHub()),
  async setDeskIsland(on: boolean) {
    try {
      dispatch({ type: 'settings_loaded', view: await api.setDeskIsland(on) })
    } catch (err) {
      dispatch({ type: 'settings_failed', message: errorMessage(err) })
    }
  },
  async setOpenAtLogin(on: boolean) {
    try {
      dispatch({ type: 'settings_loaded', view: await api.setOpenAtLogin(on) })
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
  saveKey: (value: string) => applySettingsChange(() => api.saveApiKey(value), saveNotice),
  clearKey: () => applySettingsChange(() => api.clearApiKey(), () => '已清除保存的 key'),
  togglePicker: () => dispatch({ type: 'picker_toggle' }),
  async setConfig(configId: string, value: string) {
    if (state.switching || state.newTopicPending) return
    try {
      dispatch({ type: 'config_applied', info: await api.setConfig(configId, value) })
    } catch (err) {
      dispatch({ type: 'error', message: `切换失败：${errorMessage(err)}` })
    }
  },
  openDrawer(tab: string) {
    dispatch({ type: 'open_drawer', tab })
    if (tab === 'files') filesActions.loadFiles()
  },
  closeDrawer: () => dispatch({ type: 'close_drawer' }),
  islandAction: (action: IslandAction) => ISLAND_ACTIONS[action?.kind ?? '']?.(action),
  /** The earlier part of the timeline, a page more (the button at its top). */
  loadEarlier: () => timelineActions.loadEarlier(),
  /** The working directory: the chip under the input, its menu, and the question the first time (view/workdir.js). */
  pickWorkDir: (dir: string) => state.switching ? undefined : workDirActions.switchTo(dir),
  chooseWorkDir: () => state.switching ? undefined : workDirActions.choose(),
  confirmWorkDir: () => state.switching ? undefined : workDirActions.confirm(),
  cancelWorkDir: () => workDirActions.cancelConfirm(),
  closeWorkDirMenu: () => workDirActions.closeMenu(),
  revealWorkDir: () => workDirActions.reveal(),
  /** A link in an answer opens in the browser (or mail app), never inside the window. */
  openLink: (url: string) => api.openLink(url).catch((err) => dispatch({ type: 'error', message: `打不开链接：${errorMessage(err)}` })),
}

/** Each page of the hub opens with what it needs loaded (the settings, the memories) or its field focused. */
const HUB_OPENERS: Readonly<Record<string, () => unknown>> = {
  search: () => handlers.openSearch(),
  // Background tasks and follow-ups: a page of its own in the same place (view/tasks-page.js).
  tasks: () => handlers.openTasks(),
  profile: () => handlers.openProfile(),
  settings: () => handlers.openSettings(),
}

function saveNotice(info: AgentInfo | null | undefined) {
  if (info?.mode === 'live') return `已保存并连接 · ${info.model || 'DeepSeek'}`
  if (info?.mode === 'setup') return `已保存，但还不能连接：${setupView(info)?.title ?? ''}`
  return '已保存，但没能连上 DeepSeek Harness，详情见对话区'
}

/** Saving or clearing the key restarts the agent in the main process, so the conversation starts over. */
async function applySettingsChange(
  request: () => Promise<{ settings: unknown, info?: AgentInfo | null }>,
  noticeFor: (info: AgentInfo | null | undefined) => string,
) {
  if (state.settings.busy || state.switching) return
  dispatch({ type: 'settings_busy' })
  try {
    const { settings, info } = await request()
    dispatch({ type: 'settings_saved', view: settings, notice: noticeFor(info) })
    if (info) dispatch({ type: 'new_session', info })
  } catch (err) {
    dispatch({ type: 'settings_failed', message: errorMessage(err) })
  }
}

/** What the main process says of the agent (main.ts agent:event): its type, and what goes with it. */
type AgentEvent = { type?: string, [field: string]: any }

const EVENT_ACTIONS: Readonly<Record<string, (event: AgentEvent) => Action>> = {
  ready: (event) => ({ type: 'ready', info: event.info }),
  config: (event) => ({ type: 'config_applied', info: event.info }),
  update: (event) => ({ type: 'acp_update', update: event.update, at: Date.now() }),
  permission: (event) => ({
    type: 'permission_request', requestId: event.requestId, taskId: event.taskId, toolCall: event.toolCall, options: event.options, at: Date.now(),
  }),
  /** What a turn moved to the background says, asks and how it ends (tasks-state.js). */
  task_update: (event) => ({ type: 'task_update', taskId: event.taskId, update: event.update, at: Date.now() }),
  task_snapshot: (event) => ({ type: 'task_snapshot', snapshot: event.snapshot }),
  task_end: (event) => ({ type: 'task_end', taskId: event.taskId, stopReason: event.stopReason, message: event.message ?? null, at: Date.now() }),
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
  /** The model proposed a follow-up: a card under the conversation, for the user to decide on. */
  followup_propose: (event) => ({ type: 'followup_proposed', proposalId: event.proposalId, proposal: event.proposal }),
  /** How background preparation goes (prepare-scheduler.ts). */
  prepare_state: (event) => ({ type: 'prepare_state', prepare: event.state }),
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
  // Pictures go above the words; words that came only as formatted text are put in by hand (paste.js).
  dom.input.addEventListener('paste', (event) => {
    const { images, text } = pastedParts(event.clipboardData)
    if (text === null) return
    event.preventDefault()
    insertText(dom.input, text)
    if (images.length) draftImages.add(images)
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
  dom.bgSend.addEventListener('click', () => handlers.startInBackground())
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
      const page = nav.dataset.page ?? ''
      if (hubPage(state) !== page) handlers.openHubPage(page)
    })
  }
}

/** ⌘ on the Mac, Ctrl elsewhere (either works on both), with `key` and no Shift. */
const isShortcut = (event: KeyboardEvent, key: string) => (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === key
const isHistoryShortcut = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'

/** Escape closes the innermost thing that is open. */
function closeTopmost() {
  if (state.rewind.confirm) rewindActions.cancelRewindConfirm()
  else if (state.rewind.editing) rewindActions.cancelEdit()
  else if (state.workDir.confirm) workDirActions.cancelConfirm()
  else if (state.workDir.menu) workDirActions.closeMenu()
  else if (state.topic.menu) dispatch({ type: 'topic_menu', open: false })
  else if (state.settings.permissionMenu) dispatch({ type: 'permission_menu', open: false })
  else if (state.island) dispatch({ type: 'close_island' })
  else if (hubPage(state)) dispatch({ type: 'hub_close' })
  else if (state.picker) dispatch({ type: 'picker_close' })
}

function wireDismissal() {
  document.addEventListener('click', (event) => {
    // The path as it was at the click: a click that opens a menu re-renders its button, so by now the element
    // clicked (the model's name, the folder's) is no longer in the page and contains() would call it outside.
    const path = event.composedPath()
    const within = (el: EventTarget | null) => el !== null && path.includes(el)
    if (state.island && !within(dom.island)) dispatch({ type: 'close_island' })
    if (state.picker && !within(dom.modelArea)) dispatch({ type: 'picker_close' })
    if (state.workDir.menu && !within(dom.workdirArea)) workDirActions.closeMenu()
    if (state.topic.menu && !within(dom.ctxArea)) dispatch({ type: 'topic_menu', open: false })
    if (state.settings.permissionMenu && !within(dom.permArea)) dispatch({ type: 'permission_menu', open: false })
    if (state.files.menu && !event.composedPath().some((el) => el instanceof Element && el.classList.contains('open-split'))) dispatch({ type: 'files_menu', open: false })
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
      handlers.newSession()
    } else if (isShortcut(event, 'o')) {
      // ⌘O / Ctrl+O: the system's folder dialog, as in any desktop app.
      event.preventDefault()
      if (!isBusy(state) && !state.switching && !state.workDir.switching) workDirActions.choose()
    } else if (event.key === 'Escape') {
      closeTopmost()
    }
  })
}

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
/** Only pictures the model reads are dragged: they go into the input, not to the working directory. */
const carriesImages = (event: DragEvent) => {
  const items = Array.from(event.dataTransfer?.items ?? [])
  return items.length > 0 && items.every((item) => item.kind === 'file' && Object.hasOwn(IMAGE_TYPES, item.type))
}

/**
 * A folder dragged onto the window: work there, as if picked in the chip's menu (the main process says
 * what is wrong with anything else). Pictures dragged onto it go into the input instead. The window says
 * what letting go will do while it is over it.
 */
function wireFolderDrop() {
  const showing = (kind: 'folder' | 'images' | null) => {
    document.body.classList.toggle('drop-folder', kind === 'folder')
    document.body.classList.toggle('drop-images', kind === 'images')
  }
  document.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !carriesFiles(event)) return
    event.preventDefault()
    const images = carriesImages(event)
    event.dataTransfer.dropEffect = images ? 'copy' : 'link'
    showing(images ? 'images' : 'folder')
  })
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) showing(null)
  })
  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !carriesFiles(event)) return
    event.preventDefault()
    showing(null)
    if (carriesImages(event)) {
      draftImages.add(Array.from(event.dataTransfer.files))
      return dom.input.focus()
    }
    const files = Array.from(event.dataTransfer.files)
    if (files.length !== 1) return historyActions.showToast('一次拖一个文件夹进来')
    if (isBusy(state) || state.switching || state.workDir.switching) return historyActions.showToast('助手正在工作或准备话题，请稍后再换工作目录')
    const dir = api.pathForFile(files[0])
    return dir ? workDirActions.switchTo(dir) : historyActions.showToast('这不是电脑上的文件夹')
  })
}

function labelShortcuts() {
  dom.hubSearchKey.textContent = platform === 'darwin' ? '⌘F' : 'Ctrl+F'
}

/** An MCP server that would not start is left out; say so once per connection instead of failing. */
function reportMcpProblems(info: AgentInfo | undefined) {
  const dropped: Array<{ name: string }> = info?.mcp?.dropped ?? []
  if (dropped.length === 0) return
  const names = dropped.map((item) => (item.name === 'memory' ? '记忆工具' : `「${item.name}」`)).join('、')
  historyActions.showToast(`${names} 没能连上，已暂时跳过`, { action: { label: '查看', kind: 'open-settings' }, ms: 8000 })
}

/** An event from the agent (main.js agent:event), into the state and on to what follows from it. */
function handleEvent(event: AgentEvent) {
  if (state.newTopicPending && isPreviousTopicEvent(event)) return
  const toAction = EVENT_ACTIONS[event?.type ?? '']
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
  // A batch ended: drafts are ready, or the list changed.
  if ((event?.type === 'prepare_state' && !event.state?.running) || event?.type === 'followups_changed') followupActions.loadFollowups()
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
  await Promise.all([loadHistory(), memoryActions.loadMemory(), workDirActions.refresh(), loadSettings(), followupActions.loadFollowups()])
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
