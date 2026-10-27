import { isBusy } from '../state.ts'
import { setupView } from '../selectors.ts'
import type { SetupCopy } from '../selectors.ts'
import type { Dom } from '../app.ts'
import { mentionedTask, routeOf } from '../tasks-state.ts'
import { h } from './dom.ts'
import { renderDrawer } from './drawer.ts'
import { renderEarlier, updateEarlierControls } from './earlier.ts'
import { queueLayout } from './reconcile.ts'
import { renderHistoryPanel, renderToast } from './history-panel.ts'
import { renderHome } from './home.ts'
import { renderHub } from './hub.ts'
import { renderTasksPage } from './tasks-page.ts'
import { renderTaskDock } from './task-dock.ts'
import { icon } from './icons.ts'
import { renderIsland } from './island.ts'
import { renderModelPicker } from './model-picker.ts'
import { renderProfilePanel } from './profile-panel.ts'
import { renderRewindConfirm } from './rewind.ts'
import { renderSettings } from './settings.ts'
import { renderThread } from './thread.ts'
import { renderTopicLabel } from './topic-label.ts'
import { renderPermissionPicker } from './permission-picker.ts'
import { renderWorkDir } from './workdir.ts'
import { cardedTasks } from './task-card.ts'

let renderedSettings: unknown[] = []
let renderedProfile: unknown = null
let renderedDrawerInputs: unknown[] = []
let renderedHistoryInputs: unknown[] = []
let renderedEarlierInputs: unknown[] = []
let renderedToast: unknown = null

/**
 * The earlier part of the timeline changes only when a page comes in, the conversation moves on, or the topic
 * on screen changes (and with its first words, a new topic can no longer be undone).
 */
function renderEarlierIfChanged(container: HTMLElement, state: State, handlers: Handlers) {
  const inputs = [state.earlier, state.info.cwd, state.topic.parentId, state.topic.startedAt, state.messages.length === 0]
  if (inputs.every((value, i) => value === renderedEarlierInputs[i])) {
    updateEarlierControls(container, state)
    return
  }
  renderedEarlierInputs = inputs
  renderEarlier(container, state, handlers)
}

let renderedTopicInputs: unknown[] = []

/** The label by the input: redrawn when what the assistant has in mind, or how full it is, changes. */
function renderTopicLabelIfChanged(area: HTMLElement | null, state: State, handlers: Handlers) {
  if (!area) return
  const ready = !setupView(state.info) && state.info.mode !== 'connecting'
  const inputs = [state.topic, state.usage, state.messages.length, state.earlier.segments, ready, isBusy(state), state.switching, state.newTopicPending]
  if (inputs.every((value, i) => value === renderedTopicInputs[i])) return
  renderedTopicInputs = inputs
  renderTopicLabel(area, state, handlers, { ready, busy: isBusy(state) })
}

let renderedPermissionInputs: unknown[] = []

/** The permission picker by the input: redrawn when the level, its menu or whether a turn runs changes. */
function renderPermissionIfChanged(area: HTMLElement | null, state: State, handlers: Handlers) {
  if (!area) return
  const ready = !setupView(state.info) && state.info.mode !== 'connecting'
  const { permission, permissionMenu, permissionBusy } = state.settings
  const inputs = [permission, permissionMenu, permissionBusy, ready, isBusy(state)]
  if (inputs.every((value, i) => value === renderedPermissionInputs[i])) return
  renderedPermissionInputs = inputs
  renderPermissionPicker(area, state.settings, handlers, { ready, busy: isBusy(state) })
}

function renderSettingsIfChanged(container: HTMLElement, state: State, handlers: Handlers) {
  const connected = state.info.mode === 'live'
  const inputs = [state.settings, state.models, state.extensions, state.sources, state.followups, connected]
  if (inputs.every((value, i) => value === renderedSettings[i])) return
  renderedSettings = inputs
  renderSettings(container, state.settings, state.models, state.extensions, state.sources, state.followups, handlers, { connected })
}

function renderProfileIfChanged(container: HTMLElement, memory: State['memory'], handlers: Handlers) {
  if (memory === renderedProfile) return
  renderedProfile = memory
  renderProfilePanel(container, memory, handlers)
}

function latestQuestionTop(thread: HTMLElement, scroll: HTMLElement) {
  const questions = thread.querySelectorAll<HTMLElement>('.msg-user')
  // Bubbles may have positioned row wrappers. Measure in the scroll container's coordinates.
  return questions.length ? questions[questions.length - 1].getBoundingClientRect().top
    - scroll.getBoundingClientRect().top + scroll.scrollTop - scroll.clientTop : null
}

