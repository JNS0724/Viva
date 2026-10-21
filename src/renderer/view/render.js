import { isBusy } from '../state.js'
import { setupView } from '../selectors.js'
import { routeOf } from '../tasks-state.js'
import { h } from './dom.js'
import { renderDrawer } from './drawer.js'
import { renderEarlier } from './earlier.js'
import { renderHistoryPanel, renderToast } from './history-panel.js'
import { renderHome } from './home.js'
import { icon } from './icons.js'
import { renderIsland } from './island.js'
import { renderModelPicker } from './model-picker.js'
import { renderProfilePanel } from './profile-panel.js'
import { renderRewindConfirm } from './rewind.js'
import { renderSettings } from './settings.js'
import { renderThread } from './thread.js'
import { renderWorkDir } from './workdir.js'

let renderedSettings = []
let renderedProfile = null
let renderedDrawerInputs = []
let renderedHistoryInputs = []
let renderedEarlierInputs = []
let renderedToast = null

/** The earlier part of the timeline changes only when a page comes in or the conversation moves on. */
function renderEarlierIfChanged(container, state, handlers) {
  const inputs = [state.earlier, state.info.cwd]
  if (inputs.every((value, i) => value === renderedEarlierInputs[i])) return
  renderedEarlierInputs = inputs
  renderEarlier(container, state, handlers)
}

function renderSettingsIfChanged(container, state, handlers) {
  const connected = state.info.mode === 'live'
  const inputs = [state.settings, state.models, state.extensions, connected]
  if (inputs.every((value, i) => value === renderedSettings[i])) return
  renderedSettings = inputs
  renderSettings(container, state.settings, state.models, state.extensions, handlers, { connected })
}

function renderProfileIfChanged(container, memory, handlers) {
  if (memory === renderedProfile) return
  renderedProfile = memory
  renderProfilePanel(container, memory, handlers)
}

function latestQuestionTop(thread) {
  const questions = thread.querySelectorAll('.msg-user')
  return questions.length ? questions[questions.length - 1].offsetTop : null
}

/** Re-render the thread, then let the follower decide whether (and how far) to scroll. */
function renderThreadFollowing(dom, state, handlers, now) {
  renderThread(dom.thread, state, handlers, now)
  dom.follower.afterRender({ anchorTop: latestQuestionTop(dom.thread) })
}

/** The drawer only depends on these slices; skipping identical renders keeps its scroll and hover state intact. */
function renderDrawerIfChanged(container, state, handlers) {
  const inputs = [state.drawer, state.timeline, state.tools, state.thoughts, state.usage, state.phase, state.restoredTrace, state.files, state.info.cwd, state.tasks.list]
  if (inputs.every((value, i) => value === renderedDrawerInputs[i])) return
  renderedDrawerInputs = inputs
  renderDrawer(container, state, handlers)
}

/** The panel only depends on its own slice; skipping identical renders keeps hover and focus in the list. */
function renderHistoryIfChanged(dom, state, handlers) {
  const inputs = [state.history]
  if (inputs.every((value, i) => value === renderedHistoryInputs[i])) return
  renderedHistoryInputs = inputs
  renderHistoryPanel(dom, state, handlers)
}

function renderToastIfChanged(container, toast, handlers) {
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
function renderComposerAvailability(dom, setup, switching, { asking, busy }) {
  dom.input.dataset.placeholder ??= dom.input.placeholder
  dom.input.disabled = Boolean(setup)
  const placeholder = asking ? ANSWER_PLACEHOLDER : busy ? STEER_PLACEHOLDER : dom.input.dataset.placeholder
  dom.input.placeholder = setup?.placeholder ?? placeholder
  dom.sendBtn.disabled = Boolean(setup) || switching
}

/** While the agent works the button stops it, unless there are words to send into the turn. */
export function renderSendButton(dom, state) {
  const stops = isBusy(state) && !dom.input.value.trim()
  if (dom.sendBtn.dataset.busy === String(stops)) return
  dom.sendBtn.dataset.busy = String(stops)
  dom.sendBtn.setAttribute('aria-label', stops ? '停止' : '发送')
  dom.sendBtn.replaceChildren(icon(stops ? 'stop' : 'send', 22))
}

const ROUTES = {
  other: { mark: '↗', name: '另一件事', then: '· 刚才那件会挪到后台接着做', tab: '改成插话' },
  into: { mark: '↳', name: '插进正在做的事', then: '· 它下一步就会读到', tab: '当成另一件事' },
}

/** While the agent works and words are typed: whether they go into the turn or move it to the background; Tab turns it. */
export function renderRouteHint(dom, state) {
  const route = state.question ? null : routeOf(state, dom.input.value)
  if (dom.routeHint.dataset.route === (route ?? '')) return
  dom.routeHint.dataset.route = route ?? ''
  dom.routeHint.hidden = !route
  if (!route) return dom.routeHint.replaceChildren()
  const { mark, name, then, tab } = ROUTES[route]
  return dom.routeHint.replaceChildren(h('span', { 'aria-hidden': 'true', text: mark }), h('b', { text: name }), h('span', { text: then }),
    h('kbd', { text: 'Tab' }), h('span', { text: tab }))
}

function renderComposer(dom, state, handlers) {
  renderComposerAvailability(dom, setupView(state.info), state.switching, { asking: Boolean(state.question), busy: isBusy(state) })
  renderSendButton(dom, state)
  renderRouteHint(dom, state)
  renderWorkDir(dom, state, handlers, document.documentElement.dataset.platform ?? 'darwin')
  dom.toggleDrawer.setAttribute('aria-pressed', String(Boolean(state.drawer)))
  renderModelPicker(dom, state, handlers)
}

/** Full render of every region. The composer textarea is static markup, so typing is never interrupted. */
export function render(dom, state, handlers, now = Date.now()) {
  // One timeline: the welcome is only for someone with nothing said yet, anywhere in it.
  const isHome = state.messages.length === 0 && state.earlier.segments.length === 0
  if (isHome) dom.island.replaceChildren()
  else renderIsland(dom.island, state, handlers, now)
  dom.home.hidden = !isHome
  dom.thread.hidden = isHome
  if (isHome) renderHome(dom.home, state, handlers, now)
  else renderThreadFollowing(dom, state, handlers, now)
  renderEarlierIfChanged(dom.earlier, state, handlers)
  renderDrawerIfChanged(dom.drawer, state, handlers)
  renderComposer(dom, state, handlers)
  renderSettingsIfChanged(dom.settings, state, handlers)
  renderProfileIfChanged(dom.profile, state.memory, handlers)
  dom.openProfile.setAttribute('aria-pressed', String(state.memory.open))
  renderHistoryIfChanged(dom, state, handlers)
  renderToastIfChanged(dom.toast, state.toast, handlers)
  renderRewindConfirm(dom.rewindConfirm, state, handlers)
}

/** Per-frame update while text is being typed out: only the thread and the status island. */
export function renderStream(dom, state, handlers, now = Date.now()) {
  if (state.messages.length === 0) return
  renderThreadFollowing(dom, state, handlers, now)
  renderIsland(dom.island, state, handlers, now)
}

/** Once-a-second refresh of the elapsed time in the island while the agent works. */
export function renderTick(dom, state, handlers, now = Date.now()) {
  if (state.messages.length > 0 && isBusy(state)) renderIsland(dom.island, state, handlers, now)
}
