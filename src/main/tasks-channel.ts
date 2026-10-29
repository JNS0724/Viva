import { t } from '../shared/i18n/translate.ts'
import { parseTaskQuery } from './task-registry.ts'
import type { TaskQuery } from './task-registry.ts'
export type TaskRead = (request: TaskQuery, sessionId: string) => unknown
export function createTasksDesk({ send, read, authorized }: { send: (message: object) => void, read: TaskRead | null, authorized: (session: string) => boolean }) {
  return { receive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type !== 'tasks_query' || typeof message.id !== 'string' || !message.id || message.id.length > 100) return
    try {
      if (typeof message.sessionId !== 'string' || !authorized(message.sessionId)) throw new Error(t("main.tasks-channel.session.expired.cannot.query.tasks"))
      if (!read) throw new Error(t("main.tasks-channel.task.queries.are.not.enabled.in.this"))
      const result = read(parseTaskQuery(message.request), message.sessionId)
      send({ type: 'tasks_result', id: message.id, ok: true, text: JSON.stringify(result) })
    } catch (error) {
      send({ type: 'tasks_result', id: message.id, ok: false, text: error instanceof Error ? error.message : t("main.tasks-channel.query.failed") })
    }
  } }
}