/** Re-render the thread, then let the follower decide whether (and how far) to scroll. */
function renderThreadFollowing(dom: Dom, state: State, handlers: Handlers, now: number) {
  if (!renderThread(dom.thread, state, handlers, now)) return
  queueLayout(dom.thread, () => {
    if (!dom.thread.isConnected || dom.thread.hidden) return
    return dom.follower.measureAfterRender(() => latestQuestionTop(dom.thread, dom.scroll))
  })
}

/** The drawer only depends on these slices; skipping identical renders keeps its scroll and hover state intact. */
function renderDrawerIfChanged(container: HTMLElement, state: State, handlers: Handlers) {
  const inputs = [state.drawer, state.timeline, state.tools, state.thoughts, state.usage, state.phase, state.restoredTrace, state.files, state.info.cwd, state.tasks.list]
  if (inputs.every((value, i) => value === renderedDrawerInputs[i])) return
  renderedDrawerInputs = inputs
  renderDrawer(container, state, handlers)
}

/** The panel only depends on its own slice; skipping identical renders keeps hover and focus in the list. */
function renderHistoryIfChanged(dom: Dom, state: State, handlers: Handlers) {
  const inputs = [state.history]
  if (inputs.every((value, i) => value === renderedHistoryInputs[i])) return
  renderedHistoryInputs = inputs
  renderHistoryPanel(dom, state, handlers)
}

let renderedTasksPage: unknown[] = []

/** The 后台 page depends on the tasks, the follow-ups and on itself; a task at work changes it as it goes. */
function renderTasksPageIfChanged(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const inputs = [state.tasks.list, state.tasks.page, state.followups]
  if (inputs.every((value, i) => value === renderedTasksPage[i])) return
  renderedTasksPage = inputs
  renderTasksPage(container, state, handlers, now)
}

function renderToastIfChanged(container: HTMLElement, toast: State['toast'], handlers: Handlers) {
  if (toast === renderedToast) return
  renderedToast = toast
  renderToast(container, toast, handlers)
}

const ANSWER_PLACEHOLDER = '输入你的回答 · Enter 发送'
const STEER_PLACEHOLDER = '补充或修改要求，助手下一步就会读到 · Enter 发送'

/**
 * While the agent cannot start, the composer is disabled and says why; while switching, only sending waits;
 * while the agent asks, it takes the answer; while it works, what is typed goes into the turn.
 */
function renderComposerAvailability(dom: Dom, setup: SetupCopy | null, switching: boolean, { asking, busy, failed }: { asking: boolean, busy: boolean, failed: boolean }) {
  dom.input.dataset.placeholder ??= dom.input.placeholder
  dom.input.disabled = Boolean(setup)
  const placeholder = failed ? '新话题准备失败，草稿已保留 · 点击重试新话题' : switching ? '正在准备新话题，可以先输入…' : asking ? ANSWER_PLACEHOLDER : busy ? STEER_PLACEHOLDER : dom.input.dataset.placeholder
  dom.input.placeholder = setup?.placeholder ?? placeholder
  dom.sendBtn.disabled = Boolean(setup) || switching
  // A question the agent asks is answered here, not handed to the background.
  dom.bgSend.disabled = Boolean(setup) || switching || asking
}

/** While the agent works the button stops it, unless there are words to send into the turn. */
export function renderSendButton(dom: Dom, state: State) {
  const stops = isBusy(state) && !dom.input.value.trim()
  if (dom.sendBtn.dataset.busy === String(stops)) return
  dom.sendBtn.dataset.busy = String(stops)
  dom.sendBtn.setAttribute('aria-label', stops ? '停止' : '发送')
  dom.sendBtn.replaceChildren(icon(stops ? 'stop' : 'send', 22))
}

/** Where 「#name …」 goes: into the turn of a task still going, or as the next question of one that ended. */
function renderMentionHint(dom: Dom, mentioned: { taskId: string, title: string, ended: boolean }) {
  const key = `task:${mentioned.taskId}:${mentioned.ended}`
  if (dom.routeHint.dataset.route === key) return
  dom.routeHint.dataset.route = key
  dom.routeHint.hidden = false
  dom.routeHint.replaceChildren(h('span', { 'aria-hidden': 'true', text: '↳' }), h('b', { text: `交给 #${mentioned.title}` }),
    h('span', { text: mentioned.ended ? '· 它在后台接着做，做完再告诉你' : '· 它下一步就会读到' }))
}

