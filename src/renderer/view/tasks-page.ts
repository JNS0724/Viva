import { getLocale } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { traceItems } from '../selectors.ts'
import { isRecentUnread, pageGroups, pageTask, shownOnPage } from '../tasks-state.ts'
import { h, keepingInput } from './dom.ts'
import { standing, statusMark } from './task-card.ts'
import { renderThread, type ThreadView } from './thread.ts'
import { queueLayout, reconcileChildren } from './reconcile.ts'

/**
 * The 后台 page: every background task on the left, grouped by where it stands, with the follow-ups among them
 * (待你看的 first: drafts prepared in the background; then what is being prepared, then what is scheduled); on
 * the right the one picked, its whole conversation as the thread shows one, its steps folded under it, and its
 * own input: words into its turn while it works, its next question once it has ended. A follow-up shows its
 * draft and what can be done with it. One of the hub's pages, beside 回顾 · 关于你 · 设置.
 */
const groupNames = (): Readonly<Record<string, string>> => ({ waiting: t("task.status.waiting"), running: t("island-tasks.in.background"), ended: t("island-view.done") })
const LIVE = new Set(['running', 'waiting'])
const pendingScroll = new WeakMap<HTMLElement, { follow: boolean, top: number, observedTop: number }>()

/**
 * The page as it is drawn: what was picked, while it is still on the list; once it is gone from there (deleted,
 * answered, taken up), the first one on the list, so the right never shows what the left no longer has.
 */
export function onPage(state: State): State {
  const picked = shownOnPage(state)
  return picked === state.tasks.page.selected ? state : { ...state, tasks: { ...state.tasks, page: { ...state.tasks.page, selected: picked } } }
}

/**
 * The list owns its navigation targets. Task streams update their labels in place, and only task ids entering,
 * leaving or changing group affect the list order. Its scroll container and fold button live with the page.
 */
function createTaskSidebar(handlers: Handlers) {
  let folded = false
  const title = h('span', { class: 'tp-side-title' })
  const glyph = h('span', { 'aria-hidden': 'true' })
  const fold = h('button', { class: 'icon-btn tp-fold', type: 'button', onClick: () => handlers.foldTaskList(!folded) }, glyph)
  const head = h('div', { class: 'tp-side-head' }, title)
  const count = h('span', { class: 'tp-count' })
  const el = h('nav', { class: 'tp-side' })
  const groups = new Map<string, { el: HTMLElement, name: Text, count: HTMLSpanElement }>()
  const rows = new Map<string, { el: HTMLButtonElement, name: HTMLSpanElement, mark: HTMLSpanElement, standing: Text }>()
  function update(state: State, now: number) {
    folded = state.tasks.listFolded
    el.className = folded ? 'tp-side tp-side-folded' : 'tp-side'
    el.setAttribute('aria-label', t('tasks-page.background.tasks'))
    title.textContent = t('tasks-page.background.tasks')
    const label = t(folded ? 'dock.expand' : 'task.list.collapse')
    fold.title = label
    fold.setAttribute('aria-label', label)
    fold.setAttribute('aria-expanded', String(!folded))
    glyph.textContent = folded ? '»' : '«'
    if (folded) {
      const waiting = state.tasks.list.filter(task => task.status === 'waiting').length
      count.textContent = String(waiting)
      count.title = t('dock.waiting.count', { p0: waiting })
      reconcileChildren(el, waiting ? [fold, count] : [fold])
      return
    }
    reconcileChildren(head, [title, fold])
    const names = groupNames()
    const present = new Set<string>()
    const children: HTMLElement[] = [head]
    for (const { key, tasks } of pageGroups(state)) {
      let group = groups.get(key)
      if (!group) {
        const name = document.createTextNode('')
        const count = h('span', { class: 'tp-group-count' })
        group = { el: h('div', { class: 'tp-group' }, name, count), name, count }
        groups.set(key, group)
      }
      group.name.data = names[key]
      group.count.textContent = String(tasks.length)
      children.push(group.el)
      for (const task of tasks) {
        present.add(task.id)
        let row = rows.get(task.id)
        if (!row) {
          const name = h('span', { class: 'tp-name' }), mark = statusMark(task.status), standing = document.createTextNode('')
          row = { name, mark, standing, el: h('button', { class: 'tp-row', type: 'button', onClick: () => handlers.selectTask(task.id) },
            name, h('span', { class: 'tp-meta' }, mark, standing)) }
          rows.set(task.id, row)
        }
        if (task.id === state.tasks.page.selected) row.el.setAttribute('aria-current', 'page')
        else row.el.removeAttribute('aria-current')
        if (row.name.textContent !== task.title) row.name.textContent = task.title
        row.mark.dataset.status = task.status
        // Ended a short while ago and not told of yet: marked, until opened here or its result comes into the conversation.
        const unread = isRecentUnread(state, task, now)
        row.el.dataset.unread = String(unread)
        const text = unread ? `${standing(task, now)} · ${t('tasks-page.unread')}` : standing(task, now)
        if (row.standing.data !== text) row.standing.data = text
        children.push(row.el)
      }
    }
    reconcileChildren(el, children)
    for (const id of rows.keys()) if (!present.has(id)) rows.delete(id)
  }
  return { el, update }
}

