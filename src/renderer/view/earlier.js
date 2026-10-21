import { earlierRows, workspaceName } from '../selectors.js'
import { h } from './dom.js'
import { markMessage, pastMessageView } from './thread.js'

/**
 * The earlier part of the one timeline, above the conversation on screen: a line for each day, a line where
 * the working directory changed, and the messages, read-only. More comes in when the user scrolls up to the
 * top, or asks for it with the button there.
 */
function workdirLine(cwd) {
  return h('div', { class: 'timeline-workdir', role: 'separator', title: cwd },
    h('span', { class: 'timeline-workdir-ico', 'aria-hidden': 'true', text: '📁' }),
    h('span', { text: '工作目录换成 ' }),
    h('b', { text: workspaceName(cwd) }),
    h('span', { class: 'timeline-workdir-path mono', text: cwd }))
}

const ROW_VIEWS = {
  day: (row) => h('div', { class: 'timeline-day', role: 'separator', text: row.label }),
  workdir: (row) => workdirLine(row.cwd),
  message: (row, handlers) => markMessage(pastMessageView(row, handlers), row.id),
}

/**
 * @param {HTMLElement} container
 * @param {object} state the renderer state (its `earlier` slice and the current directory)
 * @param {{ loadEarlier: () => void }} handlers
 */
export function renderEarlier(container, state, handlers, now = Date.now()) {
  const { earlier } = state
  const rows = earlierRows(earlier, { currentCwd: state.info.cwd || null, now })
  const more = earlier.hasMore && earlier.segments.length > 0
    ? h('button', { class: 'timeline-more', type: 'button', disabled: earlier.loading, text: earlier.loading ? '正在读取…' : '更早的对话', onClick: () => handlers.loadEarlier() })
    : null
  container.hidden = rows.length === 0
  container.replaceChildren(...[more, ...rows.flatMap((row) => ROW_VIEWS[row.kind](row, handlers))].filter(Boolean))
}
