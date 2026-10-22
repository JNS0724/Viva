const SEARCH_DEBOUNCE_MS = 200
const TOAST_MS = 3000

/** The 搜索 page (⌘F; view/hub.js), the toasts, and the trace of a restored conversation. */
export function createHistoryActions({ api, getState, dispatch, searchField, errorMessage, jumpTo }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'> & {
  searchField: HTMLInputElement, jumpTo: (hit: SearchHit) => Promise<boolean>,
}) {
  let toastKey = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  /** `action` ({ label, kind, payload }) adds a button; the app decides what each kind does. */
  function showToast(text: string, { action = null as ToastAction | null, ms = TOAST_MS } = {}) {
    const key = ++toastKey
    dispatch({ type: 'toast_show', toast: { key, text, action } })
    setTimeout(() => dispatch({ type: 'toast_hide', key }), ms)
  }
  const report = (what: string) => (err: unknown) => showToast(`${what}：${errorMessage(err)}`)

  /** Searching finds messages anywhere in the one timeline (history-db.js searchMessages). */
  async function runSearch(query: string) {
    try {
      dispatch({ type: 'history_results', query, results: await api.searchTimeline(query.trim()) })
    } catch (err) {
      report('搜索失败')(err)
    }
  }

  /** Reads the restored messages' trace from dsh's logs, in the background. */
  async function loadTrace(conversationId: string) {
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
    /** ⌘F / Ctrl+F: the 搜索 page, its field taking the words; what was typed before is still there. */
    openSearch() {
      if (!getState().history.open) dispatch({ type: 'history_open' })
      focusField()
    },
    async jumpToHit(hit: SearchHit) {
      dispatch({ type: 'history_close' })
      try {
        if (!await jumpTo(hit)) showToast('这条消息已经不在时间线上了')
      } catch (err) {
        report('跳转失败')(err)
      }
    },

    searchHistory(query: string) {
      dispatch({ type: 'history_query', query })
      clearTimeout(searchTimer)
      if (query.trim()) searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS)
    },
  }
}
