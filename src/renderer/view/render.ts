import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { localeRevision } from '../../shared/i18n/locale.ts'
import { isBusy } from '../state.ts'
import { setupView } from '../selectors.ts'
import type { SetupCopy } from '../selectors.ts'
import type { Dom } from '../page-elements.ts'
import { h } from './dom.ts'
import { renderDrawer } from './drawer.ts'
import { renderEarlier, updateEarlierControls } from './earlier.ts'
import { queueLayout } from './reconcile.ts'
import { renderHistoryPanel, renderToast } from './history-panel.ts'
import { renderHome } from './home.ts'
import { renderHub } from './hub.ts'
import { renderTasksPage } from './tasks-page.ts'
import { renderFeedPage } from './feed-page.ts'
import { feedCount } from '../feed-state.ts'
import { icon } from './icons.ts'
import { renderIsland } from './island.ts'
import { renderModelPicker } from './model-picker.ts'
import { renderProfilePanel } from './profile-panel.ts'
import { renderRewindConfirm } from './rewind.ts'
import { renderResumeDialog } from './resume-dialog.ts'
import { renderSettings } from './settings.ts'
import { renderCapabilitiesPage } from './capabilities.ts'
import { capabilityProblems } from '../capabilities-state.ts'
import { renderThread } from './thread.ts'
import { renderTopicLabel } from './topic-label.ts'
import { renderPermissionPicker } from './permission-picker.ts'
import { renderWorkDir } from './workdir.ts'
import { cardedTasks } from './task-card.ts'

let renderedSettings: unknown[] = []
let renderedProfile: unknown = null
let renderedProfileLocale = -1
let renderedDrawerInputs: unknown[] = []
let renderedHistoryInputs: unknown[] = []
let renderedEarlierInputs: unknown[] = []
let renderedToast: unknown = null

/**
 * The earlier part of the timeline changes only when a page comes in, the conversation moves on, or the topic
 * on screen changes (and with its first words, a new topic can no longer be undone).
 */
function renderEarlierIfChanged(container: HTMLElement, state: State, handlers: Handlers) {
  const inputs = [localeRevision(), state.earlier, state.info.cwd, state.topic.parentId, state.topic.startedAt, state.messages.length === 0]
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
  const inputs = [localeRevision(), state.topic, state.usage, state.messages.length, state.earlier.segments, ready, isBusy(state), state.switching, state.newTopicPending]
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
  const inputs = [localeRevision(), permission, permissionMenu, permissionBusy, ready, isBusy(state)]
  if (inputs.every((value, i) => value === renderedPermissionInputs[i])) return
  renderedPermissionInputs = inputs
  renderPermissionPicker(area, state.settings, handlers, { ready, busy: isBusy(state) })
}

function renderSettingsIfChanged(container: HTMLElement, state: State, handlers: Handlers) {
  const inputs = [localeRevision(), state.settings, state.models]
  if (inputs.every((value, i) => value === renderedSettings[i])) return
  renderedSettings = inputs
  renderSettings(container, state.settings, state.models, handlers)
}
let renderedCapabilities: unknown[] = []
/** 能力, and how many need looking at by its name in the hub, depend on the skills, servers and plugins, how the servers stand now, and on itself. */
function renderCapabilitiesIfChanged(dom: Dom, state: State, handlers: Handlers) {
  const connected = state.info.mode === 'live'
  const inputs = [localeRevision(), state.capabilities, state.extensions, state.plugins, state.importFlow, connected, state.info.mcp]
  if (inputs.every((value, i) => value === renderedCapabilities[i])) return
  renderedCapabilities = inputs
  const problems = capabilityProblems(state)
  dom.capabilitiesCount.hidden = problems === 0
  dom.capabilitiesCount.textContent = String(problems)
  renderCapabilitiesPage(dom.capabilities, state, handlers, { connected })
}

function renderProfileIfChanged(container: HTMLElement, memory: State['memory'], handlers: Handlers) {
  if (memory === renderedProfile && renderedProfileLocale === localeRevision()) return
  renderedProfileLocale = localeRevision()
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
  // Stream updates grow retained text nodes even when the thread's direct children stay attached.
  renderThread(dom.thread, state, handlers, now)
  queueLayout(dom.thread, () => {
    if (!dom.thread.isConnected || dom.thread.hidden) return
    return dom.follower.measureAfterRender(() => latestQuestionTop(dom.thread, dom.scroll))
  })
}

/** The drawer only depends on these slices; skipping identical renders keeps its scroll and hover state intact. */
function renderDrawerIfChanged(container: HTMLElement, state: State, handlers: Handlers) {
  const inputs = state.drawer === 'files'
    ? [localeRevision(), state.drawer, state.files, state.timeline, state.tools, state.info.cwd]
    : [localeRevision(), state.drawer, state.timeline, state.tools, state.thoughts, state.usage, state.restoredTrace]
  if (inputs.every((value, i) => value === renderedDrawerInputs[i])) return
  renderedDrawerInputs = inputs
  renderDrawer(container, state, handlers)
}

