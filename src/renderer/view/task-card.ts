import { t } from '../../shared/i18n/translate.ts'
import { objectOf } from '../../shared/unknown-value.ts'
import { optionName } from '../approval.ts'
import { permissionCard, promptButtons } from '../prompt-card.ts'
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
const leads = () => ({ waiting: t('task.take.action'), interrupted: t('task.take.look'), running: t('task.take.look') } as Record<string, string>)

/** The conversation's line shows status, not the task's streaming answer. Keep its node while those words agree. */
export function taskCardInputs(task: BackgroundTask, now: number): readonly unknown[] {
  return [task.id, task.title, task.status,
    task.status === 'running' ? task.now : null,
    task.status === 'running' ? minutesSince(task.startedAt, now) : null,
    task.status === 'waiting' ? task.permission : null,
    task.status === 'waiting' ? task.question : null,
    LIVE.has(task.status) ? null : taskPreview(task.view)]
}

/** Quick actions rendered beneath the task line when a single click can resolve it without switching pages. */
function inlineActions(task: BackgroundTask, handlers: Handlers): HTMLElement | null {
  if (task.status === 'waiting') {
    const permission = task.permission
    if (permission && Array.isArray(permission.options) && permission.options.length > 0) {
      const rawInput = objectOf(permission.rawInput)
      const { title, detail, command } = permissionCard(permission)
      const reason = rawInput?.description && typeof rawInput.description === 'string'
        ? h('p', { class: 'confirm-reason task-inline-meta', text: t('handoff.approval.reason', { reason: rawInput.description }) }) : null
      const scope = command ? h('p', { class: 'confirm-hint task-inline-meta', text: t('handoff.approval.command.scope') }) : null
      const params = detail
        ? h('pre', { class: 'confirm-detail task-inline-detail', text: detail })
        : h('p', { class: 'task-inline-meta', text: title })
      return h('div', { class: 'task-inline', 'data-task': task.id, 'data-kind': 'permission' },
        h('div', { class: 'task-inline-info' }, reason, scope, params),
        h('div', { class: 'task-inline-actions' },
          promptButtons(permission.options).map((option) => h('button', {
            class: option.role === 'primary' ? 'btn btn-primary task-inline-btn' : 'btn btn-secondary task-inline-btn',
            type: 'button',
            text: optionName(option),
            onClick: () => handlers.respond(permission.requestId, option.optionId),
          }))))
    }
    const questions = task.question?.questions
    const first = Array.isArray(questions) && questions.length === 1 ? questions[0] : null
    if (first && !first.multiSelect && Array.isArray(first.options) && first.options.length > 0) {
      return h('div', { class: 'task-inline', 'data-task': task.id, 'data-kind': 'question' },
        first.question ? h('div', { class: 'task-inline-info' }, h('p', { class: 'task-inline-question', text: first.question })) : null,
        h('div', { class: 'task-inline-actions' },
          first.options.map((option: { label: string, description?: string }) => h('button', {
            class: 'btn btn-secondary task-inline-btn',
            type: 'button',
            title: option.description ?? null,
            text: option.label,
            onClick: () => handlers.pickTaskOption(task.id, first.id, option.label),
          })),
          h('button', {
            class: 'btn btn-text task-inline-btn',
            type: 'button',
            text: t('island-dom.skip'),
            onClick: () => handlers.skipTaskQuestion(task.id),
          })))
    }
    return null
  }
  if (task.status === 'interrupted') {
    return h('div', { class: 'task-inline', 'data-task': task.id, 'data-kind': 'interrupted' },
      h('div', { class: 'task-inline-actions' },
        h('button', {
          class: 'btn btn-primary task-inline-btn',
          type: 'button',
          text: t('task-card.resume'),
          onClick: () => handlers.resumeTask(task.id),
        }),
        h('button', {
          class: 'btn btn-secondary task-inline-btn',
          type: 'button',
          text: t('task-card.close'),
          onClick: () => handlers.closeTask(task.id),
        })))
  }
  return null
}

/**
 * A task's line in the conversation, under the words that started it, changing in place as it goes: where it
 * stands and one line of it. Clicking the line opens its page; waiting approvals, single-choice questions, and
 * interrupted tasks also offer an inline action strip right underneath so one click settles them in place.
 */
export function taskCard(task: BackgroundTask, handlers: Handlers, now: number): View {
  const parts = partsOf(task, now)
  const line = h('button', {
    class: 'task-line task-card', type: 'button', 'data-status': task.status, 'data-task': task.id,
    title: t("task.open.background"), onClick: () => handlers.openTasks(task.id),
  },
  statusMark(task.status),
  h('span', { class: 'task-name', text: `#${task.title}` }),
  h('span', { class: 'task-state', text: parts.said }),
  parts.line ? h('span', { class: 'task-line-text', text: parts.line }) : null,
  h('span', { class: 'task-line-go', text: leads()[task.status] ?? t("task.view.result") }))
  const actions = inlineActions(task, handlers)
  return actions ? [line, actions] : line
}

/** Ended tasks restored from the last launch, put back under the message they hung from. */
export function restoredTaskAnchors(state: Pick<State, 'taskCards' | 'messages' | 'tasks' | 'conversationId'> & { historyOffset?: number }): Array<{ taskId: string, at: number }> {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])])])
  const total = (state.historyOffset ?? 0) + state.messages.length
  return state.tasks.list.filter(task => task.host?.conversationId === String(state.conversationId)
    && Number.isSafeInteger(task.host.at) && task.host.at >= 0 && !hosted.has(task.id))
    .toSorted((a, b) => a.host!.order - b.host!.order)
    .map(task => ({ taskId: task.id, at: Math.min(task.host!.at, total) }))
}

/** The tasks with a line in the conversation on screen. */
export function cardedTasks(state: Pick<State, 'taskCards' | 'messages' | 'tasks' | 'conversationId'>): BackgroundTask[] {
  const hosted = new Set([...state.taskCards, ...state.messages.flatMap(message => [message.taskId, ...(message.cardsAfter ?? [])]),
    ...restoredTaskAnchors(state).map(anchor => anchor.taskId)])
  return state.tasks.list.filter((task) => hosted.has(task.id))
}
