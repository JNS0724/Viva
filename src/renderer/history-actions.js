import { isBusy } from './state.js'

const SEARCH_DEBOUNCE_MS = 200
const TOAST_MS = 3000
/** Matches the main process: a deleted conversation is purged for good once this toast is gone. */
const UNDO_TOAST_MS = 8000

const fileName = (file) => String(file).split(/[\\/]/).pop()

/**
 * Everything the history panel does: list, search, open, rename, pin, export, delete with undo.
 * @param {{
 *   api: typeof window.agent, getState: () => object, dispatch: (action: object) => void,
 *   searchField: HTMLInputElement, errorMessage: (err: unknown) => string,
 *   newSession: () => Promise<void>, onOpened: () => void,
 * }} deps
 */
export function createHistoryActions({ api, getState, dispatch, searchField, errorMessage, newSession, onOpened }) {
  let toastKey = 0
  let searchTimer = 0

  /** `action` ({ label, kind, payload }) adds a button; the app decides what each kind does. */
  function showToast(text, { undoId = null, action = null, ms = TOAST_MS } = {}) {
    const key = ++toastKey
    dispatch({ type: 'toast_show', toast: { key, text, undoId, action } })
    setTimeout(() => dispatch({ type: 'toast_hide', key }), ms)
  }
  const report = (what) => (err) => showToast(`${what}：${errorMessage(err)}`)
  const findItem = (id) => [...getState().history.items, ...(getState().history.results ?? [])].find((item) => item.id === id)
  const closeMenu = () => dispatch({ type: 'history_menu', id: null })

  async function runSearch(query) {
    try {
      dispatch({ type: 'history_results', query, results: await api.searchHistory(query.trim()) })
    } catch (err) {
      report('搜索失败')(err)
    }
  }

  async function refresh() {
    try {
      dispatch({ type: 'history_listed', ...await api.listHistory(0), append: false })
    } catch (err) {
      report('读取历史失败')(err)
    }
    const { query } = getState().history
    if (query.trim()) await runSearch(query)
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

  return {
    showToast,
    loadTrace,
    /** After a save: keep an open panel in step with the conversation on screen. */
    refreshIfOpen: () => (getState().history.open ? refresh() : undefined),

    toggleHistory() {
      const opening = !getState().history.open
      dispatch({ type: 'history_toggle' })
      if (!opening) return
      refresh()
      searchField.focus()
      searchField.select()
    },
    closeHistory: () => dispatch({ type: 'history_close' }),

    searchHistory(query) {
      dispatch({ type: 'history_query', query })
      clearTimeout(searchTimer)
      if (query.trim()) searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS)
    },

    async loadMoreHistory() {
      try {
        dispatch({ type: 'history_listed', ...await api.listHistory(getState().history.items.length), append: true })
      } catch (err) {
        report('读取历史失败')(err)
      }
    },

    async openConversation(id) {
      const state = getState()
      if (isBusy(state)) return showToast('先停止当前任务，再切换对话')
      if (id === state.conversationId) return dispatch({ type: 'history_close' })
      if (state.switching) return undefined
      dispatch({ type: 'session_switching' })
      try {
        const { conversation, info } = await api.openConversation(id)
        dispatch({ type: 'conversation_opened', conversation, info })
        onOpened()
        loadTrace(conversation.id)
      } catch (err) {
        dispatch({ type: 'session_switch_failed' })
        report('打开失败')(err)
      }
    },

    toggleHistoryMenu: (id) => dispatch({ type: 'history_menu', id: getState().history.menuFor === id ? null : id }),
    startRename: (id) => dispatch({ type: 'history_rename_start', id }),

    async finishRename(id, value) {
      const title = value?.trim()
      if (!title || title === findItem(id)?.title) return dispatch({ type: 'history_rename_end' })
      try {
        await api.renameConversation(id, title)
        dispatch({ type: 'history_item_changed', id, changes: { title } })
      } catch (err) {
        dispatch({ type: 'history_rename_end' })
        report('重命名失败')(err)
      }
    },

    async togglePin(item) {
      closeMenu()
      try {
        await api.pinConversation(item.id, !item.pinned)
        await refresh()
      } catch (err) {
        report('置顶失败')(err)
      }
    },

    async exportConversation(id) {
      closeMenu()
      try {
        const result = await api.exportConversation(id)
        if (result.saved) showToast(`已导出：${fileName(result.file)}`)
      } catch (err) {
        report('导出失败')(err)
      }
    },

    async deleteConversation(item) {
      try {
        await api.deleteConversation(item.id)
        dispatch({ type: 'history_item_removed', id: item.id })
        showToast(`已删除「${item.title}」`, { undoId: item.id, ms: UNDO_TOAST_MS })
        if (item.id === getState().conversationId) await newSession()
      } catch (err) {
        report('删除失败')(err)
      }
    },

    async undoDelete(toast) {
      try {
        await api.restoreConversation(toast.undoId)
        dispatch({ type: 'toast_hide', key: toast.key })
        await refresh()
      } catch (err) {
        report('撤销失败（可能已超过 8 秒）')(err)
      }
    },
  }
}