/** The panel only depends on its own slice; skipping identical renders keeps hover and focus in the list. */
function renderHistoryIfChanged(dom: Dom, state: State, handlers: Handlers) {
  const inputs = [localeRevision(), state.history, state.review]
  if (inputs.every((value, i) => value === renderedHistoryInputs[i])) return
  renderedHistoryInputs = inputs
  renderHistoryPanel(dom, state, handlers)
}

let renderedTasksPage: unknown[] = []
let renderedFeedPage: unknown[] = []

/** 动态 and its count in the title bar depend on it alone. */
function renderFeedIfChanged(dom: Dom, state: State, handlers: Handlers, now: number) {
  const inputs = [localeRevision(), state.feed]
  if (inputs.every((value, i) => value === renderedFeedPage[i])) return
  renderedFeedPage = inputs
  const count = feedCount(state)
  dom.feedCount.hidden = count === 0
  dom.feedCount.textContent = String(count)
  if (state.feed.open) renderFeedPage(dom.feedPage, state, handlers, now)
}

/** The 后台 page depends on the tasks and on itself; a task at work changes it as it goes. */
function renderTasksPageIfChanged(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const inputs = [localeRevision(), state.tasks.list, state.tasks.page, state.tasks.listFolded]
  if (inputs.every((value, i) => value === renderedTasksPage[i])) return
  renderedTasksPage = inputs
  renderTasksPage(container, state, handlers, now)
}

function renderToastIfChanged(container: HTMLElement, toast: State['toast'], handlers: Handlers) {
  if (toast === renderedToast) return
  renderedToast = toast
  renderToast(container, toast, handlers)
}

let ANSWER_PLACEHOLDER = t("render.type.your.answer.enter.to.send")
let STEER_PLACEHOLDER = t("render.add.or.change.instructions.for.the.next")

/**
 * While the agent cannot start, the composer is disabled and says why; while switching, only sending waits;
 * while the agent asks, it takes the answer; while it works, what is typed goes into the turn.
 */
function renderComposerAvailability(dom: Dom, setup: SetupCopy | null, switching: boolean, { asking, busy, failed }: { asking: boolean, busy: boolean, failed: boolean }) {
  dom.input.dataset.placeholder ??= dom.input.placeholder
  dom.input.disabled = Boolean(setup)
  const placeholder = failed ? t("render.new.topic.preparation.failed.draft.preserved.click") : switching ? t("render.preparing.a.new.topic.you.can.type") : asking ? ANSWER_PLACEHOLDER : busy ? STEER_PLACEHOLDER : dom.input.dataset.placeholder
  dom.input.placeholder = setup?.placeholder ?? placeholder
  dom.sendBtn.disabled = Boolean(setup) || switching
  // A question the agent asks is answered here, not handed to the background.
}

/** While the agent works the button stops it, unless there are words to send into the turn. */
export function renderSendButton(dom: Dom, state: State) {
  const stops = isBusy(state) && !dom.input.value.trim() && !Number(dom.composer.dataset.attachments ?? 0)
  if (dom.sendBtn.dataset.busy === String(stops) && dom.sendBtn.dataset.locale === String(localeRevision())) return
  dom.sendBtn.dataset.locale = String(localeRevision())
  dom.sendBtn.dataset.busy = String(stops)
  dom.sendBtn.setAttribute('aria-label', stops ? t("island-dom.stop") : t("render.send"))
  dom.sendBtn.replaceChildren(icon(stops ? 'stop' : 'send', 22))
}

function renderComposer(dom: Dom, state: State, handlers: Handlers) {
  renderComposerAvailability(dom, setupView(state.info), state.switching || state.newTopicPending, { asking: Boolean(state.question), busy: isBusy(state), failed: state.newTopicPending && !state.switching })
  renderSendButton(dom, state)
  renderWorkDir(dom, state, handlers, document.documentElement.dataset.platform ?? 'darwin')
  renderTopicLabelIfChanged(dom.ctxArea, state, handlers)
  renderPermissionIfChanged(dom.permArea, state, handlers)
  dom.toggleDrawer.setAttribute('aria-pressed', String(Boolean(state.drawer)))
  renderModelPicker(dom, state, handlers)
}

/** Cards are conversation content even when no foreground user bubble was created. */
export const showsHome = (state: State) => state.messages.length === 0 && state.earlier.segments.length === 0
  && cardedTasks(state).length === 0
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
  renderComposer(dom, state, handlers)
  renderSettingsIfChanged(dom.settings, state, handlers)
  renderProfileIfChanged(dom.profile, state.memory, handlers)
  renderHub(dom, state)
  renderTasksPageIfChanged(dom.tasksPage, state, handlers, now)
  renderFeedIfChanged(dom, state, handlers, now)
  renderCapabilitiesIfChanged(dom, state, handlers)
  renderHistoryIfChanged(dom, state, handlers)
  renderToastIfChanged(dom.toast, state.toast, handlers)
  renderRewindConfirm(dom.rewindConfirm, state, handlers)
  renderResumeDialog(dom.resumeDialog, state.resume, handlers)
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

onLocaleChange(() => {
  ANSWER_PLACEHOLDER = t("render.type.your.answer.enter.to.send")
  STEER_PLACEHOLDER = t("render.add.or.change.instructions.for.the.next")
})
