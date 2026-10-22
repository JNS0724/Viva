import { closeStreams } from './streams.ts'

/**
 * Keys a server the model set up needs (viva-config, src/main/config-channel.js). While the card waits, the
 * phase is 'asking'. The values go from the card straight to the main process; the state only ever holds
 * which server asks for which names, and the trace only that it was asked and whether it was filled in.
 */
export const SECRET_ACTIONS = {
  secret_request: (state, { requestId, server, names, at }) => ({
    ...closeStreams(state),
    phase: 'asking',
    secret: { requestId, server, names },
    timeline: [...state.timeline, { kind: 'secret', ref: requestId, at, title: `${server}：${names.join('、')}` }],
  }),
  secret_resolved: (state, { requestId, provided, at }) => {
    if (state.secret?.requestId !== requestId) return state
    return {
      ...state,
      phase: 'working',
      secret: null,
      timeline: [...state.timeline, { kind: 'secret_answer', ref: requestId, at, title: state.secret.server, provided }],
    }
  },
  secret_closed: (state, { requestId }) => (state.secret?.requestId === requestId
    ? { ...state, phase: state.phase === 'asking' ? 'working' : state.phase, secret: null }
    : state),
}
