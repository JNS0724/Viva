/**
 * The config contract (version 1) between this plugin, inside dsh, and the app that started dsh. The messages
 * go over Node's IPC channel (`process.send` / `process.on('message')`); the app keeps the same shapes in
 * src/main/config-channel.js.
 *
 *   plugin → app  { type: 'config', id, sessionId, op, args }   one of the operations in lib/tools.js
 *   plugin → app  { type: 'config_closed', id }                the turn was stopped while the app worked on it
 *   app → plugin  { type: 'config_result', id, ok, text }      what happened, in words for the model
 */
const MAX_TEXT_CHARS = 4000

/**
 * @param {{ send: (message: object) => void, on: Function, off: Function }} port the IPC channel to the app
 * @param {(message: string) => void} log
 * @returns {{ request: (op: string, args: object, sessionId: string | null, signal?: AbortSignal) => Promise<string>, close: () => void }}
 */
export function createConfigChannel(port, log) {
  const waiting = new Map()
  let seq = 0

  function onMessage(message) {
    if (message?.type !== 'config_result') return
    const entry = waiting.get(message.id)
    if (!entry) return
    if (typeof message.text !== 'string' || typeof message.ok !== 'boolean') return log(`ignored a malformed result for ${message.id}`)
    const text = message.text.slice(0, MAX_TEXT_CHARS)
    entry.settle(() => (message.ok ? entry.resolve(text) : entry.reject(new Error(text))))
  }
  port.on('message', onMessage)

  /** Asks the app to perform `op`; resolves with what it did, rejects with why not (the model sees either). */
  function request(op, args, sessionId, signal) {
    const id = `c${++seq}-${Date.now().toString(36)}`
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
      const entry = {
        resolve,
        reject,
        settle(finish) {
          waiting.delete(id)
          signal?.removeEventListener('abort', onAbort)
          finish()
        },
      }
      function onAbort() {
        entry.settle(() => {
          port.send({ type: 'config_closed', id })
          reject(signal.reason ?? new Error('aborted'))
        })
      }
      signal?.addEventListener('abort', onAbort)
      waiting.set(id, entry)
      port.send({ type: 'config', id, sessionId, op, args })
    })
  }

  /** dsh is going away: nothing will answer what is still waiting. */
  function close() {
    port.off('message', onMessage)
    for (const entry of waiting.values()) entry.settle(() => entry.reject(new Error('应用已经断开，配置没有完成')))
  }

  return { request, close }
}
