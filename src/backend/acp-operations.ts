import { randomUUID } from 'node:crypto'
import { diagnosticPort } from '../diagnostics/node/context.ts'
import { beginDiagnosticOperation } from '../diagnostics/operation.ts'
import type { ClientSideConnection, PromptResponse } from '@agentclientprotocol/sdk'
import type { ConversationContext } from '../shared/conversation-context.ts'
import type { createAssistantStream } from './assistant-stream.ts'
import { stopInTime } from './stop-in-time.ts'

type Streams = Pick<ReturnType<typeof createAssistantStream>, 'begin' | 'complete' | 'finish' | 'close'>
type Prompt = Parameters<ClientSideConnection['prompt']>[0]['prompt']
interface Operation {
  id: string
  released: boolean
  foreground: boolean
  prompting: boolean
  cancelling?: boolean
  context: ConversationContext | null
  stream?: Awaited<ReturnType<Streams['begin']>>
  observation: ReturnType<typeof beginDiagnosticOperation>
  firstResponse: boolean
}
// Observe only normalized output that is forwarded to the conversation, including a recovered final reply.
function hasAssistantContent(update: unknown): boolean {
  const field = (value: unknown, key: string): unknown => value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
  if (field(update, 'sessionUpdate') !== 'viva_stream') return false
  const hasText = (block: unknown, typeField: string) => {
    const type = field(block, typeField)
    const text = field(block, 'text')
    return (type === 'text' || type === 'reasoning') && typeof text === 'string' && text.length > 0
  }
  const kind = field(update, 'kind')
  if (kind === 'delta' || kind === 'block') return hasText(update, 'blockType')
  if (kind !== 'settle') return false
  const blocks = field(update, 'blocks')
  return Array.isArray(blocks) && blocks.some(block => hasText(block, 'type'))
}

