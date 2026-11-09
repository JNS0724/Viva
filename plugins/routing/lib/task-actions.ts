/**
 * Handovers to the app's TaskRuntime over the viva-tasks channel (plugins/tasks/lib/channel.ts): the only way the
 * routing plugin acts. Every call answers with a receipt, failures included, so a caller never mistakes a handover
 * that did not happen for one that did.
 */
import { createTasksChannel } from '../../tasks/lib/channel.ts'

const ACTION_WAIT_MS = 60_000

export type Receipt = { ok: true, taskId?: string, [field: string]: unknown } | { ok: false, error: string }
export interface ListedTask { taskId: string, title: string, goal: string, status: string }

export function createTaskActions(port: NodeJS.Process) {
  const channel = createTasksChannel({ send: port.send!.bind(port), on: port.on.bind(port), off: port.off.bind(port) })
  async function request(body: object, sessionId: string, signal?: AbortSignal): Promise<Receipt> {
    try {
      return { ok: true, ...JSON.parse(await channel.request(body, sessionId, signal, ACTION_WAIT_MS)) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    start: (brief: string, sessionId: string, signal?: AbortSignal) => request({ op: 'start', brief }, sessionId, signal),
    message: (taskId: string, text: string, sessionId: string, signal?: AbortSignal) => request({ op: 'message', taskId, text }, sessionId, signal),
    stop: (taskId: string, sessionId: string, signal?: AbortSignal) => request({ op: 'stop', taskId }, sessionId, signal),
    async list(sessionId: string, signal?: AbortSignal): Promise<ListedTask[]> {
      const receipt = await request({ op: 'list', limit: 30 }, sessionId, signal)
      const tasks = receipt.ok && Array.isArray(receipt.tasks) ? receipt.tasks as Array<Record<string, unknown>> : []
      return tasks.map(task => ({ taskId: String(task.taskId), title: String(task.title ?? ''), goal: String(task.request ?? task.goal ?? '').slice(0, 300), status: String(task.status ?? '') }))
    },
    close: () => channel.close(),
  }
}
export type TaskActions = ReturnType<typeof createTaskActions>
