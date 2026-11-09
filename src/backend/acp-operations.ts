import type { ClientSideConnection, PromptResponse } from '@agentclientprotocol/sdk'
import type { ConversationContext } from '../shared/conversation-context.ts'
import type { createAssistantStream } from './assistant-stream.ts'
import { stopInTime } from './stop-in-time.ts'

type Streams = Pick<ReturnType<typeof createAssistantStream>, 'begin' | 'complete' | 'finish' | 'close'>
type Prompt = Parameters<ClientSideConnection['prompt']>[0]['prompt']
interface Operation {
  released: boolean
  prompting: boolean
  context: ConversationContext | null
  stream?: Awaited<ReturnType<Streams['begin']>>
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

  async function run({ sessionId, prompt, context = null, prepare, onEnd, onError }: {
    sessionId: string | null, prompt: Prompt, context?: ConversationContext | null
    prepare?: () => Promise<void>
    onEnd: (response: PromptResponse, finalReply?: boolean) => void
    onError: (error: unknown) => void
  }) {
    if (closed) return
    const operation: Operation = { released: false, prompting: false, context: context ? { ...context } : null }
    running.set(sessionId, operation)
    try {
      if (!sessionId) throw new Error('no session is open')
      if (prepare) await prepare()
      if (!current(sessionId, operation)) return
      operation.stream = await streams.begin(sessionId)
      if (!current(sessionId, operation)) { streams.finish(operation.stream); return }
      operation.prompting = true
      const response = await connection().prompt({ sessionId, prompt })
      if (!current(sessionId, operation)) return
      const finalReply = await streams.complete(operation.stream)
      if (current(sessionId, operation)) onEnd(response, finalReply)
    } catch (error) {
      if (!current(sessionId, operation)) return
      if (operation.stream) await streams.complete(operation.stream)
      if (current(sessionId, operation)) onError(error)
    } finally {
      if (running.get(sessionId) === operation) running.delete(sessionId)
    }
  }

  function cancelPreparing(sessionId: string, onCancelled: () => void): boolean {
    const operation = running.get(sessionId)
    if (!operation || operation.released || operation.prompting) return false
    operation.released = true
    if (operation.stream) streams.finish(operation.stream)
    onCancelled()
    return true
  }

  async function cancelInTime(sessionId: string, onForced: () => void) {
    const operation = running.get(sessionId)
    if (!operation) return
    cancelPermissions(sessionId)
    if (cancelPreparing(sessionId, onForced)) return
    await stopInTime({
      cancel: () => connection().cancel({ sessionId }),
      stillRunning: () => current(sessionId, operation) && !closed,
      giveUp: () => {
        if (operation.stream) streams.finish(operation.stream)
        operation.released = true
        onForced()
      },
    })
  }
  return {
    run, cancelInTime, cancelPreparing,
    has: (id: string | null) => running.has(id),
    isReleased: (id: string) => running.get(id)?.released ?? false,
    context: (id: string) => { const context = running.get(id)?.context; return context ? { ...context } : null },
    forwardStream(id: string, update: unknown) {
      const operation = running.get(id)
      if (operation && !operation.released) streamUpdate(id, update, operation.context)
    },
    count: (include: (id: string) => boolean) => [...running].filter(([id, operation]) => id !== null && !operation.released && include(id)).length,
    dispose() {
      if (closed) return
      streams.close()
      closed = true
      for (const operation of running.values()) operation.released = true
      running.clear()
    },
  }
}
export type AcpOperations = ReturnType<typeof createAcpOperations>
