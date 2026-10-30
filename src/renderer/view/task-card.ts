import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { optionName } from '../approval.ts'
import { permissionCard, promptButtons } from '../prompt-card.ts'
import { formatListTime } from '../selectors.ts'
import { h } from './dom.ts'

/**
 * A background task, said the same way everywhere (its line in the conversation, its row in the dock, the 后台
 * page): 在后台, 等你处理, 做完了, 出错了, 停下了, 已中断. It is answered in one place, the dock (or, the
 * dock not shown, the 后台 page); the conversation keeps one quiet line per task, under the words that started
 * it, which leads to its page (view/tasks-page.ts).
 */
export let SAID: Readonly<Record<string, string>> = {
  running: t("island-tasks.in.background"), waiting: t("merge.needs.your.attention.74"), done: t("island-view.done"), stopped: t("island-view.stopped.2"), error: t("island-view.something.went.wrong"), interrupted: t("task-card.interrupted"),
}
const LIVE = new Set(['running', 'waiting'])
const MINUTE_MS = 60_000

const minutesSince = (at: number | undefined, now: number) => {
  const minutes = Math.floor((now - (at ?? now)) / MINUTE_MS)
  return minutes < 1 ? t("island-tasks.just.started") : t("island-tasks.minutes", { minutes: minutes })
}

/** Where a task stands, in a few words: its line on the 后台 page, the head of its page. */
export function standing(task: BackgroundTask, now: number): string {
  if (task.status === 'waiting') return SAID.waiting
  if (task.status === 'running') return [task.now, minutesSince(task.startedAt, now)].filter(Boolean).join(' · ')
  return `${SAID[task.status] ?? SAID.done} · ${formatListTime(task.endedAt ?? now, now)}`
}

/** A small grey mark before a task's name: a ring turning while it works, an open ring while it waits, how it ended. */
export const statusMark = (status: string) => h('span', { class: 'task-mark', 'data-status': status, 'aria-hidden': 'true' })

const button = (text: string, onClick: () => void, kind = 'secondary') => h('button', { class: `btn btn-${kind} task-report-open`, type: 'button', text, onClick })

/** What a task's row says of where it stands, its line, and the buttons that answer it. */
type CardParts = { said: string, line: string, actions: HTMLButtonElement[] }

/** What it waits on, and the buttons that answer it here; a question with more than one choice is answered on its page. */
function waitingParts(task: BackgroundTask, handlers: Handlers): CardParts {
  if (task.permission) {
    return {
      said: SAID.waiting,
      line: t("merge.confirm.75", { p0: permissionCard(task.permission).title }),
      actions: promptButtons(task.permission.options).map((option) => button(optionName(option),
        () => handlers.respond(task.permission.requestId, option.optionId), option.role === 'primary' ? 'primary' : 'secondary')),
    }
  }
  const [first]: QuestionItem[] = task.question?.questions ?? []
  const single = task.question?.questions.length === 1 && !first.multiSelect
  return {
    said: SAID.waiting,
    line: first?.question ?? '',
    actions: single ? first.options.map((option) => button(option.label, () => handlers.pickTaskOption(task.id, first.id, option.label))) : [],
  }
}

function partsOf(task: BackgroundTask, report: TaskReport | null, handlers: Handlers, now: number): CardParts {
  if (task.status === 'interrupted') return { said: SAID.interrupted, line: t("task-card.assistant.disconnected.task.has.not.resumed"), actions: [button(t("followups.continue"), () => handlers.resumeUnfinished(task.id))] }
  if (task.status === 'waiting') return waitingParts(task, handlers)
  if (task.status === 'running') {
    const line = [task.now, t("task-card.elapsed", { value1: minutesSince(task.startedAt, now) })].filter(Boolean).join(' · ')
    return { said: SAID.running, line, actions: [button(t("island-tasks.stop"), () => handlers.stopTask(task.id))] }
  }
  return { said: SAID[task.status] ?? SAID.done, line: report?.preview ?? '', actions: [button(t("task-card.ask.more"), () => handlers.followUpTask(task.id))] }
}

/** Where the line in the conversation leads: to answer it, to see how it goes, to read what it came back with. */
const leads = () => ({ waiting: t('merge.handle'), interrupted: t('merge.handle'), running: t('merge.look') } as Record<string, string>)

