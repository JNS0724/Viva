import { t } from '../shared/i18n/translate.ts'
import type { VerifiedMessage } from './timeline-search.ts'

const SEARCH_DEBOUNCE_MS = 200
const TOAST_MS = 3000

/** The 搜索 page (⌘F; view/hub.js), the toasts, and the trace of a restored conversation. */
export function createHistoryActions({ api, getState, dispatch, searchField, errorMessage, locate, revealOnScreen, openInReview }: Pick<ActionDeps, 'api' | 'getState' | 'dispatch' | 'errorMessage'> & {
  searchField: HTMLInputElement,
  /** Where the message named is now (history-db.ts locate). */
  locate: (hit: SearchHit) => Promise<{ status: string, segmentId: string, seq?: number | null, messageId?: number }>,
  /** When a message the history found is on screen in the timeline (timeline-search.ts hitTarget): what scrolls to it. */
  revealOnScreen: (found: VerifiedMessage) => (() => void) | null,
  /** Reads the message in 回顾 where it is kept (review-actions.ts openRef). */
  openInReview: (hit: SearchHit) => Promise<void>,
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

  /**
   * What scrolls to the message on screen, only once the history has found that very message where it is now (by
   * its id): a place alone may hold another message by now. Anything else (missing, deleted, not on screen, the
   * history not answering) is left to 回顾, which says which it is.
   */
  async function onScreen(hit: SearchHit) {
    try {
      const located = await locate(hit)
      if (located.status !== 'found' || typeof located.seq !== 'number' || typeof located.messageId !== 'number') return null
      return revealOnScreen({ segmentId: located.segmentId, seq: located.seq, messageId: located.messageId })
    } catch {
      return null
    }
  }

  /** Searching finds messages anywhere in the one timeline (history-db.js searchMessages). */
  async function runSearch(query: string) {
    try {
      dispatch({ type: 'history_results', query, results: await api.searchTimeline(query.trim()) })
    } catch (err) {
      report(t("history-actions.search.failed"))(err)
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
    /**
     * 详情 on a search hit, or a link to a message in an answer: the timeline scrolls to it when it is on screen;
     * anything else is read in 回顾 where it is kept, however far back, without reading the timeline back for it.
     */
    async jumpToHit(hit: SearchHit) {
      const reveal = await onScreen(hit)
      if (reveal) {
        dispatch({ type: 'history_close' })
        return reveal()
      }
      if (!getState().history.open) dispatch({ type: 'history_open' })
      return openInReview(hit)
    },

    searchHistory(query: string) {
      dispatch({ type: 'history_query', query })
      clearTimeout(searchTimer)
      if (query.trim()) searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS)
    },
  }
}
