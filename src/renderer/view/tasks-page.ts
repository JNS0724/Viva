import { traceItems } from '../selectors.ts'
import { pageGroups, pageTask } from '../tasks-state.ts'
import { h, keepingInput } from './dom.ts'
import { icon } from './icons.ts'
import { standing, statusMark } from './task-card.ts'
import { renderThread } from './thread.ts'

/**
 * The 后台 page: every background task on the left, grouped by where it stands; on the right the one picked,
 * its whole conversation as the thread shows one, its steps folded under it, and its own input: words into
 * its turn while it works, its next question once it has ended. Same place as 搜索 · 关于你 · 设置.
 */
const GROUP_NAMES = { waiting: '等你确认', running: '在做', ended: '做完了' }
const LIVE = new Set(['running', 'waiting'])

function sideView(state, handlers, now) {
  const selected = state.tasks.page.selected
  return h('nav', { class: 'hub-side tp-side', 'aria-label': '后台任务' },
    h('button', { class: 'hub-back', type: 'button', onClick: () => handlers.closeHub() },
      icon('back', 16), '返回', h('kbd', { text: 'Esc' })),
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
function threadState(state, task) {
  return {
    ...state,
    ...task.view,
    messages: task.view.messages.map((message) => ({ ...message, shown: message.text.length })),
    conversationId: null,
    restored: null,
    folds: [],
    tasks: { ...state.tasks, list: [], reports: [], unfinished: [] },
  }
}

/** Its question is answered from here for the task, not for the conversation on screen. */
const scopedHandlers = (handlers, task) => ({
  ...handlers,
  pickOption: (id, label) => handlers.pickTaskOption(task.id, id, label),
  submitAnswer: () => handlers.submitTaskAnswer(task.id),
  skipQuestion: () => handlers.skipTaskQuestion(task.id),
})

function stepsView(state, task, handlers) {
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

function inputView(task, handlers) {
  const live = LIVE.has(task.status)
  const field = h('textarea', {
    class: 'tp-input', name: `task-input-${task.id}`, rows: 2, 'aria-label': live ? '插话' : '接着问',
    placeholder: live ? '插话：补充或修改要求…　Enter 发送' : '接着问…　Enter 发送',
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
  return h('form', { class: 'tp-composer', onSubmit: (event) => { event.preventDefault(); send() } },
    field,
    h('button', { class: 'send-btn', type: 'submit', 'aria-label': live ? '插话' : '接着问' }, icon('send', 20)))
}

function mainView(state, handlers, now) {
  const task = pageTask(state)
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
export function renderTasksPage(container, state, handlers, now = Date.now()) {
  container.dataset.open = String(state.tasks.page.open)
  if (!state.tasks.page.open) {
    container.replaceChildren()
    return
  }
  const scroller = container.querySelector('.tp-scroll')
  const sameTask = container.querySelector('.tp-main')?.dataset.task === state.tasks.page.selected
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  const top = scroller?.scrollTop ?? 0
  keepingInput(container, () => container.replaceChildren(sideView(state, handlers, now), mainView(state, handlers, now)))
  const next = container.querySelector('.tp-scroll')
  if (next) next.scrollTop = sameTask && !atBottom ? top : next.scrollHeight
}
