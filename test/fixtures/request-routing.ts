import { DatabaseSync } from 'node:sqlite'
import { APP_DB_PRAGMAS } from '../../src/backend/app-db.ts'
import { createRequestStore } from '../../src/backend/request-store.ts'
import { createRequestRuntime, type RequestTasks } from '../../src/backend/request-runtime.ts'

/** Task actions nobody should ask for: a test that expects one passes its own. */
const NO_TASKS: RequestTasks = {
  start: async () => { throw new Error('no task runtime in this test') },
  message: async () => { throw new Error('no task runtime in this test') },
  stop: async () => { throw new Error('no task runtime in this test') },
}

/**
 * The app's request runtime (src/backend/request-runtime.ts) over a database of its own, for a bridge under test
 * (its `routing`): requests are kept and decided as in the app, without the event core.
 */
export function testRequests({ tasks = NO_TASKS }: { tasks?: RequestTasks } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(APP_DB_PRAGMAS)
  const store = createRequestStore({ db })
  const runtime = createRequestRuntime({ store, apply: (_kind, _data, write) => ({ value: write() }), tasks })
  return { ...runtime, store }
}

/**
 * A fake dsh child (an EventEmitter standing in for the process) given the plugin side of the app's channels, as
 * viva-routing provides it: the main session's role is bound, and the stream contract confirms each operation, what
 * a turn says reaching the window only through it, never from ACP's text. With `says`, each operation shows that
 * answer (one attempt, settled, then flushed as committed); without, it shows nothing.
 */
export function withPluginSide<T extends NodeJS.EventEmitter>(child: T, { says }: { says?: string } = {}): T {
  const reply = (message: object) => setImmediate(() => child.emit('message', message))
  const answered = new Map<string, Array<{ key: string, blocks: Array<{ type: 'text', text: string }> }>>()
  Object.assign(child, {
    connected: true,
    send: (message: { type?: string, id?: string, operation?: string, sessionId?: string }, callback?: (error: Error | null) => void) => {
      const operation = String(message.operation)
      if (message.type === 'routing_bind') reply({ type: 'routing_bound', version: 1, id: message.id })
      if (message.type === 'assistant_stream_bind') {
        reply({ type: 'assistant_stream_bound', version: 1, operation })
        if (says) {
          const frame = { type: 'assistant_stream', version: 1, sessionId: message.sessionId, operation, key: `${operation}:answer` }
          const blocks = [{ type: 'text' as const, text: says }]
          answered.set(operation, [{ key: frame.key, blocks }])
          reply({ ...frame, kind: 'start' })
          reply({ ...frame, kind: 'settle', blocks })
        }
      }
      if (message.type === 'assistant_stream_flush') {
        const messages = answered.get(operation) ?? []
        reply({ type: 'assistant_stream_flushed', version: 1, operation, messages, finalReply: messages.length > 0 })
      }
      callback?.(null)
      return true
    },
  })
  reply({ type: 'assistant_stream_ready', version: 1 })
  return child
}
