import { t } from '../shared/i18n/translate.ts'
import { MAX_MESSAGE_CHARS } from '../shared/text-limits.ts'
import { parseTaskQuery } from './task-registry.ts'
import type { TaskQuery } from './task-registry.ts'

/**
 * The viva-tasks plugin's requests (plugins/tasks): queries (list, get) answered from the task registry, and the
 * agent's actions on tasks (start, stop, message), carried out by the task runtime (task-runtime.ts).
 */
export type TaskRead = (request: TaskQuery, sessionId: string) => unknown
export type TaskAction = { op: 'start', brief: string } | { op: 'stop', taskId: string } | { op: 'message', taskId: string, text: string }
export type TaskAct = (request: TaskAction, sessionId: string) => Promise<unknown>

const ACTIONS = new Set(['start', 'stop', 'message'])
const MAX_ID_CHARS = 200
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max

/** An action the model asked for, checked: what it names, and words within the app's limits. */
export function parseTaskAction(value: unknown): TaskAction {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (raw.op === 'start') {
    if (!isText(raw.brief, MAX_MESSAGE_CHARS)) throw new Error(t('main.tasks-channel.invalid.brief', { max: MAX_MESSAGE_CHARS }))
    return { op: 'start', brief: raw.brief.trim() }
  }
  if (!isText(raw.taskId, MAX_ID_CHARS)) throw new Error(t('main.task-registry.invalid.taskid'))
  if (raw.op === 'stop') return { op: 'stop', taskId: raw.taskId }
  if (raw.op === 'message' && isText(raw.text, MAX_MESSAGE_CHARS)) return { op: 'message', taskId: raw.taskId, text: raw.text.trim() }
  throw new Error(raw.op === 'message' ? t('main.tasks-channel.invalid.text', { max: MAX_MESSAGE_CHARS }) : t('main.task-registry.unknown.task.query.operation'))
}

export function createTasksDesk({ send, read, act = null, authorized }: {
  send: (message: object) => void, read: TaskRead | null, act?: TaskAct | null, authorized: (session: string) => boolean,
}) {
  const fail = (id: string, error: unknown) => send({ type: 'tasks_result', id, ok: false, text: error instanceof Error ? error.message : t('main.tasks-channel.query.failed') })

  async function answer(id: string, request: unknown, sessionId: string) {
    const isAction = Boolean(request && typeof request === 'object' && ACTIONS.has(String((request as Record<string, unknown>).op)))
    if (isAction && !act) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    if (!isAction && !read) throw new Error(t('main.tasks-channel.task.queries.are.not.enabled.in.this'))
    const result = isAction ? await act!(parseTaskAction(request), sessionId) : read!(parseTaskQuery(request), sessionId)
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
