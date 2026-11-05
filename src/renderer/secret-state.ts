import { closeStreams } from './streams.ts'

/**
 * Keys a server the model set up needs (viva-config, src/backend/config-channel.ts). While the card waits, the
 * phase is 'asking'. The values go from the card straight to the main process; the state only ever holds
 * which server asks for which names, and the trace only that it was asked and whether it was filled in.
 */
export const SECRET_ACTIONS: Record<string, Reducer> = {
  secret_request: (state, { requestId, server, names, at }) => {
    // Shown already (one read on opening and also come live, read-handoff.ts): once.
    if (state.timeline.some((entry) => entry.kind === 'secret' && entry.ref === requestId)) return state
    return {
      ...closeStreams(state),
      phase: 'asking',
      secret: { requestId, server, names },
      timeline: [...state.timeline, { kind: 'secret', ref: requestId, at, title: `${server}：${names.join('、')}` }],
    }
  },
  secret_resolved: (state, { requestId, provided, at }) => {
    if (state.secret?.requestId !== requestId) return state
    return {
      ...state,
      phase: 'working',
      secret: null,
      timeline: [...state.timeline, { kind: 'secret_answer', ref: requestId, at, title: state.secret.server, provided }],
    }
  },
  /** Keys still asked for, read when the window opened on a dsh at work (a reload): shown, one shown already once. */
  secrets_restored: (state, { secrets = [], at }) => (secrets as Action[]).reduce<State>((current, wait) => SECRET_ACTIONS.secret_request(current, { ...wait, type: 'secret_request', at }), state),
  secret_closed: (state, { requestId }) => (state.secret?.requestId === requestId
    ? { ...state, phase: state.phase === 'asking' ? 'working' : state.phase, secret: null }
    : state),
}
