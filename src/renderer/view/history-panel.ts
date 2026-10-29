import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { formatListTime, workspaceName } from '../selectors.ts'
import { h, label } from './dom.ts'

/** The words found, with a little of what is around them. */
type Snippet = { before: string, hit: string, after: string }
/** A message beside the one found. */
type Nearby = { role: string, text: string } | null | undefined

function snippetView(snippet: Snippet | null | undefined) {
  if (!snippet?.hit) return null
  return h('span', { class: 'history-snippet' }, snippet.before, h('mark', { text: snippet.hit }), snippet.after)
}

let SPEAKERS: Readonly<Record<string, string>> = { user: t("history-panel.you"), assistant: 'Viva' }

/** The message said right before or after the hit, dimmed, so the hit reads in its place. */
const contextLine = (message: Nearby) => (message
  ? h('span', { class: 'hit-context' }, h('span', { class: 'hit-who mono', text: SPEAKERS[message.role] ?? '' }), message.text)
  : null)

/**
 * One message that has the words, between what was said before and after it;
 * 详情 closes the page and scrolls the timeline to it (timeline-search.js).
 */
function hitView(hit: SearchHit, handlers: Handlers, now: number) {
  const who = SPEAKERS[hit.role] ?? t("history-panel.record")
  const where = [formatListTime(hit.at, now), hit.cwd ? workspaceName(hit.cwd) : null].filter(Boolean).join(' · ')
  return h('li', { class: 'search-hit' },
    h('div', { class: 'hit-body' },
      h('span', { class: 'history-meta mono' }, h('b', { class: 'history-title', text: who }), where),
      h('div', { class: 'hit-lines' }, contextLine(hit.before), snippetView(hit.snippet), contextLine(hit.after))),
    h('button', {
      class: 'btn btn-outline btn-small hit-open', type: 'button', text: t("history-panel.details"), 'aria-label': t("history-panel.view.this.message.from.in.the.conversation", { who: who }),
      onClick: () => handlers.jumpToHit(hit),
    }))
}

const empty = (text: string) => h('div', { class: 'empty', text })

function searchView(state: State, handlers: Handlers, now: number): View[] {
  const { query, results } = state.history
  if (!query.trim()) return [h('div', { class: 'history-hint', text: t("history-panel.type.a.few.words.to.find.earlier") })]
  if (results === null) return [h('div', { class: 'history-hint', text: t("history-panel.searching") })]
  if (results.length === 0) return [empty(t("history-panel.no.results.for", { value1: query.trim() }))]
  return [
    label(t("history-panel.messages", { length: results.length })),
    h('ul', { class: 'history-items' }, results.map((hit: SearchHit) => hitView(hit, handlers, now))),
  ]
}

/** The 搜索 page (view/hub.js): search across the one timeline. Only the results re-render; the field is static markup so typing is never interrupted. */
export function renderHistoryPanel(dom: { historyList: HTMLElement }, state: State, handlers: Handlers, now = Date.now()) {
  if (!state.history.open) return
  // replaceChildren would turn a null into the text "null", unlike h()
  dom.historyList.replaceChildren(...searchView(state, handlers, now).filter((view): view is Node | string => Boolean(view)))
}

/** Bottom toast, e.g. "已删除这条记忆 · 撤销". */
export function renderToast(container: HTMLElement, toast: { text: string, action?: ToastAction | null } | null, handlers: Handlers) {
  if (!toast) {
    container.replaceChildren()
    return
  }
  container.replaceChildren(h('div', { class: 'toast', role: 'status' },
    h('span', { text: toast.text }),
    toast.action ? h('button', { class: 'toast-action', type: 'button', text: toast.action.label, onClick: () => handlers.toastAction(toast) }) : null))
}

onLocaleChange(() => {
  SPEAKERS = { user: t("history-panel.you"), assistant: 'Viva' }
})
