import { contextShare, NEAR_FULL, topicCount } from '../topics.js'
import { h } from './dom.js'

/** The page's Content-Security-Policy refuses style attributes; set through the DOM, the width is allowed. */
function barFill(percent) {
  const fill = h('i')
  fill.style.width = `${percent}%`
  return fill
}

const NEW_TOPIC_KEY = () => (document.documentElement.dataset.platform === 'darwin' ? '⌘N' : 'Ctrl+N')

/**
 * By the input: what the assistant has in mind now, 本话题 · N 条 and how much of its context that takes;
 * near full it says so and suggests a new topic. A click opens its menu: what that means, and 开新话题.
 * @param {HTMLElement} area #ctx-area
 * @param {object} state
 * @param {{ toggleTopicMenu: () => void, newSession: () => void }} handlers
 * @param {{ ready: boolean, busy: boolean }} options ready: connected to an agent; busy: a turn runs
 */
export function renderTopicLabel(area, state, handlers, { ready, busy }) {
  area.hidden = !ready
  if (!ready) return area.replaceChildren()
  const count = topicCount(state)
  const share = contextShare(state.usage)
  const percent = share === null ? null : Math.round(share * 100)
  const full = share !== null && share >= NEAR_FULL
  const chip = h('button', {
    class: 'chip ctx-chip', type: 'button', 'data-tone': full ? 'full' : null, 'aria-haspopup': 'menu', 'aria-expanded': String(state.topic.menu),
    title: '助手现在记得的内容', onClick: () => handlers.toggleTopicMenu(),
  },
  h('span', { text: full ? '快满了 · 开个新话题？' : `本话题 · ${count} 条` }),
  percent === null ? null : h('span', { class: 'ctx-bar', 'aria-hidden': 'true' }, barFill(percent)),
  percent === null ? null : h('span', { class: 'ctx-pct', text: `${percent}%` }))
  return area.replaceChildren(...[chip, state.topic.menu ? topicMenu(count, percent, handlers, busy) : null].filter(Boolean))
}

function topicMenu(count, percent, handlers, busy) {
  const used = percent === null ? '还没算出用了多少' : `已用 ${percent}%`
  return h('div', { class: 'ctx-menu', role: 'menu' },
    h('div', { class: 'ctx-menu-info' },
      h('b', { text: count ? `助手现在记得本话题的 ${count} 条` : '新话题：助手还什么都不记得' }),
      h('span', { text: `${used}；满了以后，最早的部分会被自动压缩。关于你的记忆不占这里。` })),
    h('button', {
      class: 'ctx-item', type: 'button', role: 'menuitem', disabled: busy, title: busy ? '先停止当前任务' : null,
      onClick: () => handlers.newSession(),
    }, h('span', { text: '开新话题' }), h('kbd', { text: NEW_TOPIC_KEY() })),
    h('button', { class: 'ctx-item', type: 'button', role: 'menuitem', disabled: true },
      h('span', { text: '压缩成要点再接着聊' }), h('small', { text: '以后做' })))
}
