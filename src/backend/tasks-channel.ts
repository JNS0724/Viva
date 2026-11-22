import { t } from '../shared/i18n/translate.ts'
import { MAX_MESSAGE_CHARS } from '../shared/text-limits.ts'
import { parseTaskQuery } from './task-registry.ts'
import type { TaskQuery, TaskRegistry } from './task-registry.ts'

/**
 * The viva-tasks plugin's requests (plugins/tasks): queries (list, get) answered from the task registry, and the
 * agent's changes to schedules. Tasks themselves are started, stopped and messaged only by an accepted routing
 * decision (request-runtime.ts).
 */
export type TaskReadResult = ReturnType<TaskRegistry['query']>
export type TaskRead = (request: TaskQuery, sessionId: string) => TaskReadResult | Promise<TaskReadResult>
/**
 * What the model asks of schedules (schedule-store.ts), by talking (system-design §12.2): one proposed (the user says
 * yes on its card), the list, one changed, paused or resumed, one deleted. The rule is dsh-schedule's input, checked
 * by dsh when it is used.
 */
export type ScheduleAction =
  | { op: 'schedule_create', title: string, prompt: string, rule: Record<string, unknown> }
  | { op: 'schedule_list' }
  | { op: 'schedule_update', id: string, title?: string, prompt?: string, rule?: Record<string, unknown>, paused?: boolean }
  | { op: 'schedule_delete', id: string }
export type AnswerTaskAction = {
  op: 'answer_background_task'
  taskId: string
  questionId: string
  answers: Array<{ id: string, selected: string[], custom?: string }>
}
export type TaskChannelAction = ScheduleAction | AnswerTaskAction
export type TaskAct = (request: TaskChannelAction, sessionId: string) => Promise<unknown>

const ACTIONS = new Set(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'answer_background_task'])
const MAX_TITLE_CHARS = 120
const RULE_KINDS = new Set(['at', 'daily', 'weekly', 'cron'])
const MAX_ID_CHARS = 200
const MAX_ANSWER_ITEMS = 6
const MAX_ANSWER_SELECTED = 8
const MAX_ANSWER_LABEL_CHARS = 200
const MAX_ANSWER_CUSTOM_CHARS = 2000
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max

/** An action the model asked for, checked: what it names, and words within the app's limits. */
/** A schedule's rule as the model gives it: one of dsh's kinds with its input, nothing else. */
function ruleOf(value: unknown): Record<string, unknown> {
  const rule = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (!RULE_KINDS.has(String(rule.kind)) || rule[String(rule.kind)] === undefined) throw new Error(t('main.tasks-channel.invalid.schedule.rule'))
  return { kind: rule.kind, [String(rule.kind)]: rule[String(rule.kind)] }
}

/**
 * A schedule's name, what it does and its rule, checked: as the model proposes one, and as the user changed it on the
 * proposal's card before saying yes (schedules.ts accept).
 */
export function parseScheduleWords(value: unknown): { title: string, prompt: string, rule: Record<string, unknown> } {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (!isText(raw.title, MAX_TITLE_CHARS) || !isText(raw.prompt, MAX_MESSAGE_CHARS)) throw new Error(t('main.tasks-channel.invalid.schedule'))
  return { title: raw.title.trim(), prompt: raw.prompt.trim(), rule: ruleOf(raw.rule) }
}

