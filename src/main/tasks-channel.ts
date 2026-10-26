import { parseTaskQuery } from './task-registry.ts'
import type { TaskQuery } from './task-registry.ts'
export type TaskRead = (request: TaskQuery, sessionId: string) => unknown
export function createTasksDesk({ send, read, authorized }: { send: (message: object) => void, read: TaskRead | null, authorized: (session: string) => boolean }) {
  return { receive(raw: unknown) {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type !== 'tasks_query' || typeof message.id !== 'string' || !message.id || message.id.length > 100) return
    try {
      if (typeof message.sessionId !== 'string' || !authorized(message.sessionId)) throw new Error('会话已失效，无法查询任务')
      if (!read) throw new Error('当前应用未启用任务查询')
      const result = read(parseTaskQuery(message.request), message.sessionId)
      send({ type: 'tasks_result', id: message.id, ok: true, text: JSON.stringify(result) })
    } catch (error) {
      send({ type: 'tasks_result', id: message.id, ok: false, text: error instanceof Error ? error.message : '查询失败' })
    }
  } }
}
