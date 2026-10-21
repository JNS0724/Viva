const SEARCH_DEBOUNCE_MS = 200
const TOAST_MS = 3000

/**
 * The search panel (⌘F), the toasts, and the trace of a restored conversation.
 * @param {{
 *   api: typeof window.agent, getState: () => object, dispatch: (action: object) => void,
 *   searchField: HTMLInputElement, errorMessage: (err: unknown) => string,
 *   jumpTo: (hit: object) => Promise<boolean>,
 * }} deps
 */
export function createHistoryActions({ api, getState, dispatch, searchField, errorMessage, jumpTo }) {
  let toastKey = 0
  let searchTimer = 0

  /** `action` ({ label, kind, payload }) adds a button; the app decides what each kind does. */
  function showToast(text, { action = null, ms = TOAST_MS } = {}) {
    const key = ++toastKey
    dispatch({ type: 'toast_show', toast: { key, text, action } })
    setTimeout(() => dispatch({ type: 'toast_hide', key }), ms)
  }
  const report = (what) => (err) => showToast(`${what}：${errorMessage(err)}`)

  /** Searching finds messages anywhere in the one timeline (history-db.js searchMessages). */
  async function runSearch(query) {
    try {
      dispatch({ type: 'history_results', query, results: await api.searchTimeline(query.trim()) })
    } catch (err) {
      report('搜索失败')(err)
    }
  }

  /** Reads the restored messages' trace from dsh's logs, in the background. */
  async function loadTrace(conversationId) {
    try {
      dispatch({ type: 'trace_restored', conversationId, ...await api.loadTrace(conversationId, Date.now()) })
    } catch (err) {
      console.error('[history] could not read the trace from dsh logs:', errorMessage(err))
      dispatch({ type: 'trace_restored', conversationId, available: false, trace: null })
    }
  }

  function focusField() {
    searchField.focus()
    searchField.select()
  }

  return {
    showToast,
    loadTrace,
    /** After a save: an open search sees what was just said. */
    refreshIfOpen() {
      const { open, query } = getState().history
      if (open && query.trim()) runSearch(query)
    },

    toggleHistory() {
      const opening = !getState().history.open
      dispatch({ type: 'history_toggle' })
      if (opening) focusField()
    },
    closeHistory: () => dispatch({ type: 'history_close' }),
    /** ⌘F / Ctrl+F: the panel stays open, its field takes the words. */
    openSearch() {
      if (!getState().history.open) dispatch({ type: 'history_open' })
      focusField()
    },
    async jumpToHit(hit) {
      dispatch({ type: 'history_close' })
      try {
        if (!await jumpTo(hit)) showToast('这条消息已经不在时间线上了')
      } catch (err) {
        report('跳转失败')(err)
      }
    },

    searchHistory(query) {
      dispatch({ type: 'history_query', query })
      clearTimeout(searchTimer)
      if (query.trim()) searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS)
    },
  }
}
