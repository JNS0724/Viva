import { randomUUID } from 'node:crypto'
import { objectOf } from '../shared/unknown-value.ts'
import { t } from '../shared/i18n/translate.ts'

type OutputBlock = { type: 'text' | 'reasoning', text: string }
type CommittedOutput = { key: string, blocks: OutputBlock[] }
const committedOutput = (value: unknown): value is CommittedOutput => {
  const entry = objectOf(value)
  return typeof entry?.key === 'string' && Array.isArray(entry.blocks) && entry.blocks.every((value: unknown) => {
    const block = objectOf(value)
    return (block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string'
  })
}

/** Source selection belongs to a prompt operation, never a reusable session flag. */
export function createAssistantStream({ send, emit, timeoutMs = 1000, allowAcpFallback = true }: {
  send: (message: object) => void,
  emit: (sessionId: string, update: any) => void,
  timeoutMs?: number,
  /** Disable raw ACP replay when only the native channel can authorize visible output. */
  allowAcpFallback?: boolean,
}) {
  let ready = false
  const instance = randomUUID()
  let sequence = 0
  type Operation = {
    id: string, sessionId: string, live: boolean
    active: Set<string>, keys: Set<string>
    settled: Map<string, Array<{ type: string, text?: string }>>
    fallback: any[], closed: Map<string, Set<number>>
    finalReply?: boolean, committed?: CommittedOutput[]
    resolve?: (live: boolean) => void, flushed?: (ok: boolean) => void
  }
  const operations = new Map<string, Operation>()
  const begin = async (sessionId: string) => {
    const operation: Operation = { id: `${instance}:${++sequence}`, sessionId, live: false, finalReply: false, active: new Set(), keys: new Set(), settled: new Map(), fallback: [], closed: new Map() }
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
      for (const operation of operations.values()) if (operation.id === message.operation) {
        if (Array.isArray(message.messages) && message.messages.every(committedOutput) && typeof message.finalReply === 'boolean') {
          operation.committed = message.messages
          operation.finalReply = message.finalReply
        }
        operation.flushed?.(true)
      }
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
      operation.settled.set(message.key, message.blocks)
      emit(message.sessionId, { sessionUpdate: 'viva_stream', key: message.key, kind: 'settle', blocks: message.blocks })
      operation.active.delete(message.key); operation.closed.delete(message.key)
    }
  }
  return { begin, finish, receive,
    suppress: (sessionId: string, update: any) => {
      const operation = operations.get(sessionId)
      if (!operation) return false
      const textUpdate = ['agent_message_chunk', 'agent_thought_chunk'].includes(update?.sessionUpdate)
      if (textUpdate && !allowAcpFallback) return true
      if (update?.sessionUpdate === 'tool_call') operation.finalReply = false
      if (update?.sessionUpdate === 'agent_thought_chunk') operation.finalReply ??= false
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && update.content.text.trim()) operation.finalReply = true
      if (!operation.live || !textUpdate) return false
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
        if (operation.committed) {
          const keys = new Set(operation.committed.map(message => message.key))
          for (const key of operation.keys) if (!keys.has(key)) emit(operation.sessionId, { sessionUpdate: 'viva_stream', key, kind: 'settle', blocks: [] })
          const before: { text?: string, reasoning?: string } = {}
          let recovered = false
          for (const message of [...operation.committed].reverse()) {
            if (JSON.stringify(operation.settled.get(message.key)) !== JSON.stringify(message.blocks)) {
              emit(operation.sessionId, { sessionUpdate: 'viva_stream', key: message.key, kind: 'settle', blocks: message.blocks, before: { ...before } })
              recovered = true
            }
            for (const block of message.blocks) if (block.text) before[block.type] = message.key
          }
          // Task previews consume settlements too. Finish recovery on the last committed text.
          const lastText = operation.committed.findLast(message => message.blocks.some(block => block.type === 'text' && block.text))
          if (recovered && lastText) emit(operation.sessionId, { sessionUpdate: 'viva_stream', key: lastText.key, kind: 'settle', blocks: lastText.blocks })
          operation.active.clear()
          finish(operation)
          return operation.finalReply
        }
        // A flush only acknowledges transport. Earlier settled thoughts cannot prove the final answer arrived.
        const missingContent = [['agent_message_chunk', 'text'], ['agent_thought_chunk', 'reasoning']].some(([kind, type]) => {
          const expected = operation.fallback
            .filter(update => update.sessionUpdate === kind && update.content?.type === 'text')
            .map(update => update.content.text).join('')
          const actual = [...operation.keys]
            .flatMap(key => operation.settled.get(key) ?? [])
            .filter(block => block.type === type).map(block => block.text ?? '').join('')
          return expected.length > 0 && expected !== actual
        })
        if (allowAcpFallback && (!flushed || operation.active.size || missingContent || (!operation.keys.size && operation.fallback.length))) {
          for (const key of operation.keys) emit(operation.sessionId, { sessionUpdate: 'viva_stream', key, kind: 'settle', blocks: [] })
          operation.active.clear()
          for (const update of operation.fallback) emit(operation.sessionId, update)
        }
      }
      finish(operation)
      if (!allowAcpFallback) throw new Error(t('main.assistant-stream.output.not.confirmed'))
      return operation.finalReply
    },
    close() { ready = false; for (const operation of [...operations.values()]) finish(operation) },
  }
}
