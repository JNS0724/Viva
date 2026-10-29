import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { traceItems } from '../selectors.ts'
import { pageGroups, pageTask } from '../tasks-state.ts'
import { h, keepingInput } from './dom.ts'
import { icon } from './icons.ts'
import { standing, statusMark } from './task-card.ts'
import { renderThread } from './thread.ts'
import { followupDetail, followupStanding, suggestionDetail, whenText } from './followups.ts'

/**
 * The 后台 page: every background task on the left, grouped by where it stands, with the follow-ups among them
 * (待你看的 first: drafts prepared in the background; then what is being prepared, then what is scheduled); on
 * the right the one picked, its whole conversation as the thread shows one, its steps folded under it, and its
 * own input: words into its turn while it works, its next question once it has ended. A follow-up shows its
 * draft and what can be done with it. Same place as 搜索 · 关于你 · 设置.
 */
let GROUP_NAMES: Readonly<Record<string, string>> = { waiting: t("task-card.waiting.for.approval"), running: t("island-tasks.working"), ended: t("island-view.done") }
const LIVE = new Set(['running', 'waiting'])
/** Follow-ups on the page are picked by this prefix, beside the tasks' ids. */
export const FOLLOWUP_KEY = 'followup:'
/** And the messages suggested for one by this. */
export const SUGGESTION_KEY = 'suggestion:'
let FOLLOWUP_GROUPS: ReadonlyArray<[string, string]> = [['ready', t("tasks-page.for.your.review")], ['preparing', t("tasks-page.preparing")], ['scheduled', t("tasks-page.scheduled")]]
const LISTED_STATUSES = new Set(FOLLOWUP_GROUPS.map(([status]) => status))

/** The keys on the list at the left, in its order: messages to decide on, follow-ups by group, then the tasks. */
function listedKeys(state: State): string[] {
  const suggestions = state.followups.suggestions.filter((item: Untyped) => item.status === 'open').map((item: Untyped) => `${SUGGESTION_KEY}${item.id}`)
  const followups = FOLLOWUP_GROUPS.flatMap(([status]) => state.followups.followups
    .filter((item: Untyped) => item.status === status && LISTED_STATUSES.has(item.status))
    .map((item: Untyped) => `${FOLLOWUP_KEY}${item.id}`))
  const tasks = pageGroups(state).flatMap((group) => group.tasks.map((task) => task.id))
  return [...suggestions, ...followups, ...tasks]
}

/**
 * The page as it is drawn: what was picked, while it is still on the list; once it is gone from there (deleted,
 * answered, taken up), the first one on the list, so the right never shows what the left no longer has.
 */
export function onPage(state: State): State {
  const keys = listedKeys(state)
  const selected = state.tasks.page.selected
  const picked = selected && keys.includes(selected) ? selected : keys[0] ?? null
  return picked === selected ? state : { ...state, tasks: { ...state.tasks, page: { ...state.tasks.page, selected: picked } } }
}

/** Messages that may need the user, first: they wait on a decision. */
function suggestionGroup(state: State, selected: string | null, handlers: Handlers) {
  const open: Untyped[] = state.followups.suggestions.filter((suggestion: Untyped) => suggestion.status === 'open')
  if (!open.length) return []
  return [
    h('div', { class: 'tp-group', text: t("tasks-page.follow.up", { length: open.length }) }),
    ...open.map((suggestion) => h('button', {
      class: 'tp-row fu-row', type: 'button', 'data-status': 'suggested', 'aria-current': `${SUGGESTION_KEY}${suggestion.id}` === selected ? 'page' : null,
      onClick: () => handlers.selectTask(`${SUGGESTION_KEY}${suggestion.id}`),
    },
    h('span', { class: 'tp-name', text: suggestion.title }),
    h('span', { class: 'tp-meta', text: t("tasks-page.label", { value1: suggestion.sender || t("tasks-page.message"), why: suggestion.why }) }))),
  ]
}