/** Owns native prompt identities and their streams, never TaskRuntime admission/status or process lifetime. */
export function createAcpOperations({ connection, streams, cancelPermissions, streamUpdate }: {
  connection: () => Pick<ClientSideConnection, 'prompt' | 'cancel'>
  streams: Streams
  cancelPermissions: (sessionId: string) => void
  streamUpdate: (sessionId: string, update: unknown, context: ConversationContext | null) => void
}) {
  const running = new Map<string | null, Operation>()
  let closed = false
  const current = (id: string | null, operation: Operation) => running.get(id) === operation && !operation.released

  async function run({ sessionId, prompt, context = null, userTurn = false, prepare, held, onStart, onEnd, onError }: {
    sessionId: string | null, prompt: Prompt, context?: ConversationContext | null
    userTurn?: boolean
    prepare?: () => Promise<void>
    held?: () => boolean
    onStart?: () => void
    onEnd: (response: PromptResponse, finalReply?: boolean) => void
    onError: (error: unknown) => void
  }) {
    if (closed) return
    const id = randomUUID()
    const operation: Operation = { id, released: false, prompting: false, context: context ? { ...context } : null, foreground: userTurn, firstResponse: false,
      observation: beginDiagnosticOperation(diagnosticPort, 'conversation.send', { stage: 'queued',
        identities: { operationId: id, sessionId, conversationId: context?.conversationId } }) }
    running.set(sessionId, operation)
    let outcome: 'completed' | 'cancelled' = 'cancelled'
    try {
      if (!sessionId) throw new Error('no session is open')
      if (prepare) await prepare()
      operation.observation.progress({ stage: 'injected' })
      if (!current(sessionId, operation)) return
      operation.stream = await streams.begin(sessionId)
      if (!current(sessionId, operation)) { streams.finish(operation.stream); return }
      if (!current(sessionId, operation) || closed) return
      if (held && !held()) {
        streams.finish(operation.stream)
        onEnd({ stopReason: 'cancelled' })
        return
      }
      operation.prompting = true
      operation.observation.progress({ stage: 'sending' })
      const sent = connection().prompt({ sessionId, prompt })
      onStart?.()
      const reply = await sent
      const response: PromptResponse = operation.cancelling ? { stopReason: 'cancelled' } : reply
      outcome = response.stopReason === 'cancelled' ? 'cancelled' : 'completed'
      if (!current(sessionId, operation)) return
      const finalReply = await streams.complete(operation.stream)
      if (current(sessionId, operation)) onEnd(response, finalReply)
    } catch (error) {
      operation.observation.fail(error)
      if (!current(sessionId, operation)) return
      if (operation.stream) {
        try { await streams.complete(operation.stream) }
        catch { /* Recovery cannot prevent the original prompt failure from settling. */ }
      }
      if (current(sessionId, operation)) {
        if (operation.cancelling) onEnd({ stopReason: 'cancelled' })
        else onError(error)
      }
    } finally {
      const late = operation.prompting && operation.released
      operation.observation.end(late ? 'late_completed' : outcome, { stage: 'settled', ...(late ? { reason: 'late' as const } : {}) })
      if (running.get(sessionId) === operation) running.delete(sessionId)
    }
  }

  function cancelPreparing(sessionId: string, onCancelled: () => void): boolean {
    const operation = running.get(sessionId)
    if (!operation || operation.released || operation.prompting) return false
    operation.released = true
    operation.observation.progress({ stage: 'paused', reason: 'aborted' })
    if (operation.stream) streams.finish(operation.stream)
    onCancelled()
    return true
  }

  async function cancelInTime(sessionId: string, onForced: () => void, options: {
    onRequested?: () => void, onPreparingCancelled?: () => void, graceMs?: number,
  } = {}) {
    const operation = running.get(sessionId)
    if (!operation || operation.released) return false
    if (operation.cancelling) return true
    operation.cancelling = true
    cancelPermissions(sessionId)
    options.onRequested?.()
    if (cancelPreparing(sessionId, options.onPreparingCancelled ?? onForced)) return true
    await stopInTime({
      cancel: () => connection().cancel({ sessionId }),
      stillRunning: () => current(sessionId, operation) && !closed,
      graceMs: options.graceMs,
      giveUp: () => {
        operation.observation.progress({ stage: 'waiting', reason: 'timeout' })
        if (operation.stream) streams.finish(operation.stream)
        operation.released = true
        onForced()
      },
    })
    return true
  }
  return {
    run, cancelInTime, cancelPreparing,
    has: (id: string | null) => running.has(id),
    isReleased: (id: string) => running.get(id)?.released ?? false,
    context: (id: string) => { const context = running.get(id)?.context; return context ? { ...context } : null },
    turn(id: string) {
      const operation = running.get(id)
      return operation && !operation.released && !operation.cancelling ? operation.id : undefined
    },
    userTurn(id: string) {
      const operation = running.get(id)
      return operation?.foreground && !operation.released ? operation.id : undefined
    },
    endUserTurn(id: string) {
      const operation = running.get(id)
      if (operation) operation.foreground = false
    },
    forwardStream(id: string, update: unknown) {
      const operation = running.get(id)
      if (operation && !operation.released) {
        try {
          if (!operation.firstResponse && hasAssistantContent(update)) {
            operation.firstResponse = true
            operation.observation.progress({ stage: 'first-response' })
          }
        } catch { /* Diagnostic inspection cannot intercept a stream update. */ }
        streamUpdate(id, update, operation.context)
      }
    },
    count: (include: (id: string) => boolean) => [...running].filter(([id, operation]) => id !== null && !operation.released && include(id)).length,
    dispose() {
      if (closed) return
      streams.close()
      closed = true
      for (const operation of running.values()) {
        operation.released = true
        operation.observation.progress({ stage: 'closed', reason: 'process_exited' })
      }
      running.clear()
    },
  }
}
export type AcpOperations = ReturnType<typeof createAcpOperations>
