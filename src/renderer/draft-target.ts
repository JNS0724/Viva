import { topicTitle } from './topics.ts'
/** Preparation uses a provisional key, then the backend topic survives resumes, saves and renderer reloads. */
export function draftTarget(state: State) {
  const identity = state.newTopicPending ? `pending:${state.topic.startedAt}`
    : `topic:${state.info.topicId ?? state.conversationId ?? state.info.conversationId ?? state.info.sessionId ?? 'startup'}`
  return { key: identity, label: topicTitle(state.messages) }
}
