/**
 * The messages contract (version 1) between this plugin, inside dsh, and the app that started dsh, over Node's
 * IPC channel (`process.send` / `process.on('message')`); the app keeps the same shapes in
 * src/main/messages-channel.ts.
 *
 *   plugin → app  { type: 'messages_read', id, request: { source?, query?, since_hours?, limit? } }
 *                                                       the model wants the messages the sources brought in
 *   app → plugin  { type: 'messages_result', id, ok, text }
 *                                                       the messages in words for the model, or why there are none
 */
const MAX_TEXT_CHARS = 16_000
/** The app reads stale sources again first (20 s at most) before it answers. */
export const READ_TIMEOUT_MS = 40_000

type Port = { send: (message: object) => unknown, on: Function, off: Function }

export function createMessagesChannel(port: Port, log: (message: string) => void) {
  const waiting = new Map<string, { resolve: (text: string) => void, reject: (err: Error) => void }>()
  let seq = 0

  function onMessage(message: any) {
    if (message?.type !== 'messages_result') return
    const entry = waiting.get(message.id)
    if (!entry) return
    waiting.delete(message.id)
    if (typeof message.text !== 'string' || typeof message.ok !== 'boolean') return entry.reject(new Error('应用回的结果不完整'))
    const text = message.text.slice(0, MAX_TEXT_CHARS)
    if (message.ok) entry.resolve(text)
    else entry.reject(new Error(text))
  }
  port.on('message', onMessage)

  /** Asks the app for messages; rejects with why not, which the model sees. */
  function read(request: object, signal?: AbortSignal): Promise<string> {
    const id = `m${++seq}-${Date.now().toString(36)}`
    return new Promise<string>((resolve, reject) => {
      const done = AbortSignal.any([AbortSignal.timeout(READ_TIMEOUT_MS), ...(signal ? [signal] : [])])
      if (done.aborted) return reject(new Error('已取消'))
      const stop = () => {
        if (!waiting.delete(id)) return
        log(`gave up waiting for ${id}`)
        reject(new Error(signal?.aborted ? '已取消' : '读消息超时了，稍后再试'))
      }
      done.addEventListener('abort', stop, { once: true })
      waiting.set(id, {
        resolve: (text) => { done.removeEventListener('abort', stop); resolve(text) },
        reject: (err) => { done.removeEventListener('abort', stop); reject(err) },
      })
      port.send({ type: 'messages_read', id, request })
    })
  }

  /** dsh is going away: nothing will answer what still waits. */
  function close() {
    port.off('message', onMessage)
    for (const entry of waiting.values()) entry.reject(new Error('应用已经断开'))
    waiting.clear()
  }

  return { read, close }
}
