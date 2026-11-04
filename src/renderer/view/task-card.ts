import { t } from '../../shared/i18n/translate.ts'
import { permissionCard } from '../prompt-card.ts'
import { formatListTime } from '../selectors.ts'
import { taskPreview } from '../tasks-state.ts'
import { h } from './dom.ts'

/**
 * A background task, said the same way everywhere (its line in the conversation, the island, the 后台 page):
 * 在后台, 等你处理, 做完了, 出错了, 停下了, 已中断. It is answered in one place, the 后台 page; the conversation
 * keeps one quiet line per task, under the words that started it, which leads to its page (view/tasks-page.ts).
 */
export const taskStatusNames = (): Readonly<Record<string, string>> => ({
  running: t("island-tasks.in.background"), waiting: t("task.status.waiting"), done: t("island-view.done"), stopped: t("island-view.stopped.2"), error: t("island-view.something.went.wrong"), interrupted: t("task-card.interrupted"),
})
const LIVE = new Set(['running', 'waiting'])
const MINUTE_MS = 60_000

const minutesSince = (at: number | undefined, now: number) => {
  const minutes = Math.floor((now - (at ?? now)) / MINUTE_MS)
  return minutes < 1 ? t("island-tasks.just.started") : t("island-tasks.minutes", { minutes: minutes })
}

/** Where a task stands, in a few words: its line on the 后台 page, the head of its page. */
export function standing(task: BackgroundTask, now: number): string {
  if (task.status === 'waiting') return taskStatusNames().waiting
  if (task.status === 'running') return [task.now, minutesSince(task.startedAt, now)].filter(Boolean).join(' · ')
  return `${taskStatusNames()[task.status] ?? taskStatusNames().done} · ${formatListTime(task.endedAt ?? now, now)}`
}

/** A small grey mark before a task's name: a ring turning while it works, an open ring while it waits, how it ended. */
export const statusMark = (status: string) => h('span', { class: 'task-mark', 'data-status': status, 'aria-hidden': 'true' })

/** What a task's line says of where it stands, and one line of it. */
type CardParts = { said: string, line: string }

/** What it waits on: the approval asked for, or the first question. */
function waitingLine(task: BackgroundTask): string {
  if (task.permission) return t("task.confirm.action", { p0: permissionCard(task.permission).title })
  return task.question?.questions[0]?.question ?? ''
}

function partsOf(task: BackgroundTask, now: number): CardParts {
  if (task.status === 'interrupted') return { said: taskStatusNames().interrupted, line: t("task-card.assistant.disconnected.task.has.not.resumed") }
  if (task.status === 'waiting') return { said: taskStatusNames().waiting, line: waitingLine(task) }
  if (task.status === 'running') {
    return { said: taskStatusNames().running, line: [task.now, t("task-card.elapsed", { value1: minutesSince(task.startedAt, now) })].filter(Boolean).join(' · ') }
  }
  return { said: taskStatusNames()[task.status] ?? taskStatusNames().done, line: task.endedAt === null ? '' : taskPreview(task.view) }
}

/** Where the line in the conversation leads: to answer it, to see how it goes, to read what it came back with. */
const leads = () => ({ waiting: t('task.take.action'), interrupted: t('task.take.action'), running: t('task.take.look') } as Record<string, string>)

/** The conversation's line shows status, not the task's streaming answer. Keep its node while those words agree. */
export function taskCardInputs(task: BackgroundTask, now: number): readonly unknown[] {
  return [task.id, task.title, task.status,
    task.status === 'running' ? task.now : null,
    task.status === 'running' ? minutesSince(task.startedAt, now) : null,
    task.status === 'waiting' ? task.permission : null,
    task.status === 'waiting' ? task.question : null,
    LIVE.has(task.status) ? null : taskPreview(task.view)]
}

/**
 * A task's line in the conversation, under the words that started it, changing in place as it goes: where it
 * stands and one line of it. No buttons of its own: a click opens its page, where it is answered, followed up
 * or closed. Waiting on the user, it stands out, and leads to the page where it is answered.
 */
export function taskCard(task: BackgroundTask, handlers: Handlers, now: number): HTMLElement {
  const parts = partsOf(task, now)
  return h('button', {
    class: 'task-line task-card', type: 'button', 'data-status': task.status, 'data-task': task.id,
    title: t("task.open.background"), onClick: () => handlers.openTasks(task.id),
  },
  statusMark(task.status),
  h('span', { class: 'task-name', text: `#${task.title}` }),
  h('span', { class: 'task-state', text: parts.said }),
  parts.line ? h('span', { class: 'task-line-text', text: parts.line }) : null,
  h('span', { class: 'task-line-go', text: leads()[task.status] ?? t("task.view.result") }))
}

/** Ended tasks restored from the last launch, put back under the message they hung from. */
export function restoredTaskAnchors(state: State): Array<{ taskId: string, at: number }> {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])])])
  return state.tasks.list.filter(task => task.host?.conversationId === String(state.conversationId)
    && Number.isSafeInteger(task.host.at) && task.host.at >= 0 && !hosted.has(task.id))
    .toSorted((a, b) => a.host!.order - b.host!.order)
    .map(task => ({ taskId: task.id, at: Math.min(task.host!.at, state.messages.length) }))
}

/** The tasks with a line in the conversation on screen. */
export function cardedTasks(state: State): BackgroundTask[] {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])]),
    ...restoredTaskAnchors(state).map(anchor => anchor.taskId)])
  return state.tasks.list.filter((task) => hosted.has(task.id))
}