/**
 * The task's conversation as the thread draws one (view/thread.ts ThreadView): all of what it said shown; nothing to
 * go back to, no tasks, records or follow-ups of its own; the window's only for how its maid looks.
 */
export function threadState(state: State, task: BackgroundTask): ThreadView {
  return {
    ...task.view,
    messages: task.view.messages.map((message: ThreadMessage) => ({ ...message, shown: message.text.length })),
    records: [],
    conversationId: null,
    restored: null,
    restoredTrace: state.restoredTrace,
    rewind: state.rewind,
    folds: [],
    proposals: [],
    tasks: { ...state.tasks, list: [] },
    taskCards: [],
    info: state.info,
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
/** Unfolded, a task's 过程 draws its latest steps only; the earlier ones wait behind a button, drawn when asked for. */
export const STEPS_SHOWN = 100
const stepRows = new WeakMap<HTMLElement, Map<string, { item: StepItem, node: HTMLElement }>>()

function stepRow(item: StepItem) {
  return h('li', { class: 'trace-row' },
    h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
    h('div', { class: 'trace-main' },
      h('div', { class: 'row-between' }, h('span', { class: 'trace-title', text: item.title }), h('span', { class: 'trace-time', text: item.time })),
      item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))
}

function updateSteps(section: HTMLElement, state: State, task: BackgroundTask, handlers: Handlers) {
  const items = traceItems(task.view)
  const open = state.tasks.page.steps
  const toggle = section.querySelector<HTMLButtonElement>('.tp-toggle')!
  const label = t("tasks-page.activity.steps", { length: items.length, value2: open ? t("tasks-page.collapse") : t("tasks-page.expand") })
  if (toggle.textContent !== label) toggle.textContent = label
  if (toggle.getAttribute('aria-expanded') !== String(open)) toggle.setAttribute('aria-expanded', String(open))
  if (!items.length) { section.remove(); stepRows.delete(section); return }
  if (!open) { section.querySelector('.trace')?.remove(); section.querySelector('.tp-earlier')?.remove(); stepRows.delete(section); return }
  const earlier = state.tasks.page.allSteps ? 0 : Math.max(0, items.length - STEPS_SHOWN)
  let more = section.querySelector<HTMLButtonElement>('.tp-earlier')
  if (earlier && !more) {
    more = h('button', { class: 'link-btn tp-earlier', type: 'button', onClick: () => handlers.showAllTaskSteps() })
    section.querySelector('.tp-toggle')?.after(more)
  }
  if (!earlier) more?.remove()
  else if (more) {
    const label = t('tasks-page.earlier.steps', { count: earlier })
    if (more.textContent !== label) more.textContent = label
  }
  const previous = stepRows.get(section)
  const next = new Map<string, { item: StepItem, node: HTMLElement }>()
  const nodes = items.slice(earlier).map(item => {
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
  updateSteps(section, state, task, handlers)
  return section
}

function mainView(state: State, handlers: Handlers, now: number) {
  const task = pageTask(state)
  if (!task) {
    return h('div', { class: 'tp-main tp-empty' },
      h('p', { class: 'help', text: t("tasks-page.no.background.work.yet.type.a.request") }))
  }
  const live = LIVE.has(task.status)
  const thread = h('div', { class: 'thread tp-thread' })
  renderThread(thread, threadState(state, task), scopedHandlers(handlers, task), now)
  const scroll = h('div', { class: 'tp-scroll', onWheel: () => pendingScroll.delete(scroll) }, thread, stepsView(state, task, handlers))
  return h('div', { class: 'tp-main', 'data-task': task.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: `#${task.title}` }),
      h('span', { class: 'tp-status' }, statusMark(task.status), standing(task, now)),
      live
        ? h('button', { class: 'btn btn-secondary tp-act', type: 'button', text: t("island-tasks.stop"), onClick: () => handlers.stopTask(task.id) })
        : h('button', { class: 'btn btn-secondary tp-act', type: 'button', text: t("tasks-page.close.this.task"), onClick: () => handlers.closeTask(task.id) })),
    scroll)
}

const renderedPages = new WeakMap<HTMLElement, { state: State, handlers: Handlers, now: number, locale: string, side: ReturnType<typeof createTaskSidebar> }>()

function restoreScroll(scroller: HTMLElement, follow: boolean, top: number, observedTop = top) {
  const pending = pendingScroll.get(scroller)
  // Several renders may precede layout. Keep the first intended position until a real scroll changes it.
  if (!pending || Math.abs(observedTop - pending.observedTop) > 2) pendingScroll.set(scroller, { follow, top, observedTop })
  queueLayout(scroller, () => {
    const target = pendingScroll.get(scroller)
    pendingScroll.delete(scroller)
    if (!target || !scroller.isConnected || Math.abs(scroller.scrollTop - target.observedTop) > 2) return
    const next = target.follow ? scroller.scrollHeight : target.top
    return () => { scroller.scrollTop = next }
  })
}

/** Only a local disclosure changed; all other render inputs must still match. */
export function onlyTaskStepsChanged(before: State, after: State): boolean {
  const sameExcept = (a: object, b: object, except: readonly string[]) => {
    const left = Object.entries(a).filter(([key]) => !except.includes(key))
    const right = Object.entries(b).filter(([key]) => !except.includes(key))
    return left.length === right.length && left.every(([key, value]) => Reflect.get(b, key) === value)
  }
  return before.tasks.page.open && after.tasks.page.open
    && (before.tasks.page.steps !== after.tasks.page.steps || before.tasks.page.allSteps !== after.tasks.page.allSteps)
    && sameExcept(before, after, ['tasks'])
    && sameExcept(before.tasks, after.tasks, ['page'])
    && sameExcept(before.tasks.page, after.tasks.page, ['steps', 'allSteps'])
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
  const side = prior?.handlers === handlers ? prior.side : createTaskSidebar(handlers)
  const scroller = container.querySelector<HTMLElement>('.tp-scroll')
  const sameTask = container.querySelector<HTMLElement>('.tp-main')?.dataset.task === state.tasks.page.selected
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  const top = scroller?.scrollTop ?? 0
  side.update(state, now)
  const task = pageTask(state)
  const steps = container.querySelector<HTMLElement>('.tp-steps')
  const toggle = steps?.querySelector<HTMLButtonElement>('.tp-toggle')
  if (prior && !localeChanged && prior.handlers === handlers && sameTask && task && steps && toggle
    && onlyTaskStepsChanged(prior.state, shown)) {
    updateSteps(steps, state, task, handlers)
    if (scroller) restoreScroll(scroller, atBottom, top)
    renderedPages.set(container, { state: shown, handlers, now, locale: getLocale(), side })
    return
  }
  // A stream changes the task view, not its identity. Keep the thread's keyed
  // rendering cache and the live textarea (including composition) attached.
  const previousTask = prior && pageTask(onPage(prior.state))
  const main = container.querySelector<HTMLElement>('.tp-main')
  const thread = main?.querySelector<HTMLElement>('.tp-thread')
  if (prior?.handlers === handlers && sameTask && task && previousTask?.id === task.id
    && main && thread && scroller) {
    const title = main.querySelector('.tp-title')
    if (title && title.textContent !== `#${task.title}`) title.textContent = `#${task.title}`
    if (localeChanged || previousTask.status !== task.status || standing(previousTask, prior.now) !== standing(task, now)) {
      main.querySelector('.tp-status')?.replaceChildren(statusMark(task.status), standing(task, now))
    }
    if (LIVE.has(previousTask.status) !== LIVE.has(task.status)) {
      const live = LIVE.has(task.status)
      main.querySelector('.tp-act')?.replaceWith(h('button', { class: 'btn btn-secondary tp-act', type: 'button',
        text: t(live ? 'island-tasks.stop' : 'tasks-page.close.this.task'),
        onClick: () => live ? handlers.stopTask(task.id) : handlers.closeTask(task.id) }))
    } else if (localeChanged) {
      const live = LIVE.has(task.status)
      const action = main.querySelector('.tp-act')
      if (action) action.textContent = live ? t("island-tasks.stop") : t("tasks-page.close.this.task")
    }
    renderThread(thread, threadState(state, task), scopedHandlers(handlers, task), now)
    if (localeChanged || prior.state.tasks.page.steps !== state.tasks.page.steps || prior.state.tasks.page.allSteps !== state.tasks.page.allSteps
      || previousTask.view.timeline !== task.view.timeline
      || previousTask.view.thoughts !== task.view.thoughts
      || previousTask.view.tools !== task.view.tools) {
      if (steps) updateSteps(steps, state, task, handlers)
      else {
        const nextSteps = stepsView(state, task, handlers)
        if (nextSteps) scroller.append(nextSteps)
      }
    }
    restoreScroll(scroller, atBottom, top)
    renderedPages.set(container, { state: shown, handlers, now, locale: getLocale(), side })
    return
  }
  keepingInput(container, () => reconcileChildren(container, [side.el, mainView(state, handlers, now)]))
  const next = container.querySelector<HTMLElement>('.tp-scroll')
  if (next) restoreScroll(next, !sameTask || atBottom, top, 0)
  renderedPages.set(container, { state: shown, handlers, now, locale: getLocale(), side })
}
