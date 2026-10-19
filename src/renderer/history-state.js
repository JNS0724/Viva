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
const mapList = (list, fn) => (list ? list.map(fn) : list)
const dropFrom = (list, id) => (list ? list.filter((entry) => entry.id !== id) : list)

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

  history_item_changed: (state, { id, changes }) => {
    const update = (entry) => (entry.id === id ? { ...entry, ...changes } : entry)
    return withHistory(state, {
      items: mapList(state.history.items, update),
      results: mapList(state.history.results, update),
      renaming: null,
      menuFor: null,
    })
  },
  history_item_removed: (state, { id }) => withHistory(state, {
    items: dropFrom(state.history.items, id),
    results: dropFrom(state.history.results, id),
    menuFor: null,
  }),

  toast_show: (state, { toast }) => ({ ...state, toast }),
  toast_hide: (state, { key }) => (state.toast?.key === key ? { ...state, toast: null } : state),
}