function parseScheduleAction(raw: Record<string, unknown>): ScheduleAction {
  if (raw.op === 'schedule_list') return { op: 'schedule_list' }
  if (raw.op === 'schedule_create') return { op: 'schedule_create', ...parseScheduleWords(raw) }
  if (!isText(raw.id, MAX_ID_CHARS)) throw new Error(t('main.tasks-channel.invalid.schedule'))
  if (raw.op === 'schedule_delete') return { op: 'schedule_delete', id: raw.id }
  const changes = {
    ...(raw.title === undefined ? {} : isText(raw.title, MAX_TITLE_CHARS) ? { title: raw.title.trim() } : (() => { throw new Error(t('main.tasks-channel.invalid.schedule')) })()),
    ...(raw.prompt === undefined ? {} : isText(raw.prompt, MAX_MESSAGE_CHARS) ? { prompt: raw.prompt.trim() } : (() => { throw new Error(t('main.tasks-channel.invalid.schedule')) })()),
    ...(raw.rule === undefined ? {} : { rule: ruleOf(raw.rule) }),
    ...(typeof raw.paused === 'boolean' ? { paused: raw.paused } : {}),
  }
  return { op: 'schedule_update', id: raw.id, ...changes }
}

function parseAnswerTaskAction(raw: Record<string, unknown>): AnswerTaskAction {
  if (!isText(raw.taskId, MAX_ID_CHARS) || !isText(raw.questionId, MAX_ID_CHARS) || !Array.isArray(raw.answers) || raw.answers.length === 0 || raw.answers.length > MAX_ANSWER_ITEMS) {
    throw new Error(t('main.tasks-channel.invalid.answer'))
  }
  const answers = raw.answers.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error(t('main.tasks-channel.invalid.answer'))
    const item = entry as Record<string, unknown>
    if (!isText(item.id, MAX_ID_CHARS) || !Array.isArray(item.selected) || item.selected.length > MAX_ANSWER_SELECTED) {
      throw new Error(t('main.tasks-channel.invalid.answer'))
    }
    const selected: string[] = []
    for (const label of item.selected) {
      if (!isText(label, MAX_ANSWER_LABEL_CHARS)) throw new Error(t('main.tasks-channel.invalid.answer'))
      selected.push(label)
    }
    if (item.custom !== undefined && (typeof item.custom !== 'string' || item.custom.length > MAX_ANSWER_CUSTOM_CHARS)) {
      throw new Error(t('main.tasks-channel.invalid.answer'))
    }
    const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom.trim() : undefined
    return { id: item.id.trim(), selected, ...(custom ? { custom } : {}) }
  })
  return { op: 'answer_background_task', taskId: raw.taskId.trim(), questionId: raw.questionId.trim(), answers }
}

export function parseTaskAction(value: unknown): TaskChannelAction {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (raw.op === 'answer_background_task') return parseAnswerTaskAction(raw)
  if (typeof raw.op === 'string' && raw.op.startsWith('schedule_')) return parseScheduleAction(raw)
  throw new Error(t('main.task-registry.unknown.task.query.operation'))
}

export function createTasksDesk({ send, read, act = null, authorized }: {
  send: (message: object) => void, read: TaskRead | null, act?: TaskAct | null, authorized: (session: string) => boolean,
}) {
  const fail = (id: string, error: unknown) => send({ type: 'tasks_result', id, ok: false, text: error instanceof Error ? error.message : t('main.tasks-channel.query.failed') })

  async function answer(id: string, request: unknown, sessionId: string) {
    const isAction = Boolean(request && typeof request === 'object' && ACTIONS.has(String((request as Record<string, unknown>).op)))
    if (isAction && !act) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    if (!isAction && !read) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    const result = isAction ? await act!(parseTaskAction(request), sessionId) : await read!(parseTaskQuery(request), sessionId)
    if (!authorized(sessionId)) throw new Error(t('main.tasks-channel.session.expired.cannot.query.tasks'))
    send({ type: 'tasks_result', id, ok: true, text: JSON.stringify(result) })
  }

  return { receive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type !== 'tasks_query' || typeof message.id !== 'string' || !message.id || message.id.length > 100) return
    const id = message.id
    if (typeof message.sessionId !== 'string' || !authorized(message.sessionId)) return fail(id, new Error(t('main.tasks-channel.session.expired.cannot.query.tasks')))
    answer(id, message.request, message.sessionId).catch((error) => fail(id, error))
  } }
}
