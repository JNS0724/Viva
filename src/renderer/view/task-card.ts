import { optionName } from '../approval.ts'
import { permissionCard, promptButtons } from '../prompt-card.ts'
import { formatListTime } from '../selectors.ts'
import { h } from './dom.ts'

/**
 * One card a background task in the conversation, under the words that started it, changing in place as it
 * goes: at work (停下 / 详情 →), waiting on the user (answered right there when it can be), ended (详情 → /
 * 接着问 / ×). One quiet look for every state: the words say where it stands, and the only colour is the
 * button that answers it. 详情 → is the 后台 page, on this task (view/tasks-page.js).
 */
const SAID: Readonly<Record<string, string>> = { running: '后台在做', done: '做完了', stopped: '停下了', error: '出错了', interrupted: '已中断' }
const LIVE = new Set(['running', 'waiting'])
const MINUTE_MS = 60_000

const minutesSince = (at: number | undefined, now: number) => {
  const minutes = Math.floor((now - (at ?? now)) / MINUTE_MS)
  return minutes < 1 ? '刚开始' : `${minutes} 分钟`
}

/** Where a task stands, in a few words: its line on the 后台 page, the head of its page, its card. */
export function standing(task: BackgroundTask, now: number): string {
  if (task.status === 'waiting') return task.question ? '等你回答' : '等你确认'
  if (task.status === 'running') return [task.now, minutesSince(task.startedAt, now)].filter(Boolean).join(' · ')
  return `${SAID[task.status] ?? SAID.done} · ${formatListTime(task.endedAt ?? now, now)}`
}

/** A small grey mark before a task's name: a ring turning while it works, an open ring while it waits, how it ended. */
export const statusMark = (status: string) => h('span', { class: 'task-mark', 'data-status': status, 'aria-hidden': 'true' })

const button = (text: string, onClick: () => void, kind = 'secondary') => h('button', { class: `btn btn-${kind} task-report-open`, type: 'button', text, onClick })

/** What the card says of where a task stands, its line, and the buttons that answer it. */
type CardParts = { said: string, line: string, actions: HTMLButtonElement[] }

/** What it waits on, and the buttons that answer it here; a question with more than one choice is answered on its page. */
function waitingParts(task: BackgroundTask, handlers: Handlers): CardParts {
  if (task.permission) {
    return {
      said: '等你确认',
      line: permissionCard(task.permission).title,
      actions: promptButtons(task.permission.options).map((option) => button(optionName(option),
        () => handlers.respond(task.permission.requestId, option.optionId), option.role === 'primary' ? 'primary' : 'secondary')),
    }
  }
  const [first]: QuestionItem[] = task.question?.questions ?? []
  const single = task.question?.questions.length === 1 && !first.multiSelect
  return {
    said: '等你回答',
    line: first?.question ?? '',
    actions: single ? first.options.map((option) => button(option.label, () => handlers.pickTaskOption(task.id, first.id, option.label))) : [],
  }
}

function partsOf(task: BackgroundTask, report: TaskReport | null, handlers: Handlers, now: number): CardParts {
  if (task.status === 'interrupted') return { said: '已中断', line: '助手断开，任务尚未恢复', actions: [button('接着做', () => handlers.resumeUnfinished(task.id))] }
  if (task.status === 'waiting') return waitingParts(task, handlers)
  if (task.status === 'running') {
    const line = [task.now, `已 ${minutesSince(task.startedAt, now)}`].filter(Boolean).join(' · ')
    return { said: SAID.running, line, actions: [button('停下', () => handlers.stopTask(task.id))] }
  }
  return { said: SAID[task.status] ?? SAID.done, line: report?.preview ?? '', actions: [button('接着问', () => handlers.followUpTask(task.id))] }
}

/** @param report what it came back with, once it ended */
export function taskCard(task: BackgroundTask, report: TaskReport | null, handlers: Handlers, now: number): HTMLElement {
  const open = button('详情 →', () => handlers.openTasks(task.id))
  const parts = partsOf(task, report, handlers, now)
  const ended = !LIVE.has(task.status)
  return h('div', { class: 'task-report task-card', role: 'status', 'data-status': task.status, 'data-task': task.id },
    h('div', { class: 'task-report-main' },
      h('b', { class: 'task-report-head' }, statusMark(task.status), h('span', { class: 'task-name', text: `#${task.title}` }), h('span', { class: 'task-state', text: parts.said })),
      parts.line ? h('span', { class: 'task-report-text', text: parts.line }) : null),
    ...(ended ? [open, ...parts.actions] : [...parts.actions, open]),
    ended ? h('button', { class: 'icon-btn task-report-x', type: 'button', 'aria-label': '收起', text: '×', onClick: () => handlers.dismissReport(task.id) }) : null)
}

/**
 * The tasks with a card in the conversation now: those at work or waiting, and those that ended while what
 * they came back with is still shown (until put away), each with that report.
 */
export function cardedTasks(state: State): Array<{ task: BackgroundTask, report: TaskReport | null }> {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])])])
  return state.tasks.list.flatMap((task): Array<{ task: BackgroundTask, report: TaskReport | null }> => {
    if (!hosted.has(task.id)) return []
    if (LIVE.has(task.status) || task.status === 'interrupted') return [{ task, report: null }]
    const report = state.tasks.reports.find((entry) => entry.taskId === task.id && entry.shown)
    return report ? [{ task, report }] : []
  })
}