function followupGroups(state: State, selected: string | null, handlers: Handlers, now: number) {
  const list: readonly Untyped[] = state.followups.followups
  return FOLLOWUP_GROUPS.flatMap(([status, name]) => {
    const group = list.filter((followup) => followup.status === status)
    if (!group.length) return []
    return [
      h('div', { class: 'tp-group', text: `${name} · ${group.length}` }),
      ...group.map((followup) => h('button', {
        class: 'tp-row fu-row', type: 'button', 'data-status': status, 'aria-current': `${FOLLOWUP_KEY}${followup.id}` === selected ? 'page' : null,
        onClick: () => handlers.selectTask(`${FOLLOWUP_KEY}${followup.id}`),
      },
      h('span', { class: 'tp-name', text: followup.title }),
      h('span', { class: 'tp-meta', text: followupStanding(followup, now) }))),
    ]
  })
}

/** One line on background preparation: preparing now, waiting on the user, or when it looks next. */
function prepareLine(state: State, now: number) {
  const prepare = state.followups.state
  if (prepare?.running) return h('p', { class: 'fu-state', 'data-on': 'true', text: t("tasks-page.preparing.in.background", { current: prepare.current }) })
  if (prepare?.waiting) return h('p', { class: 'fu-state', text: t("tasks-page.preparing.later", { waiting: prepare.waiting }) })
  if (prepare?.nextAt) return h('p', { class: 'fu-state', text: t("tasks-page.next.background.preparation", { value1: whenText(prepare.nextAt, now) }) })
  return null
}

function sideView(state: State, handlers: Handlers, now: number) {
  const selected = state.tasks.page.selected
  return h('nav', { class: 'hub-side tp-side', 'aria-label': t("tasks-page.background.tasks") },
    h('button', { class: 'hub-back', type: 'button', onClick: () => handlers.closeHub() },
      icon('back', 16), t("tasks-page.back"), h('kbd', { text: 'Esc' })),
    prepareLine(state, now),
    ...suggestionGroup(state, selected, handlers),
    ...followupGroups(state, selected, handlers, now),
    ...pageGroups(state).flatMap(({ key, tasks }) => [
      h('div', { class: 'tp-group', text: `${GROUP_NAMES[key]} · ${tasks.length}` }),
      ...tasks.map((task) => h('button', {
        class: 'tp-row', type: 'button', 'aria-current': task.id === selected ? 'page' : null,
        onClick: () => handlers.selectTask(task.id),
      },
      h('span', { class: 'tp-name', text: task.title }),
      h('span', { class: 'tp-meta' }, statusMark(task.status), standing(task, now)))),
    ]))
}

/** The task's view as the thread draws one: all of what it said shown, nothing to go back to, no tasks of its own. */
function threadState(state: State, task: BackgroundTask): State {
  return {
    ...state,
    ...task.view,
    messages: task.view.messages.map((message: ThreadMessage) => ({ ...message, shown: message.text.length })),
    conversationId: null,
    restored: null,
    folds: [],
    proposals: [],
    tasks: { ...state.tasks, list: [], reports: [], unfinished: [] },
  }
}

/** Its question is answered from here for the task, not for the conversation on screen. */
const scopedHandlers = (handlers: Handlers, task: BackgroundTask): Handlers => ({
  ...handlers,
  pickOption: (id: string, label: string) => handlers.pickTaskOption(task.id, id, label),
  submitAnswer: () => handlers.submitTaskAnswer(task.id),
  skipQuestion: () => handlers.skipTaskQuestion(task.id),
})

function stepsView(state: State, task: BackgroundTask, handlers: Handlers) {
  const items = traceItems(task.view)
  if (!items.length) return null
  const open = state.tasks.page.steps
  return h('section', { class: 'tp-steps', 'aria-label': t("drawer.activity") },
    h('button', { class: 'tp-toggle', type: 'button', 'aria-expanded': String(open), onClick: () => handlers.toggleTaskSteps() },
      t("tasks-page.activity.steps", { length: items.length, value2: open ? t("tasks-page.collapse") : t("tasks-page.expand") })),
    open
      ? h('ol', { class: 'trace' }, items.map((item) => h('li', { class: 'trace-row' },
        h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
        h('div', { class: 'trace-main' },
          h('div', { class: 'row-between' }, h('span', { class: 'trace-title', text: item.title }), h('span', { class: 'trace-time', text: item.time })),
          item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))))
      : null)
}

