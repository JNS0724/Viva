import { getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { traceItems } from '../selectors.ts'
import { FOLLOWUP_KEY, pageGroups, pageTask, shownOnPage, SUGGESTION_KEY } from '../tasks-state.ts'
import { h, keepingInput } from './dom.ts'
import { icon } from './icons.ts'
import { standing, statusMark } from './task-card.ts'
import { renderThread } from './thread.ts'
import { reconcileChildren } from './reconcile.ts'
import { followupDetail, followupStanding, suggestionDetail, whenText } from './followups.ts'
import { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } from '../../shared/text-limits.ts'

/**
 * The 后台 page: every background task on the left, grouped by where it stands, with the follow-ups among them
 * (待你看的 first: drafts prepared in the background; then what is being prepared, then what is scheduled); on
 * the right the one picked, its whole conversation as the thread shows one, its steps folded under it, and its
 * own input: words into its turn while it works, its next question once it has ended. A follow-up shows its
 * draft and what can be done with it. One of the hub's pages, beside 回顾 · 关于你 · 设置.
 */
const groupNames = (): Readonly<Record<string, string>> => ({ waiting: t("task.status.waiting"), running: t("island-tasks.in.background"), ended: t("island-view.done") })
const LIVE = new Set(['running', 'waiting'])
export { FOLLOWUP_KEY, SUGGESTION_KEY }
const followupGroupsCopy = (): ReadonlyArray<[string, string]> => ([['ready', t("tasks-page.for.your.review")], ['preparing', t("tasks-page.preparing")], ['scheduled', t("tasks-page.scheduled")]])

/**
 * The page as it is drawn: what was picked, while it is still on the list; once it is gone from there (deleted,
 * answered, taken up), the first one on the list, so the right never shows what the left no longer has.
 */
export function onPage(state: State): State {
  const picked = shownOnPage(state)
  return picked === state.tasks.page.selected ? state : { ...state, tasks: { ...state.tasks, page: { ...state.tasks.page, selected: picked } } }
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
  return followupGroupsCopy().flatMap(([status, name]) => {
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

/**
 * Folded by the user: a narrow strip where the list was, » to unfold it, and how many wait on the user so none
 * is missed while it is folded.
 */
function foldedSide(state: State, handlers: Handlers) {
  const waiting = state.tasks.list.filter((task) => task.status === 'waiting').length
  return h('nav', { class: 'tp-side tp-side-folded', 'aria-label': t("tasks-page.background.tasks") },
    h('button', {
      class: 'icon-btn tp-fold', type: 'button', title: t("dock.expand"), 'aria-label': t("dock.expand"), 'aria-expanded': 'false',
      onClick: () => handlers.foldTaskList(false),
    }, h('span', { text: '»', 'aria-hidden': 'true' })),
    waiting ? h('span', { class: 'tp-count', title: t("dock.waiting.count", { p0: waiting }), text: String(waiting) }) : null)
}

/**
 * The list beside the hub's own sidebar (返回 and the other pages stay there, as on every page of the hub), « at
 * its head to fold it to a strip; the user's choice, kept, for the list is not looked at often.
 */
function sideView(state: State, handlers: Handlers, now: number) {
  if (state.tasks.listFolded) return foldedSide(state, handlers)
  const selected = state.tasks.page.selected
  return h('nav', { class: 'tp-side', 'aria-label': t("tasks-page.background.tasks") },
    h('div', { class: 'tp-side-head' },
      h('span', { class: 'tp-side-title', text: t("tasks-page.background.tasks") }),
      h('button', {
        class: 'icon-btn tp-fold', type: 'button', title: t("task.list.collapse"), 'aria-label': t("task.list.collapse"), 'aria-expanded': 'true',
        onClick: () => handlers.foldTaskList(true),
      }, h('span', { text: '«', 'aria-hidden': 'true' }))),
    prepareLine(state, now),
    ...suggestionGroup(state, selected, handlers),
    ...followupGroups(state, selected, handlers, now),
    ...pageGroups(state).flatMap(({ key, tasks }) => [
      h('div', { class: 'tp-group', text: `${groupNames()[key]} · ${tasks.length}` }),
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

type StepItem = ReturnType<typeof traceItems>[number]
const stepRows = new WeakMap<HTMLElement, Map<string, { item: StepItem, node: HTMLElement }>>()

function stepRow(item: StepItem) {
  return h('li', { class: 'trace-row' },
    h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
    h('div', { class: 'trace-main' },
      h('div', { class: 'row-between' }, h('span', { class: 'trace-title', text: item.title }), h('span', { class: 'trace-time', text: item.time })),
      item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))
}

function updateSteps(section: HTMLElement, state: State, task: BackgroundTask) {
  const items = traceItems(task.view)
  const open = state.tasks.page.steps
  const toggle = section.querySelector<HTMLButtonElement>('.tp-toggle')!
  const label = t("tasks-page.activity.steps", { length: items.length, value2: open ? t("tasks-page.collapse") : t("tasks-page.expand") })
  if (toggle.textContent !== label) toggle.textContent = label
  if (toggle.getAttribute('aria-expanded') !== String(open)) toggle.setAttribute('aria-expanded', String(open))
  if (!items.length) { section.remove(); stepRows.delete(section); return }
  if (!open) { section.querySelector('.trace')?.remove(); stepRows.delete(section); return }
  const previous = stepRows.get(section)
  const next = new Map<string, { item: StepItem, node: HTMLElement }>()
  const nodes = items.map(item => {
    const cached = previous?.get(item.key)
    const node = cached && cached.item.title === item.title && cached.item.detail === item.detail
      && cached.item.time === item.time && cached.item.tone === item.tone ? cached.node : stepRow(item)
    next.set(item.key, { item, node })
    return node
  })
  let list = section.querySelector<HTMLOListElement>('.trace')
  if (!list) { list = h('ol', { class: 'trace' }); section.append(list) }
  reconcileChildren(list, nodes)
  stepRows.set(section, next)
}

function stepsView(state: State, task: BackgroundTask, handlers: Handlers) {
  if (!traceItems(task.view).length) return null
  const section = h('section', { class: 'tp-steps', 'aria-label': t("drawer.activity") },
    h('button', { class: 'tp-toggle', type: 'button', onClick: () => handlers.toggleTaskSteps() },
      ''))
  updateSteps(section, state, task)
  return section
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
    if (text.length > MAX_MESSAGE_CHARS) return handlers.inputProblem(MESSAGE_TOO_LONG)
    const draft = field.value
    const page = field.closest('.tp-main')?.parentElement
    field.value = ''
    // A refused follow-up restores the draft in this task, through redraws, without overwriting newer typing.
    const restore = () => {
      const current = page?.querySelector<HTMLTextAreaElement>(`textarea[name="${CSS.escape(field.name)}"]`)
      if (current && !current.value) current.value = draft
    }
    Promise.resolve(handlers.sendToTask(task.id, text)).then((accepted) => {
      if (accepted === false) restore()
    }).catch(() => {
      restore()
      handlers.inputProblem(t("task.send.failed"))
    })
  }
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
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

const renderedPages = new WeakMap<HTMLElement, { state: State, handlers: Handlers, now: number, locale: string }>()

/** Only a local disclosure changed; all other render inputs must still match. */
export function onlyTaskStepsChanged(before: State, after: State): boolean {
  const sameExcept = (a: object, b: object, except: string) => {
    const left = Object.entries(a).filter(([key]) => key !== except)
    const right = Object.entries(b).filter(([key]) => key !== except)
    return left.length === right.length && left.every(([key, value]) => Reflect.get(b, key) === value)
  }
  return before.tasks.page.open && after.tasks.page.open
    && before.tasks.page.steps !== after.tasks.page.steps
    && sameExcept(before, after, 'tasks')
    && sameExcept(before.tasks, after.tasks, 'page')
    && sameExcept(before.tasks.page, after.tasks.page, 'steps')
}

/** Rebuilt as task content changes; a disclosure keeps the conversation and input alive. */
export function renderTasksPage(container: HTMLElement, shown: State, handlers: Handlers, now = Date.now()) {
  const cached = renderedPages.get(container)
  const prior = cached
  const localeChanged = Boolean(prior && prior.locale !== getLocale())
  container.dataset.open = String(shown.tasks.page.open)
  if (!shown.tasks.page.open) {
    renderedPages.delete(container)
    container.replaceChildren()
    return
  }
  const state = onPage(shown)
  const scroller = container.querySelector('.tp-scroll')
  const sameTask = container.querySelector<HTMLElement>('.tp-main')?.dataset.task === state.tasks.page.selected
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  const top = scroller?.scrollTop ?? 0
  const task = pageTask(state)
  const steps = container.querySelector<HTMLElement>('.tp-steps')
  const toggle = steps?.querySelector<HTMLButtonElement>('.tp-toggle')
  if (prior && !localeChanged && prior.handlers === handlers && sameTask && task && steps && toggle
    && onlyTaskStepsChanged(prior.state, shown)) {
    updateSteps(steps, state, task)
    if (scroller) scroller.scrollTop = atBottom ? scroller.scrollHeight : top
    renderedPages.set(container, { state: shown, handlers, now, locale: getLocale() })
    return
  }
  // A stream changes the task view, not its identity. Keep the thread's keyed
  // rendering cache and the live textarea (including composition) attached.
  const previousTask = prior && pageTask(onPage(prior.state))
  const main = container.querySelector<HTMLElement>('.tp-main')
  const thread = main?.querySelector<HTMLElement>('.tp-thread')
  if (prior?.handlers === handlers && sameTask && task && previousTask?.id === task.id
    && previousTask.status === task.status && main && thread && scroller) {
    container.querySelector('.tp-side')?.replaceWith(sideView(state, handlers, now))
    const title = main.querySelector('.tp-title')
    if (title && title.textContent !== `#${task.title}`) title.textContent = `#${task.title}`
    if (localeChanged || standing(previousTask, prior.now) !== standing(task, now)) {
      main.querySelector('.tp-status')?.replaceChildren(statusMark(task.status), standing(task, now))
    }
    if (localeChanged) {
      const live = LIVE.has(task.status)
      const action = main.querySelector('.tp-act')
      if (action) action.textContent = live ? t("island-tasks.stop") : t("tasks-page.close.this.task")
      const field = main.querySelector<HTMLTextAreaElement>('.tp-input')
      if (field) {
        field.setAttribute('aria-label', live ? t("tasks-page.interruption") : t("task-card.ask.more"))
        field.placeholder = live ? t("tasks-page.add.or.change.instructions.enter.to.send") : t("tasks-page.ask.more.enter.to.send")
        main.querySelector('.tp-composer button')?.setAttribute('aria-label', live ? t("tasks-page.interruption") : t("task-card.ask.more"))
      } else {
        const resume = main.querySelector(':scope > button')
        if (resume) resume.textContent = t("followups.continue")
      }
    }
    renderThread(thread, threadState(state, task), scopedHandlers(handlers, task), now)
    if (localeChanged || prior.state.tasks.page.steps !== state.tasks.page.steps
      || previousTask.view.timeline !== task.view.timeline
      || previousTask.view.thoughts !== task.view.thoughts
      || previousTask.view.tools !== task.view.tools) {
      if (steps) updateSteps(steps, state, task)
      else {
        const nextSteps = stepsView(state, task, handlers)
        if (nextSteps) scroller.append(nextSteps)
      }
    }
    scroller.scrollTop = atBottom ? scroller.scrollHeight : top
    renderedPages.set(container, { state: shown, handlers, now, locale: getLocale() })
    return
  }
  keepingInput(container, () => container.replaceChildren(sideView(state, handlers, now), mainView(state, handlers, now)))
  const next = container.querySelector('.tp-scroll')
  if (next) next.scrollTop = sameTask && !atBottom ? top : next.scrollHeight
  renderedPages.set(container, { state: shown, handlers, now, locale: getLocale() })
}
