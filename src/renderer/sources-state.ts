import type { ActionHandlers } from './action-types.ts'
import type { SourceView } from './capability-types.ts'

/**
 * 能力 · 消息源 (src/backend/sources-desk.ts): the user's message sources as the main process lists them, with how
 * each stands since the app started. They are set up from the conversation; here they are only looked at, paused or
 * resumed, and deleted. 动态 also reads this slice: with none yet, it says how to add one.
 */
export const initialSources = Object.freeze({
  loaded: false,
  list: Object.freeze([]) as readonly SourceView[],
  /** A change is on its way to the main process. */
  busy: false,
  error: null as string | null,
})

const withSources = (state: State, changes: Partial<State['sources']>): State => ({ ...state, sources: { ...state.sources, ...changes } })

export const SOURCE_ACTIONS = {
  sources_loaded: (state, { list }) => withSources(state, { loaded: true, list, busy: false, error: null }),
  sources_busy: (state) => withSources(state, { busy: true, error: null }),
  sources_failed: (state, { message }) => withSources(state, { busy: false, error: message }),
} satisfies ActionHandlers

export const sourcesOf = (state: State): readonly SourceView[] => state.sources.list as readonly SourceView[]

/** A source that needs looking at: on, but its last check failed. */
export const sourceWrong = (source: SourceView) => !source.paused && Boolean(source.status.error)

/** How a source stands: paused, its last check failed (and why), or on. */
export type SourceStanding = { kind: 'paused' } | { kind: 'failed', reason: string } | { kind: 'on' }

export function sourceStanding(source: SourceView): SourceStanding {
  if (source.paused) return { kind: 'paused' }
  return source.status.error ? { kind: 'failed', reason: source.status.error } : { kind: 'on' }
}

/** 动态 says how to add one only while there is none, and only once the list is known. */
export const offersSources = (state: State) => state.sources.loaded && sourcesOf(state).length === 0
