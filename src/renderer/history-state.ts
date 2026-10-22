/**
 * Search panel and toast slices of the state. Pure and immutable like the rest of `state.js`,
 * which merges these handlers into its reducer.
 */
export const initialHistory = Object.freeze({
  open: false,
  query: '',
  /** null until the hits for `query` are in: messages of the timeline (timeline-search.js) */
  results: null,
})

const withHistory = (state, changes) => ({ ...state, history: { ...state.history, ...changes } })

export const HISTORY_ACTIONS = {
  history_open: (state) => withHistory({ ...state, island: false, picker: false }, { open: true }),
  history_close: (state) => withHistory(state, { open: false }),
  history_toggle: (state) => (state.history.open
    ? HISTORY_ACTIONS.history_close(state)
    : HISTORY_ACTIONS.history_open(state)),

  history_query: (state, { query }) => withHistory(state, {
    query,
    results: query.trim() ? state.history.results : null,
  }),
  /** Answers to an older query arrive late sometimes; only the one still typed counts. */
  history_results: (state, { query, results }) => (query === state.history.query
    ? withHistory(state, { results })
    : state),

  toast_show: (state, { toast }) => ({ ...state, toast }),
  toast_hide: (state, { key }) => (state.toast?.key === key ? { ...state, toast: null } : state),
}
