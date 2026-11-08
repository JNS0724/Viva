import { topicTitle } from './topics.ts'
/** A new topic retains its key while its runtime is prepared and while history assigns its first id. */
export function draftTarget(state: State) {
  const identity = state.topic.startedAt != null ? `topic:${state.topic.startedAt}`
    : `conversation:${state.conversationId ?? state.info.conversationId ?? state.info.sessionId ?? 'startup'}`
  return { key: `${state.info.cwd ?? ''}|${identity}`, label: topicTitle(state.messages) }
}
