import { createConversationIngress } from './conversation-ingress.ts'
import { createEventActions } from './agent-event-actions.ts'
import { decodeAgentEvent, type EventIssue } from './agent-event-decoder.ts'
import type { AgentEvent } from './agent-event-types.ts'

/** Held pushes arrived before the erasure notice. Keep the non-trace portion of a settlement. */
function withoutHeldTrace(event: AgentEvent, sessions: ReadonlySet<string>): AgentEvent | undefined {
  if ((event.type !== 'update' && event.type !== 'memory_context')
    || !event.context.sessionId || !sessions.has(event.context.sessionId)) return event
  if (event.type === 'memory_context') return undefined
  const update = event.update
  if (update.sessionUpdate === 'agent_thought_chunk' || update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') return undefined
  if (update.sessionUpdate !== 'viva_stream') return event
  if (update.kind !== 'settle') return update.blockType === 'reasoning' ? undefined : event
  return { ...event, update: {
    ...update, blocks: update.blocks.filter(block => block.type !== 'reasoning'),
    before: update.before?.text === undefined ? undefined : { text: update.before.text },
  } }
}

/** Owns the wire boundary, foreground selection handoff, task-load handoff and push-triggered effects. */
export function createAgentEvents({ getState, dispatch, holdTask, afterTurn, clearAfterTurn, ready, mcpChanged = () => {}, refreshWorkDir, refreshFiles, memoryChanged, filesChanged, refreshFeed, rejected, now = Date.now }: {
  getState: () => State, dispatch: (action: Action) => void
  holdTask: (event: AgentEvent) => boolean
  afterTurn: (reason?: string) => void, clearAfterTurn: () => void
  ready: (info: AgentInfo) => void
  /** How the MCP servers stand changed (viva-mcp). */
  mcpChanged?: (mcp: NonNullable<AgentInfo['mcp']>) => void
  refreshWorkDir: () => void, refreshFiles: () => void, refreshFeed: () => void
  memoryChanged: (event: Extract<AgentEvent, { type: 'memory_changed' }>) => void
  filesChanged: (event: Extract<AgentEvent, { type: 'files_changed' }>) => void
  rejected?: (issue: EventIssue) => void
  now?: () => number
}) {
  const actionFor = createEventActions({ now })
  const ingress = createConversationIngress<AgentEvent>({
    initialized: false, now,
    current: () => {
      const state = getState()
      return {
        pending: state.newTopicPending || state.switching || state.workDir.switching || state.rewind.busy || state.settings.busy,
        context: { conversationId: state.conversationId ?? state.info.conversationId ?? null, sessionId: state.info.sessionId ?? null },
      }
    },
    deliver(event, receivedAt) {
      if ((event.type === 'update' || event.type === 'task_update') && event.update.sessionUpdate === 'viva_stream') {
        const session = event.type === 'update' ? event.context.sessionId : event.taskId
        if (getState().erasedGeneratedKeys[event.update.key] === session) return
      }
      const action = actionFor(event, receivedAt)
      if (action) dispatch(action)
      switch (event.type) {
        case 'ready': ready(event.info); refreshWorkDir(); break
        case 'workdir': refreshWorkDir(); break
        case 'mcp_status': mcpChanged(event.mcp); break
        case 'turn_end': refreshFiles(); afterTurn(event.stopReason); break
        case 'task_end': refreshFiles(); break
        case 'error': clearAfterTurn(); break
        case 'feed_changed': case 'schedules_changed': refreshFeed(); break
      }
    },
  })
  return {
    receive(value: unknown) {
      const event = decodeAgentEvent(value, rejected)
      if (!event) return
      if (event.type === 'memory_changed') {
        if (event.erasedOutputs?.length) dispatch({ type: 'generated_outputs_removed', copies: event.erasedOutputs })
        if (event.traceSessions?.length) {
          const sessions = new Set(event.traceSessions)
          ingress.reviseHeld(held => withoutHeldTrace(held, sessions))
        }
        return memoryChanged(event)
      }
      if (event.type === 'files_changed') return filesChanged(event)
      if (!holdTask(event)) ingress.receive(event)
    },
    replay: ingress.receive,
    stateChanged: ingress.stateChanged,
    initialize: ingress.initialize,
  }
}
