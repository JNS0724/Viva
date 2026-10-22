import { formatListTime, workspaceName } from '../selectors.js'
import { h, label } from './dom.js'

function snippetView(snippet) {
  if (!snippet?.hit) return null
  return h('span', { class: 'history-snippet' }, snippet.before, h('mark', { text: snippet.hit }), snippet.after)
}

const SPEAKERS = { user: '你', assistant: 'Viva' }

/** The message said right before or after the hit, dimmed, so the hit reads in its place. */
const contextLine = (message) => (message
  ? h('span', { class: 'hit-context' }, h('span', { class: 'hit-who mono', text: SPEAKERS[message.role] ?? '' }), message.text)
  : null)

/**
 * One message that has the words, between what was said before and after it;
 * 详情 closes the page and scrolls the timeline to it (timeline-search.js).
 */
function hitView(hit, handlers, now) {
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

const empty = (text) => h('div', { class: 'empty', text })

function searchView(state, handlers, now) {
  const { query, results } = state.history
  if (!query.trim()) return [h('div', { class: 'history-hint', text: '输入几个字，找回之前说过的话' })]
  if (results === null) return [h('div', { class: 'history-hint', text: '搜索中…' })]
  if (results.length === 0) return [empty(`没有找到「${query.trim()}」`)]
  return [
    label(`${results.length} 条消息`),
    h('ul', { class: 'history-items' }, results.map((hit) => hitView(hit, handlers, now))),
  ]
}

/** The 搜索 page (view/hub.js): search across the one timeline. Only the results re-render; the field is static markup so typing is never interrupted. */
export function renderHistoryPanel(dom, state, handlers, now = Date.now()) {
  if (!state.history.open) return
  // replaceChildren would turn a null into the text "null", unlike h()
  dom.historyList.replaceChildren(...searchView(state, handlers, now).filter(Boolean))
}

/** Bottom toast, e.g. "已删除这条记忆 · 撤销". */
export function renderToast(container, toast, handlers) {
  if (!toast) {
    container.replaceChildren()
    return
  }
  container.replaceChildren(h('div', { class: 'toast', role: 'status' },
    h('span', { text: toast.text }),
    toast.action ? h('button', { class: 'toast-action', type: 'button', text: toast.action.label, onClick: () => handlers.toastAction(toast) }) : null))
}
