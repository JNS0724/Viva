import { randomUUID } from 'node:crypto'

/** Source selection belongs to a prompt operation, never a reusable session flag. */
export function createAssistantStream({ send, emit, timeoutMs = 1000 }: {
  send: (message: object) => void,
  emit: (sessionId: string, update: any) => void,
  timeoutMs?: number,
}) {
  let ready = false
  const instance = randomUUID()
  let sequence = 0
  type Operation = { id: string, sessionId: string, live: boolean, active: Set<string>, keys: Set<string>, fallback: any[], closed: Map<string, Set<number>>, resolve?: (live: boolean) => void, flushed?: (ok: boolean) => void }
  const operations = new Map<string, Operation>()
  const begin = async (sessionId: string) => {
    const operation: Operation = { id: `${instance}:${++sequence}`, sessionId, live: false, active: new Set(), keys: new Set(), fallback: [], closed: new Map() }
    operations.set(sessionId, operation)
    if (ready) {
      operation.live = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { operation.resolve = undefined; resolve(false) }, timeoutMs)
        operation.resolve = live => { clearTimeout(timer); operation.resolve = undefined; resolve(live) }
        send({ type: 'assistant_stream_bind', version: 1, operation: operation.id, sessionId })
      })
    }
    return operation
  }
  const finish = (operation: Operation) => {
    if (operations.get(operation.sessionId) !== operation) return
    for (const key of operation.active) emit(operation.sessionId, { sessionUpdate: 'viva_stream', key, kind: 'settle', blocks: [] })
    operation.resolve?.(false)
    operation.flushed?.(false)
    operations.delete(operation.sessionId)
  }
  function receive(message: any) {
    if (message?.version !== 1) return
    if (message.type === 'assistant_stream_ready') { ready = true; return }
    if (message.type === 'assistant_stream_bound') {
      for (const operation of operations.values()) if (operation.id === message.operation) operation.resolve?.(true)
      return
    }
    if (message.type === 'assistant_stream_flushed') {
      for (const operation of operations.values()) if (operation.id === message.operation) operation.flushed?.(true)
      return
    }
    if (message.type !== 'assistant_stream') return
    const operation = operations.get(message.sessionId)
    if (!operation?.live || operation.id !== message.operation || typeof message.key !== 'string') return
    if (message.kind === 'start') { operation.keys.add(message.key); operation.active.add(message.key); operation.closed.set(message.key, new Set()); return }
    if (!operation.active.has(message.key)) return
    if (message.kind === 'delta' || message.kind === 'block') {
      if (!Number.isSafeInteger(message.index) || message.index < 0 || !['text', 'reasoning'].includes(message.blockType) || typeof message.text !== 'string') return
      const closed = operation.closed.get(message.key)!
      if (closed.has(message.index)) return
      if (message.kind === 'block') closed.add(message.index)
      emit(message.sessionId, { sessionUpdate: 'viva_stream', key: message.key, kind: message.kind, index: message.index, blockType: message.blockType, text: message.text })
    }
    if (message.kind === 'settle' && Array.isArray(message.blocks)) {
      emit(message.sessionId, { sessionUpdate: 'viva_stream', key: message.key, kind: 'settle', blocks: message.blocks })
      operation.active.delete(message.key); operation.closed.delete(message.key)
    }
  }
  return { begin, finish, receive,
    suppress: (sessionId: string, update: any) => {
      const operation = operations.get(sessionId)
      if (!operation?.live || !['agent_message_chunk', 'agent_thought_chunk'].includes(update?.sessionUpdate)) return false
      operation.fallback.push(update)
      return true
    },
    async complete(operation: Operation) {
      if (operations.get(operation.sessionId) !== operation) return
      if (operation.live) {
        const flushed = await new Promise<boolean>(resolve => {
          const timer = setTimeout(() => { operation.flushed = undefined; resolve(false) }, timeoutMs)
          operation.flushed = ok => { clearTimeout(timer); operation.flushed = undefined; resolve(ok) }
          send({ type: 'assistant_stream_flush', version: 1, operation: operation.id })
        })
        if (operations.get(operation.sessionId) !== operation) return
        if (!flushed || operation.active.size || (!operation.keys.size && operation.fallback.length)) {
          for (const key of operation.keys) emit(operation.sessionId, { sessionUpdate: 'viva_stream', key, kind: 'settle', blocks: [] })
          operation.active.clear()
          for (const update of operation.fallback) emit(operation.sessionId, update)
        }
      }
      finish(operation)
    },
    close() { ready = false; for (const operation of [...operations.values()]) finish(operation) },
  }
}