function inputView(task: BackgroundTask, handlers: Handlers) {
  if (task.status === 'interrupted') return h('button', { class: 'btn btn-secondary', type: 'button', text: t("followups.continue"), onClick: () => handlers.resumeUnfinished(task.id) })
  const live = LIVE.has(task.status)
  const field = h('textarea', {
    class: 'tp-input', name: `task-input-${task.id}`, rows: 2, 'aria-label': live ? t("tasks-page.interruption") : t("task-card.ask.more"),
    placeholder: live ? t("tasks-page.add.or.change.instructions.enter.to.send") : t("tasks-page.ask.more.enter.to.send"),
  })
  const send = () => {
    const text = field.value.trim()
    if (!text) return
    field.value = ''
    handlers.sendToTask(task.id, text)
  }
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    send()
  })
  return h('form', { class: 'tp-composer', onSubmit: (event: SubmitEvent) => { event.preventDefault(); send() } },
    field,
    h('button', { class: 'send-btn', type: 'submit', 'aria-label': live ? t("tasks-page.interruption") : t("task-card.ask.more") }, icon('send', 20)))
}

/** The follow-up picked, or, with nothing picked and no task, the first that waits for the user. */
function pickedFollowup(state: State): Untyped | null {
  const list: readonly Untyped[] = state.followups.followups
  const selected = state.tasks.page.selected
  if (selected?.startsWith(FOLLOWUP_KEY)) return list.find((followup) => `${FOLLOWUP_KEY}${followup.id}` === selected) ?? null
  if (selected?.startsWith(SUGGESTION_KEY)) return null
  if (selected || pageTask(state)) return null
  return list.find((followup) => followup.status === 'ready') ?? null
}

function mainView(state: State, handlers: Handlers, now: number) {
  const selected = state.tasks.page.selected
  if (selected?.startsWith(SUGGESTION_KEY)) {
    const suggestion = state.followups.suggestions.find((item: Untyped) => `${SUGGESTION_KEY}${item.id}` === selected)
    if (suggestion) return suggestionDetail(suggestion, handlers, now)
  }
  const followup = pickedFollowup(state)
  if (followup) return followupDetail(followup, state.followups.state, handlers, now)
  const task = selected?.startsWith(FOLLOWUP_KEY) || selected?.startsWith(SUGGESTION_KEY) ? null : pageTask(state)
  if (!task) {
    return h('div', { class: 'tp-main tp-empty' },
      h('p', { class: 'help', text: t("tasks-page.no.background.work.yet.type.a.request") }))
  }
  const live = LIVE.has(task.status)
  const thread = h('div', { class: 'thread tp-thread' })
  renderThread(thread, threadState(state, task), scopedHandlers(handlers, task), now)
  return h('div', { class: 'tp-main', 'data-task': task.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: `#${task.title}` }),
      h('span', { class: 'tp-status' }, statusMark(task.status), standing(task, now)),
      live
        ? h('button', { class: 'btn btn-secondary tp-act', type: 'button', text: t("island-tasks.stop"), onClick: () => handlers.stopTask(task.id) })
        : h('button', { class: 'btn btn-secondary tp-act', type: 'button', text: t("tasks-page.close.this.task"), onClick: () => handlers.closeTask(task.id) })),
    h('div', { class: 'tp-scroll' }, thread, stepsView(state, task, handlers)),
    inputView(task, handlers))
}

/** Rebuilt as the tasks change; what was typed and where it was scrolled to stay. */
export function renderTasksPage(container: HTMLElement, shown: State, handlers: Handlers, now = Date.now()) {
  container.dataset.open = String(shown.tasks.page.open)
  if (!shown.tasks.page.open) {
    container.replaceChildren()
    return
  }
  const state = onPage(shown)
  const scroller = container.querySelector('.tp-scroll')
  const sameTask = container.querySelector<HTMLElement>('.tp-main')?.dataset.task === state.tasks.page.selected
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  const top = scroller?.scrollTop ?? 0
  keepingInput(container, () => container.replaceChildren(sideView(state, handlers, now), mainView(state, handlers, now)))
  const next = container.querySelector('.tp-scroll')
  if (next) next.scrollTop = sameTask && !atBottom ? top : next.scrollHeight
}

onLocaleChange(() => {
  GROUP_NAMES = { waiting: t("task-card.waiting.for.approval"), running: t("island-tasks.working"), ended: t("island-view.done") }
  FOLLOWUP_GROUPS = [['ready', t("tasks-page.for.your.review")], ['preparing', t("tasks-page.preparing")], ['scheduled', t("tasks-page.scheduled")]]
})
