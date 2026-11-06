import type { AgentEvent } from '../src/renderer/agent-event-types.ts'
import type { ConversationAction, ConversationUpdate } from '../src/renderer/conversation-types.ts'

/** Compiled by typecheck, never executed. A widened escape hatch would make these directives fail. */
export function checkContracts(action: (value: Action) => void, foreground: (value: ConversationAction) => void, event: (value: AgentEvent) => void, update: (value: ConversationUpdate) => void) {
  // @ts-expect-error unknown action label
  action({ type: 'user_promtp', text: 'x', at: 1 })
  // @ts-expect-error required conversation words
  action({ type: 'user_prompt', at: 1 })
  // @ts-expect-error foreground actions have no task routing loophole
  foreground({ type: 'question_pick', taskId: 't', id: 'city', label: 'x' })
  // @ts-expect-error task stream requires both run and task sequence
  action({ type: 'task_end', taskId: 't', at: 1 })
  // @ts-expect-error text chunks require their words
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text' } })
  // @ts-expect-error no mixed foreground context and incomplete task identity
  event({ type: 'permission', context: { conversationId: 'c', sessionId: 's' }, taskId: 't', requestId: 'p', toolCall: {}, options: [] })
}
type IsAny<T> = 0 extends (1 & T) ? true : false
type AssertFalse<T extends false> = T
export type TypedConversation = AssertFalse<IsAny<ConversationView['question']>>
export type TypedPromptResult = AssertFalse<IsAny<Awaited<ReturnType<AgentApi['prompt']>>>>
export type TypedSteerResult = AssertFalse<IsAny<Awaited<ReturnType<AgentApi['steer']>>>>
export type TypedQuestionResult = AssertFalse<IsAny<Awaited<ReturnType<AgentApi['answerQuestion']>>>>
export type TypedSecretResult = AssertFalse<IsAny<Awaited<ReturnType<AgentApi['provideSecrets']>>>>
