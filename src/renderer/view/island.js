import { catMood, statusView, traceItems } from '../selectors.js'
import { catFor } from './cat.js'
import { h, label } from './dom.js'
import { icon } from './icons.js'

const POPOVER_ROWS = 5

const ISLAND_CAT_PX = 34
const islandCats = new Map()

/** The cat at the capsule's start, its ears over the top edge; its mood says what the agent is doing. */
const islandCat = (state) => h('span', { class: 'cat-chip' }, catFor(islandCats, 'island', catMood(state), { size: ISLAND_CAT_PX }))

function popover(state, handlers) {
  const rows = traceItems(state).slice(-POPOVER_ROWS)
  return h('div', { class: 'island-pop', role: 'dialog', 'aria-label': '最近事件' },
    label('RECENT EVENTS'),
    rows.length
      ? rows.map((row) => h('div', { class: 'pop-row' },
        h('span', { class: 'dot', 'data-tone': row.tone }),
        h('span', { class: 'mono muted', text: row.time }),
        h('span', { class: 'ellipsis', text: row.title })))
      : h('div', { class: 'muted', text: '还没有事件' }),
    h('button', { class: 'btn btn-outline', text: '查看完整过程 →', onClick: () => handlers.openDrawer('trace') }))
}

/** Status capsule centred in the title bar; click to peek at the last few events. */
export function renderIsland(container, state, handlers, now) {
  const status = statusView(state, now)
  const button = h('button', {
    class: 'island',
    'data-tone': status.tone,
    'aria-label': `助手状态：${status.label}，点击查看最近事件`,
    'aria-expanded': String(state.island),
    onClick: (event) => {
      event.stopPropagation()
      handlers.toggleIsland()
    },
  },
  islandCat(state),
  h('span', { class: 'island-label', text: status.label }),
  status.event ? h('span', { class: 'island-event', text: status.event }) : null,
  icon('chevron', 14))
  container.replaceChildren(button, ...(state.island ? [popover(state, handlers)] : []))
}