const ROUTES: Readonly<Record<string, { mark: string, name: string, then: string, tab: string }>> = {
  other: { mark: '↗', name: '另一件事', then: '· 交给后台做，这里接着做手上的', tab: '改成插话' },
  into: { mark: '↳', name: '插进正在做的事', then: '· 它下一步就会读到', tab: '当成另一件事' },
}

/**
 * While the agent works and words are typed: whether they go into the turn or move it to the background;
 * Tab turns it. Words starting 「#name」 go to that background task, busy or not.
 */
export function renderRouteHint(dom: Dom, state: State) {
  const mentioned = state.question ? null : mentionedTask(state, dom.input.value)
  if (mentioned) return renderMentionHint(dom, mentioned)
  const route = state.question ? null : routeOf(state, dom.input.value)
  if (dom.routeHint.dataset.route === (route ?? '')) return
  dom.routeHint.dataset.route = route ?? ''
  dom.routeHint.hidden = !route
  if (!route) return dom.routeHint.replaceChildren()
  const { mark, name, then, tab } = ROUTES[route]
  return dom.routeHint.replaceChildren(h('span', { 'aria-hidden': 'true', text: mark }), h('b', { text: name }), h('span', { text: then }),
    h('kbd', { text: 'Tab' }), h('span', { text: tab }))
}

function renderComposer(dom: Dom, state: State, handlers: Handlers) {
  renderComposerAvailability(dom, setupView(state.info), state.switching || state.newTopicPending, { asking: Boolean(state.question), busy: isBusy(state), failed: state.newTopicPending && !state.switching })
  renderSendButton(dom, state)
  renderRouteHint(dom, state)
  renderWorkDir(dom, state, handlers, document.documentElement.dataset.platform ?? 'darwin')
  renderTopicLabelIfChanged(dom.ctxArea, state, handlers)
  renderPermissionIfChanged(dom.permArea, state, handlers)
  dom.toggleDrawer.setAttribute('aria-pressed', String(Boolean(state.drawer)))
  renderModelPicker(dom, state, handlers)
}

/** Cards are conversation content even when no foreground user bubble was created. */
export const showsHome = (state: State) => state.messages.length === 0 && state.earlier.segments.length === 0
  && state.tasks.submissions.length === 0 && state.tasks.unfinished.length === 0 && cardedTasks(state).length === 0
  && !state.newTopicPending && state.phase !== 'error'

/** Full render of every region. The composer textarea is static markup, so typing is never interrupted. */
export function render(dom: Dom, state: State, handlers: Handlers, now = Date.now()) {
  // One timeline: the welcome is only for someone with nothing said yet, anywhere in it.
  const isHome = showsHome(state)
  if (isHome) dom.island.replaceChildren()
  else renderIsland(dom.island, state, handlers, now)
  dom.home.hidden = !isHome
  dom.thread.hidden = isHome
  if (isHome) renderHome(dom.home, state, handlers, now)
  else renderThreadFollowing(dom, state, handlers, now)
  renderEarlierIfChanged(dom.earlier, state, handlers)
  renderDrawerIfChanged(dom.drawer, state, handlers)
  renderTaskDock(dom.taskDock, state, handlers, now)
  renderComposer(dom, state, handlers)
  renderSettingsIfChanged(dom.settings, state, handlers)
  renderProfileIfChanged(dom.profile, state.memory, handlers)
  renderHub(dom, state)
  renderTasksPageIfChanged(dom.tasksPage, state, handlers, now)
  renderHistoryIfChanged(dom, state, handlers)
  renderToastIfChanged(dom.toast, state.toast, handlers)
  renderRewindConfirm(dom.rewindConfirm, state, handlers)
}

/** Per-frame update while text is being typed out: only the thread and the status island. */
export function renderStream(dom: Dom, state: State, handlers: Handlers, now = Date.now()) {
  if (state.messages.length === 0) return
  renderThreadFollowing(dom, state, handlers, now)
  renderIsland(dom.island, state, handlers, now)
}

/** Once-a-second refresh of the elapsed time in the island while the agent works. */
export function renderTick(dom: Dom, state: State, handlers: Handlers, now = Date.now()) {
  if (state.messages.length > 0 && isBusy(state)) renderIsland(dom.island, state, handlers, now)
}
