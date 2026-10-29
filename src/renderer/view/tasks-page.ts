import { traceItems } from '../selectors.ts'
import { FOLLOWUP_KEY, pageGroups, pageTask, shownOnPage, SUGGESTION_KEY } from '../tasks-state.ts'
import { h, keepingInput } from './dom.ts'
import { icon } from './icons.ts'
import { standing, statusMark } from './task-card.ts'
import { renderThread } from './thread.ts'
import { followupDetail, followupStanding, suggestionDetail, whenText } from './followups.ts'
import { MAX_MESSAGE_CHARS, MESSAGE_TOO_LONG } from '../../shared/text-limits.ts'

/**
 * The 后台 page: every background task on the left, grouped by where it stands, with the follow-ups among them
 * (待你看的 first: drafts prepared in the background; then what is being prepared, then what is scheduled); on
 * the right the one picked, its whole conversation as the thread shows one, its steps folded under it, and its
 * own input: words into its turn while it works, its next question once it has ended. A follow-up shows its
 * draft and what can be done with it. One of the hub's pages, beside 回顾 · 关于你 · 设置.
 */
const GROUP_NAMES: Readonly<Record<string, string>> = { waiting: '等你处理', running: '在后台', ended: '做完了' }
const LIVE = new Set(['running', 'waiting'])
export { FOLLOWUP_KEY, SUGGESTION_KEY }
const FOLLOWUP_GROUPS: ReadonlyArray<[string, string]> = [['ready', '待你看的'], ['preparing', '在准备'], ['scheduled', '已安排']]

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
    h('div', { class: 'tp-group', text: `要我跟进吗 · ${open.length}` }),
    ...open.map((suggestion) => h('button', {
      class: 'tp-row fu-row', type: 'button', 'data-status': 'suggested', 'aria-current': `${SUGGESTION_KEY}${suggestion.id}` === selected ? 'page' : null,
      onClick: () => handlers.selectTask(`${SUGGESTION_KEY}${suggestion.id}`),
    },
    h('span', { class: 'tp-name', text: suggestion.title }),
    h('span', { class: 'tp-meta', text: `${suggestion.sender || '消息'} · ${suggestion.why}` }))),
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
  if (prepare?.running) return h('p', { class: 'fu-state', 'data-on': 'true', text: `后台准备中 · ${prepare.current}` })
  if (prepare?.waiting) return h('p', { class: 'fu-state', text: `等一会儿再准备：${prepare.waiting}` })
  if (prepare?.nextAt) return h('p', { class: 'fu-state', text: `下次后台准备 ${whenText(prepare.nextAt, now)}` })
  return null
}

/**
 * Folded by the user: a narrow strip where the list was, » to unfold it, and how many wait on the user so none
 * is missed while it is folded.
 */
function foldedSide(state: State, handlers: Handlers) {
  const waiting = state.tasks.list.filter((task) => task.status === 'waiting').length
  return h('nav', { class: 'tp-side tp-side-folded', 'aria-label': '后台任务' },
    h('button', {
      class: 'icon-btn tp-fold', type: 'button', title: '展开后台任务', 'aria-label': '展开后台任务', 'aria-expanded': 'false',
      onClick: () => handlers.foldTaskList(false),
    }, h('span', { text: '»', 'aria-hidden': 'true' })),
    waiting ? h('span', { class: 'tp-count', title: `${waiting} 件等你处理`, text: String(waiting) }) : null)
}

/**
 * The list beside the hub's own sidebar (返回 and the other pages stay there, as on every page of the hub), « at
 * its head to fold it to a strip; the user's choice, kept, for the list is not looked at often.
 */
function sideView(state: State, handlers: Handlers, now: number) {
  if (state.tasks.listFolded) return foldedSide(state, handlers)
  const selected = state.tasks.page.selected
  return h('nav', { class: 'tp-side', 'aria-label': '后台任务' },
    h('div', { class: 'tp-side-head' },
      h('span', { class: 'tp-side-title', text: '后台任务' }),
      h('button', {
        class: 'icon-btn tp-fold', type: 'button', title: '收起列表', 'aria-label': '收起列表', 'aria-expanded': 'true',
        onClick: () => handlers.foldTaskList(true),
      }, h('span', { text: '«', 'aria-hidden': 'true' }))),
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
  return h('section', { class: 'tp-steps', 'aria-label': '过程' },
    h('button', { class: 'tp-toggle', type: 'button', 'aria-expanded': String(open), onClick: () => handlers.toggleTaskSteps() },
      `过程 · ${items.length} 步　${open ? '收起 ▴' : '展开 ▾'}`),
    open
      ? h('ol', { class: 'trace' }, items.map((item) => h('li', { class: 'trace-row' },
        h('span', { class: 'trace-rail' }, h('span', { class: 'dot', 'data-tone': item.tone }), h('span', { class: 'line' })),
        h('div', { class: 'trace-main' },
          h('div', { class: 'row-between' }, h('span', { class: 'trace-title', text: item.title }), h('span', { class: 'trace-time', text: item.time })),
          item.detail ? h('div', { class: 'trace-detail', text: item.detail }) : null))))
      : null)
}

function inputView(task: BackgroundTask, handlers: Handlers) {
  if (task.status === 'interrupted') return h('button', { class: 'btn btn-secondary', type: 'button', text: '接着做', onClick: () => handlers.resumeUnfinished(task.id) })
  const live = LIVE.has(task.status)
  const field = h('textarea', {
    class: 'tp-input', name: `task-input-${task.id}`, rows: 2, 'aria-label': live ? '插话' : '接着问',
    placeholder: live ? '插话：补充或修改要求…　Enter 发送' : '接着问…　Enter 发送',
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
      handlers.inputProblem('这次没能送出，请重试。')
    })
  }
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    send()
  })
  return h('form', { class: 'tp-composer', onSubmit: (event: SubmitEvent) => { event.preventDefault(); send() } },
    field,
    h('button', { class: 'send-btn', type: 'submit', 'aria-label': live ? '插话' : '接着问' }, icon('send', 20)))
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
      h('p', { class: 'help', text: '后台还没有事。在输入框里写好，点「后台做」交给后台；它做完会告诉你。' }))
  }
  const live = LIVE.has(task.status)
  const thread = h('div', { class: 'thread tp-thread' })
  renderThread(thread, threadState(state, task), scopedHandlers(handlers, task), now)
  return h('div', { class: 'tp-main', 'data-task': task.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: `#${task.title}` }),
      h('span', { class: 'tp-status' }, statusMark(task.status), standing(task, now)),
      live
        ? h('button', { class: 'btn btn-secondary tp-act', type: 'button', text: '停下', onClick: () => handlers.stopTask(task.id) })
        : h('button', { class: 'btn btn-secondary tp-act', type: 'button', text: '关掉这件', onClick: () => handlers.closeTask(task.id) })),
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
