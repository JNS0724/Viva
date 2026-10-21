/**
 * History panel and toast slices of the state. Pure and immutable like the rest of `state.js`,
 * which merges these handlers into its reducer.
 */
export const initialHistory = Object.freeze({
  open: false,
  query: '',
  items: [],
  hasMore: false,
  /** null while browsing; the hits for `query` while searching */
  results: null,
  menuFor: null,
  renaming: null,
})

const withHistory = (state, changes) => ({ ...state, history: { ...state.history, ...changes } })

export const HISTORY_ACTIONS = {
  history_open: (state) => withHistory({ ...state, island: false, picker: false }, { open: true }),
  history_close: (state) => withHistory(state, { open: false, menuFor: null, renaming: null }),
  history_toggle: (state) => (state.history.open
    ? HISTORY_ACTIONS.history_close(state)
    : HISTORY_ACTIONS.history_open(state)),

  history_listed: (state, { items, hasMore, append }) => withHistory(state, {
    items: append ? [...state.history.items, ...items] : items,
    hasMore: Boolean(hasMore),
  }),

  history_query: (state, { query }) => withHistory(state, {
    query,
    results: query.trim() ? state.history.results : null,
    menuFor: null,
  }),
  /** Answers to an older query arrive late sometimes; only the one still typed counts. */
  history_results: (state, { query, results }) => (query === state.history.query
    ? withHistory(state, { results })
    : state),

  history_menu: (state, { id }) => withHistory(state, { menuFor: id }),
  history_rename_start: (state, { id }) => withHistory(state, { renaming: id, menuFor: null }),
  history_rename_end: (state) => withHistory(state, { renaming: null }),

  history_item_changed: (state, { id, changes }) => withHistory(state, {
    items: state.history.items.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)),
    renaming: null,
    menuFor: null,
  }),
  /** Search results are messages (timeline-search.js); a conversation gone takes its messages with it. */
  history_item_removed: (state, { id }) => withHistory(state, {
    items: state.history.items.filter((entry) => entry.id !== id),
    results: state.history.results?.filter((hit) => hit.segmentId !== id) ?? null,
    menuFor: null,
  }),

  toast_show: (state, { toast }) => ({ ...state, toast }),
  toast_hide: (state, { key }) => (state.toast?.key === key ? { ...state, toast: null } : state),
}
