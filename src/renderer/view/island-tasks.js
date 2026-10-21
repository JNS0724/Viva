import { h } from './dom.js'

/**
 * Tasks in the background on the island (island-view.js background): the island stays one, with the
 * conversation on screen in front. At its tail, a cell says how many go on in the background, a dot each
 * (three at most); opened, it lists them, those that wait on the user first, to be allowed right there.
 */
const MAX_DOTS = 3
/** Forms in which the conversation on screen is quiet, so the cell has room to say what the number is. */
const QUIET = new Set(['idle', 'done'])

/** @returns {Node | null} the cell at the island's tail, or nothing with no task going on */
export function tailCell(view) {
  const count = view.background?.count ?? 0
  if (!count) return null
  const dots = view.form === 'waiting' ? [] : Array.from({ length: Math.min(count, MAX_DOTS) }, () => h('i'))
  return h('span', { class: 'isl-bg', title: `${count} 件在后台` },
    h('b', { text: String(count) }),
    QUIET.has(view.form) ? h('span', { text: '在后台' }) : null,
    dots.length ? h('span', { class: 'isl-dots', 'aria-hidden': 'true' }, dots) : null)
}

/** Whose request it is, when a task in the background asks. */
export const taskTag = (view) => (view.task ? h('span', { class: 'isl-task', text: `#${view.task}` }) : null)

function itemLine(item, act) {
  const asks = item.permission
  const now = asks ? `想${asks.title}` : item.status === 'waiting' ? '在等你回答，打开窗口看看' : item.now ? `在${item.now}` : '在做'
  return h('li', { class: 'isl-bg-item', 'data-status': item.status },
    // The line opens what the task did, in the drawer.
    h('button', { type: 'button', class: 'isl-bg-mid', title: '查看过程', onClick: () => act({ kind: 'task', taskId: item.id }) },
      h('b', { text: `#${item.title}` }),
      h('span', { text: now })),
    ...(asks ? asks.options.map((option) => h('button', {
      type: 'button',
      class: `isl-mini ${option.role === 'primary' ? 'isl-mini-primary' : ''}`,
      text: option.name,
      onClick: () => act({ kind: 'permission', requestId: asks.requestId, optionId: option.optionId }),
    })) : []))
}

/** Opened: a section under the conversation's steps, one line a task. */
export function backgroundSection(view, act) {
  const items = view.background?.items ?? []
  if (!items.length) return null
  return h('section', { class: 'isl-bg-list', 'aria-label': '后台' },
    h('div', { class: 'isl-sect' }, h('span', { text: '后台 ' }), h('b', { text: String(items.length) })),
    h('ol', {}, items.map((item) => itemLine(item, act))))
}
