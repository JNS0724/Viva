import { formatListTime, workspaceName } from '../selectors.ts'
import { h, label } from './dom.ts'
import { focusView, patchReader, reviewView } from './review.ts'

/** The words found, with a little of what is around them. */
type Snippet = { before: string, hit: string, after: string }
/** A message beside the one found. */
type Nearby = { role: string, text: string } | null | undefined

function snippetView(snippet: Snippet | null | undefined) {
  if (!snippet?.hit) return null
  return h('span', { class: 'history-snippet' }, snippet.before, h('mark', { text: snippet.hit }), snippet.after)
}

const SPEAKERS: Readonly<Record<string, string>> = { user: '你', assistant: 'Viva' }

/** The message said right before or after the hit, dimmed, so the hit reads in its place. */
const contextLine = (message: Nearby) => (message
  ? h('span', { class: 'hit-context' }, h('span', { class: 'hit-who mono', text: SPEAKERS[message.role] ?? '' }), message.text)
  : null)

/**
 * One message that has the words, between what was said before and after it; 详情 scrolls the timeline to it when
 * it is on screen, else reads it here where it is kept (review-actions.ts openRef).
 */
function hitView(hit: SearchHit, handlers: Handlers, now: number) {
  const who = SPEAKERS[hit.role] ?? '记录'
  const where = [formatListTime(hit.at, now), hit.cwd ? workspaceName(hit.cwd) : null].filter(Boolean).join(' · ')
  return h('li', { class: 'search-hit' },
    h('div', { class: 'hit-body' },
      h('span', { class: 'history-meta mono' }, h('b', { class: 'history-title', text: who }), where),
      h('div', { class: 'hit-lines' }, contextLine(hit.before), snippetView(hit.snippet), contextLine(hit.after))),
    h('button', {
      class: 'btn btn-outline btn-small hit-open', type: 'button', text: '详情 →', 'aria-label': `在对话里看${who}说的这句`,
      onClick: () => handlers.jumpToHit(hit),
    }))
}

const empty = (text: string) => h('div', { class: 'empty', text })

function searchView(state: State, handlers: Handlers, now: number): View[] {
  const { query, results } = state.history
  // Nothing typed: 回顾, the timeline by day (view/review.ts).
  if (!query.trim()) return reviewView(state, handlers, now)
  // A hit opened (详情): read at the top, the results kept below it.
  const focus = focusView(state, handlers, now)
  if (results === null) return [focus, h('div', { class: 'history-hint', text: '搜索中…' })]
  if (results.length === 0) return [focus, empty(`没有找到「${query.trim()}」`)]
  return [
    focus,
    label(`${results.length} 条消息`),
    h('ul', { class: 'history-items' }, results.map((hit: SearchHit) => hitView(hit, handlers, now))),
  ]
}

/**
 * The 回顾 page (view/hub.js): search across the one timeline, or with nothing typed, the timeline by day. Only
 * the results re-render; the field is static markup so typing is never interrupted.
 */
export function renderHistoryPanel(dom: { historyList: HTMLElement }, state: State, handlers: Handlers, now = Date.now()) {
  if (!state.history.open) return
  const before = drawn
  drawn = { history: state.history, review: state.review }
  // Only the part read changed (read on at an end, or the stars of what is shown): the reader takes it in place.
  if (before && before.history === state.history && onlyReadingChanged(before.review, state.review) && patchReader(dom.historyList, state, handlers)) return
  // replaceChildren would turn a null into the text "null", unlike h()
  dom.historyList.replaceChildren(...searchView(state, handlers, now).filter((view): view is Node | string => Boolean(view)))
}

/** What the page was last drawn from. */
let drawn: { history: State['history'], review: State['review'] } | null = null
/** What changes as a long topic is read on, without anything else on the page changing (view/review.ts patchReader). */
const READING_ONLY = new Set(['reading', 'starKeys'])
const onlyReadingChanged = (before: State['review'], after: State['review']) =>
  (Object.keys(after) as Array<keyof State['review']>).every((key) => READING_ONLY.has(key) || before[key] === after[key])

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
