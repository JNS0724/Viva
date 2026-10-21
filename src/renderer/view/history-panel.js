import { formatListTime, historyGroups, workspaceName } from '../selectors.js'
import { h, label } from './dom.js'
import { icon } from './icons.js'

function itemMenu(item, handlers) {
  const entry = (text, onClick, extra = {}) => h('button', { class: 'history-menu-item', type: 'button', role: 'menuitem', text, onClick, ...extra })
  return h('div', { class: 'history-menu', role: 'menu' },
    entry('重命名', () => handlers.startRename(item.id)),
    entry(item.pinned ? '取消置顶' : '置顶', () => handlers.togglePin(item)),
    entry('导出 Markdown', () => handlers.exportConversation(item.id)),
    entry('删除', () => handlers.deleteConversation(item), { class: 'history-menu-item danger' }))
}

/** Inline title editor: Enter or leaving the field saves, Escape cancels. */
function renameField(item, handlers) {
  let finished = false
  const finish = (value) => {
    if (finished) return
    finished = true
    handlers.finishRename(item.id, value)
  }
  const input = h('input', {
    class: 'history-rename', value: item.title, maxlength: 80, 'aria-label': '新标题',
    onKeydown: (event) => {
      if (event.key === 'Enter') finish(input.value)
      if (event.key !== 'Escape') return
      event.stopPropagation()
      finish(null)
    },
    onBlur: () => finish(input.value),
  })
  return input
}

function snippetView(snippet) {
  if (!snippet?.hit) return null
  return h('span', { class: 'history-snippet' }, snippet.before, h('mark', { text: snippet.hit }), snippet.after)
}

function itemView(item, state, handlers, now) {
  const isActive = item.id === state.conversationId
  const isRenaming = state.history.renaming === item.id
  return h('li', { class: 'history-item', 'data-active': String(isActive) },
    isRenaming
      ? renameField(item, handlers)
      : h('button', { class: 'history-open', type: 'button', onClick: () => handlers.openConversation(item.id) },
        h('span', { class: 'history-title', text: item.title || '未命名对话' }),
        snippetView(item.snippet),
        h('span', { class: 'history-meta mono', text: [formatListTime(item.updatedAt, now), item.model].filter(Boolean).join(' · ') })),
    isRenaming ? null : h('button', {
      class: 'icon-btn history-more',
      type: 'button',
      'aria-label': `更多操作：${item.title}`,
      'aria-expanded': String(state.history.menuFor === item.id),
      onClick: (event) => {
        event.stopPropagation()
        handlers.toggleHistoryMenu(item.id)
      },
    }, icon('more', 16)),
    state.history.menuFor === item.id ? itemMenu(item, handlers) : null)
}

const empty = (text) => h('div', { class: 'empty', text })

function browseView(state, handlers, now) {
  const { items, hasMore } = state.history
  if (items.length === 0) return [empty('还没有历史对话。每段对话都会自动保存在这里。')]
  return [
    ...historyGroups(items, now).map((group) => h('section', { class: 'history-group' },
      label(group.label),
      h('ul', { class: 'history-items' }, group.items.map((item) => itemView(item, state, handlers, now))))),
    hasMore ? h('button', { class: 'history-more-btn', type: 'button', text: '加载更早的对话', onClick: handlers.loadMoreHistory }) : null,
  ]
}

const SPEAKERS = { user: '你', assistant: 'Viva' }

/** One message that has the words; picking it scrolls the timeline to it (timeline-search.js). */
function hitView(hit, handlers, now) {
  return h('li', { class: 'history-item search-hit' },
    h('button', { class: 'history-open', type: 'button', onClick: () => handlers.jumpToHit(hit) },
      h('span', { class: 'history-title', text: SPEAKERS[hit.role] ?? '记录' }),
      snippetView(hit.snippet),
      h('span', { class: 'history-meta mono', text: [formatListTime(hit.at, now), hit.cwd ? workspaceName(hit.cwd) : null].filter(Boolean).join(' · ') })))
}

function searchView(state, handlers, now) {
  const { query, results } = state.history
  if (results === null) return [h('div', { class: 'history-hint', text: '搜索中…' })]
  if (results.length === 0) return [empty(`没有找到「${query.trim()}」`)]
  return [
    label(`${results.length} 条消息`),
    h('ul', { class: 'history-items' }, results.map((hit) => hitView(hit, handlers, now))),
  ]
}

/** Left overlay panel. Only the list re-renders; the search field is static markup so typing is never interrupted. */
export function renderHistoryPanel(dom, state, handlers, now = Date.now()) {
  dom.historyPanel.dataset.open = String(state.history.open)
  dom.toggleHistory.setAttribute('aria-pressed', String(state.history.open))
  if (!state.history.open) return
  const searching = state.history.query.trim() !== ''
  // replaceChildren would turn a null into the text "null", unlike h()
  dom.historyList.replaceChildren(...(searching ? searchView(state, handlers, now) : browseView(state, handlers, now)).filter(Boolean))
  const renaming = dom.historyList.querySelector('.history-rename')
  renaming?.focus()
  renaming?.select()
}

/** Bottom toast, e.g. "已删除「周报」 · 撤销". */
export function renderToast(container, toast, handlers) {
  if (!toast) {
    container.replaceChildren()
    return
  }
  container.replaceChildren(h('div', { class: 'toast', role: 'status' },
    h('span', { text: toast.text }),
    toast.undoId ? h('button', { class: 'toast-action', type: 'button', text: '撤销', onClick: () => handlers.undoDelete(toast) }) : null,
    toast.action ? h('button', { class: 'toast-action', type: 'button', text: toast.action.label, onClick: () => handlers.toastAction(toast) }) : null))
}
