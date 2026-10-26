interface Port { send: (message: object) => unknown, on: (event: 'message', handler: (message: unknown) => void) => unknown, off: (event: 'message', handler: (message: unknown) => void) => unknown }
export function createTasksChannel(port: Port, timeoutMs = 5000) {
  let seq = 0, closed = false
  const pending = new Map<string, (error: Error | null, text?: string) => void>()
  const receive = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.type !== 'tasks_result' || typeof message.id !== 'string') return
    const done = pending.get(message.id); if (!done) return
    if (typeof message.ok !== 'boolean' || typeof message.text !== 'string' || message.text.length > 40_000) return done(new Error('任务查询结果无效'))
    done(message.ok ? null : new Error(message.text), message.text)
  }
  port.on('message', receive)
  return {
    request(request: object, sessionId: string, signal?: AbortSignal): Promise<string> {
      if (closed || signal?.aborted) return Promise.reject(new Error('任务查询已取消或断开'))
      const id = `tasks-${++seq}`
      return new Promise((resolve, reject) => {
        const done = (error: Error | null, text = '') => {
          if (!pending.delete(id)) return
          clearTimeout(timer); signal?.removeEventListener('abort', abort)
          if (error) reject(error); else resolve(text)
        }
        const abort = () => done(new Error('任务查询已取消'))
        const timer = setTimeout(() => done(new Error('任务查询超时')), timeoutMs)
        pending.set(id, done)
        signal?.addEventListener('abort', abort, { once: true })
        try { port.send({ type: 'tasks_query', id, sessionId, request }) } catch (error) { done(error instanceof Error ? error : new Error(String(error))) }
      })
    },
    close() { closed = true; port.off('message', receive); for (const done of pending.values()) done(new Error('任务查询已断开')) },
  }
}