/**
 * A task's line in the conversation, under the words that started it, changing in place as it goes: where it
 * stands and one line of it. No buttons of its own: a click opens its page, where it is answered, followed up
 * or closed. Waiting on the user, it stands out (the dock, or its tag, has the buttons).
 * @param report what it came back with, once it ended
 */
export function taskCard(task: BackgroundTask, report: TaskReport | null, handlers: Handlers, now: number): HTMLElement {
  const parts = partsOf(task, report, handlers, now)
  return h('button', {
    class: 'task-line task-card', type: 'button', 'data-status': task.status, 'data-task': task.id,
    title: t("merge.open.in.background.76"), onClick: () => handlers.openTasks(task.id),
  },
  statusMark(task.status),
  h('span', { class: 'task-name', text: `#${task.title}` }),
  h('span', { class: 'task-state', text: parts.said }),
  parts.line ? h('span', { class: 'task-line-text', text: parts.line }) : null,
  h('span', { class: 'task-line-go', text: leads()[task.status] ?? t("merge.view.result.77") }))
}

/**
 * The same task in the dock (view/task-dock.ts), where it is answered: its name and where it stands over the
 * line and the buttons that answer it, stacked to fit a narrow panel. Ended, it leaves the dock once seen (opened
 * on the 后台 page, by 详情 or 接着问 or anywhere else; the page covers the dock meanwhile, so it is gone by the time
 * the user is back) or put away unseen by 知道了; its line in the conversation stays as the history.
 */
export function taskTile(task: BackgroundTask, report: TaskReport | null, handlers: Handlers, now: number): HTMLElement {
  const parts = partsOf(task, report, handlers, now)
  const ended = !LIVE.has(task.status) && task.status !== 'interrupted'
  const open = h('button', { class: 'btn btn-text dock-open', type: 'button', text: t("merge.details.78"), onClick: () => handlers.openTasks(task.id) })
  const seen = ended ? h('button', { class: 'btn btn-text dock-seen', type: 'button', text: t("island-dom.got.it"), onClick: () => handlers.hideFromDock(task.id) }) : null
  return h('div', { class: 'dock-tile', role: 'status', 'data-status': task.status, 'data-task': task.id },
    h('div', { class: 'dock-tile-head' }, statusMark(task.status), h('span', { class: 'task-name', text: `#${task.title}` })),
    h('span', { class: 'dock-tile-said', text: [parts.said, task.status === 'running' ? null : parts.line].filter(Boolean).join('：') }),
    task.status === 'running' && parts.line ? h('span', { class: 'dock-tile-line', text: parts.line }) : null,
    h('div', { class: 'dock-tile-acts' }, ...parts.actions, open, seen))
}

/**
 * The tasks with a line in the conversation now: those at work or waiting, and those that ended while what
 * they came back with is still shown, each with that report.
 */
export function restoredTaskAnchors(state: State): Array<{ taskId: string, at: number }> {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])])])
  return state.tasks.list.filter(task => task.host?.conversationId === String(state.conversationId)
    && Number.isSafeInteger(task.host.at) && task.host.at >= 0 && !hosted.has(task.id))
    .toSorted((a, b) => a.host!.order - b.host!.order)
    .map(task => ({ taskId: task.id, at: Math.min(task.host!.at, state.messages.length) }))
}

export function cardedTasks(state: State): Array<{ task: BackgroundTask, report: TaskReport | null }> {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])]),
    ...restoredTaskAnchors(state).map(anchor => anchor.taskId)])
  return state.tasks.list.flatMap((task): Array<{ task: BackgroundTask, report: TaskReport | null }> => {
    if (!hosted.has(task.id)) return []
    if (LIVE.has(task.status) || task.status === 'interrupted') return [{ task, report: null }]
    const report = state.tasks.reports.find((entry) => entry.taskId === task.id && entry.shown)
    return report ? [{ task, report }] : []
  })
}

onLocaleChange(() => {
  SAID = { waiting: t("merge.waiting"), running: t("island-tasks.in.background"), done: t("island-view.done"), stopped: t("island-view.stopped.2"), error: t("island-view.something.went.wrong"), interrupted: t("task-card.interrupted") }
})
